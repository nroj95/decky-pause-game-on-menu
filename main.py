"""
main.py — backend of the Decky plugin "Pause Game on Menu" (Legion Go S / SteamOS gaming mode).

What it does
  The frontend (src/index.tsx) reports every change of Steam's open side menu
  (0 = none, 1 = Steam menu, 2 = "…" Quick Access menu). This backend then:
  - Pause: when "…" opens, sends the game window a synthetic X11 FocusOut, so games with
    "pause when the window is inactive" (e.g. Stardew Valley) pause themselves; when the menu
    closes, sends FocusIn to that same window. The Steam menu needs no help: it really takes
    focus away from the game, so those games already pause there.
  - Mute: while "…" or the Steam menu is open, mutes the game's own audio streams
    (PipeWire/Pulse sink-inputs whose own or client's application.process.id is a game process —
    native PipeWire streams like Stardew's only have it on the client) and unmutes exactly those again
    when the menu closes. Streams the user muted themself are left alone.

How (and why this way)
  - gamescope runs games on Xwayland display :1 (Steam is on :0). XSendEvent delivers the focus
    event straight to the game's window; it does not pass gamescope's input routing, so it can't
    reach or close the Steam menus (an injected Esc key did: "…" took it as "Back").
  - The game's processes are the descendants of Steam's launcher `reaper SteamLaunch AppId=…`.
  - Multiplayer-safe: nothing is frozen; the game keeps running (network included) and decides
    itself whether it may pause.
  - Runs as the normal user (no root flag). Decky's bundled LD_LIBRARY_PATH is removed for pactl.

Settings: <DECKY_PLUGIN_SETTINGS_DIR>/settings.json —
  {"pause_on_quick_access": bool, "mute_on_menus": bool,
   "games": {"<appid>": {"pause_on_quick_access": bool, "mute_on_menus": bool}}}
  "games" holds per-game exceptions to the two switches (only the keys that differ); a game without
  an entry follows the global switches. Setting a game's switch back to the global value removes it.
Callable from the frontend: get_settings(), set_setting(key, value),
  set_game_setting(appid, key, value), menu_changed(menu, appid)
"""
import ctypes
import json
import os
import subprocess

import decky

GAME_DISPLAY = b":1"
MENU_NONE, MENU_STEAM, MENU_QUICK_ACCESS = 0, 1, 2
DEFAULT_SETTINGS = {"pause_on_quick_access": True, "mute_on_menus": True}
SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

# --- X11 focus events (libX11 via ctypes) --------------------------------------------------------
FOCUS_IN, FOCUS_OUT = 9, 10
NOTIFY_NORMAL, NOTIFY_NONLINEAR = 0, 3      # mode/detail that SDL2 & co. treat as a real focus change
FOCUS_CHANGE_MASK = 1 << 21


class _XFocusChangeEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),
                ("mode", ctypes.c_int), ("detail", ctypes.c_int)]


class _XEvent(ctypes.Union):
    _fields_ = [("xfocus", _XFocusChangeEvent), ("pad", ctypes.c_long * 24)]


_x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
_x11.XOpenDisplay.restype = ctypes.c_void_p
_x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
_x11.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
_x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(_XEvent)]
_x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
_x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
# Xlib's default error handler exits the process (e.g. on a window that closed meanwhile): log instead.
_X_ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda _d, _e: 0)
_x11.XSetErrorHandler(_X_ERROR_HANDLER)


def _send_focus(event_type: int, window: int | None = None) -> int | None:
    """Send FocusOut/FocusIn to `window` (default: the focused window on the game display)."""
    dpy = _x11.XOpenDisplay(GAME_DISPLAY)
    if not dpy:
        decky.logger.warning("cannot open game display %s", GAME_DISPLAY.decode())
        return None
    try:
        if window is None:
            focused, revert = ctypes.c_ulong(), ctypes.c_int()
            _x11.XGetInputFocus(dpy, ctypes.byref(focused), ctypes.byref(revert))
            if focused.value <= 1:  # None / PointerRoot: no game window to tell
                return None
            window = focused.value
        event = _XEvent()
        event.xfocus.type, event.xfocus.window = event_type, window
        event.xfocus.mode, event.xfocus.detail = NOTIFY_NORMAL, NOTIFY_NONLINEAR
        _x11.XSendEvent(dpy, window, 0, FOCUS_CHANGE_MASK, ctypes.byref(event))
        _x11.XSync(dpy, 0)
        return window
    finally:
        _x11.XCloseDisplay(dpy)


# --- Game processes and their audio --------------------------------------------------------------
_PACTL_ENV = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
_PACTL_ENV.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")


def _game_pids() -> set[int]:
    """All processes started by Steam's game launcher (`reaper SteamLaunch AppId=…`)."""
    children: dict[int, list[int]] = {}
    roots: list[int] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as f:
                ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                cmdline = f.read()
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(int(entry))
        if b"\0SteamLaunch\0AppId=" in cmdline:
            roots.append(int(entry))
    pids, todo = set(), roots
    while todo:
        pid = todo.pop()
        pids.add(pid)
        todo.extend(children.get(pid, []))
    return pids


def _pactl(*args: str) -> str:
    return subprocess.run(["pactl", *args], env=_PACTL_ENV, capture_output=True, text=True,
                          timeout=3, check=True).stdout


class Plugin:
    async def _main(self):
        self.settings = {**DEFAULT_SETTINGS, "games": {}}
        try:
            with open(SETTINGS_FILE) as f:
                saved = json.load(f)
            self.settings.update({k: v for k, v in saved.items() if k in DEFAULT_SETTINGS})
            self.settings["games"] = {
                str(appid): {k: bool(v) for k, v in keys.items() if k in DEFAULT_SETTINGS}
                for appid, keys in saved.get("games", {}).items() if isinstance(keys, dict)}
        except (OSError, ValueError, AttributeError):
            pass
        self.paused_window: int | None = None   # window we sent FocusOut to
        self.muted_streams: set[int] = set()    # sink-input indexes we muted

    async def _unload(self):
        self._resume()

    async def get_settings(self) -> dict:
        return self.settings

    async def set_setting(self, key: str, value: bool):
        if key not in DEFAULT_SETTINGS:
            return
        self.settings[key] = bool(value)
        self._save()

    async def set_game_setting(self, appid: int, key: str, value: bool):
        """Per-game exception; a value equal to the global switch removes the exception."""
        if key not in DEFAULT_SETTINGS or not appid:
            return
        game = self.settings["games"].setdefault(str(appid), {})
        if bool(value) == self.settings[key]:
            game.pop(key, None)
        else:
            game[key] = bool(value)
        if not game:
            del self.settings["games"][str(appid)]
        self._save()

    def _save(self):
        os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
        with open(SETTINGS_FILE, "w") as f:
            json.dump(self.settings, f, indent=2)

    def _setting(self, key: str, appid: int) -> bool:
        """The switch for this game: its exception if it has one, else the global switch."""
        return self.settings["games"].get(str(appid), {}).get(key, self.settings[key])

    async def menu_changed(self, menu: int, appid: int = 0):
        try:
            if menu == MENU_NONE:
                self._resume()
                return
            game = _game_pids()
            if not game:
                return
            if (menu == MENU_QUICK_ACCESS and self._setting("pause_on_quick_access", appid)
                    and self.paused_window is None):
                self.paused_window = _send_focus(FOCUS_OUT)
                decky.logger.info("paused: FocusOut to window %s", self.paused_window)
            if self._setting("mute_on_menus", appid) and not self.muted_streams:
                # Native PipeWire streams carry no process id themselves; their client does.
                client_pids = {str(c["index"]): c.get("properties", {}).get("application.process.id")
                               for c in json.loads(_pactl("-f", "json", "list", "clients"))}
                for stream in json.loads(_pactl("-f", "json", "list", "sink-inputs")):
                    pid = (stream.get("properties", {}).get("application.process.id")
                           or client_pids.get(str(stream.get("client"))))
                    if pid and str(pid).isdigit() and int(pid) in game and not stream.get("mute"):
                        _pactl("set-sink-input-mute", str(stream["index"]), "1")
                        self.muted_streams.add(stream["index"])
                decky.logger.info("muted game streams %s", sorted(self.muted_streams))
        except Exception:
            decky.logger.exception("menu_changed(%s) failed", menu)

    def _resume(self):
        if self.paused_window is not None:
            _send_focus(FOCUS_IN, self.paused_window)
            decky.logger.info("resumed: FocusIn to window %s", self.paused_window)
            self.paused_window = None
        for index in self.muted_streams:
            try:
                _pactl("set-sink-input-mute", str(index), "0")
            except Exception:  # stream ended meanwhile
                pass
        if self.muted_streams:
            decky.logger.info("unmuted game streams %s", sorted(self.muted_streams))
        self.muted_streams = set()
