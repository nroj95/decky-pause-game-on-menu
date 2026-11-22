/**
 * src/index.tsx — frontend of the Decky plugin "Pause Game on Menu".
 *
 * Runs in Steam's hidden SharedJSContext page. On load it subscribes to Steam's own
 * "which side menu is open" value and forwards every change to the Python backend (main.py),
 * which pauses (focus trick) and/or mutes the running game:
 *   SteamUIStore.WindowStore.SteamUIWindows[0].m_MenuStore.m_eOpenSideMenu
 *   0 = no menu, 1 = Steam menu, 2 = "…" Quick Access menu
 * It is a MobX observable; we use its own change hook (observe_), so there is no polling.
 * This is Steam-internal (not a Decky API): if a Steam update renames it, the plugin stops
 * reacting and its panel says so — it never guesses.
 *
 * Pause also sends the game Steam's "overlay active" signal while "…" is open:
 *   SteamClient.System.NotifyGameOverlayStateChanged(active, appid)
 * Steam calls this itself in Game Mode, but only for the Steam menu (and chat), never for "…".
 * Games that pause on the Steam overlay (e.g. Kena: Bridge of Spirits, a Proton game that ignores
 * the backend's synthetic focus event) then pause exactly as with the Steam button: no flicker, and
 * a game already in its pause menu stays paused. When "…" closes we send "inactive"; when it turns
 * into the Steam menu we leave that to Steam, which sends "active" for it and "inactive" afterwards.
 *
 * Steam's screensaver counts as "…": Steam closes "…" to show it, which used to resume and unmute
 * the game behind the screensaver. The frontend listens to the screensaver service's own
 * notification (RegisterForNotifyActiveStateChanged, found with findModuleExport) and, when a menu
 * closes, first asks GetActiveState, so the game stays paused and muted until the screensaver ends.
 * When it ends, Steam restores the menu you were in a moment later, so the game only resumes if no
 * menu is open 0.5 s after the screensaver (no split-second resume in between).
 *
 * Steam's UI covering the game also counts as "…" (e.g. Steam menu → Home/Library: the Steam menu
 * closes but the game stays hidden). We watch the same MobX value Steam uses for its own overlay
 * signal: SteamUIWindows[0].m_CompositionStateStore.m_eLatestCompositionState, 3 = Opaque.
 * Steam sets it 1 ms before it closes the menu, so the game stays muted until it is 0 again.
 *
 * Panel: two global switches, and while a game runs, the same two for that game only (e.g. no
 * pause for a multiplayer game, sound kept on for another). Per-game values start out like the
 * global ones and are stored as exceptions by Steam app id; the backend (settings.json in Decky's
 * settings folder) applies them. menu_changed gets the running app id for that.
 */
import { PanelSection, PanelSectionRow, Router, ToggleField, findModuleExport, staticClasses } from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useState } from "react";
import { FaPause } from "react-icons/fa";

type Switch = "pause_on_quick_access" | "mute_on_menus";
// the two global switches, plus per-game exceptions by Steam app id (only the switches that differ)
type Settings = Record<Switch, boolean> & { games: Record<string, Partial<Record<Switch, boolean>>> };

const getSettings = callable<[], Settings>("get_settings");
const setSetting = callable<[key: Switch, value: boolean], void>("set_setting");
const setGameSetting = callable<[appid: number, key: Switch, value: boolean], void>("set_game_setting");
const menuChanged = callable<[menu: number, appid: number], void>("menu_changed");

/** A switch for one game: its exception if it has one, else the global switch. */
function gameSetting(settings: Settings, key: Switch, appid: number): boolean {
  return settings.games?.[String(appid)]?.[key] ?? settings[key];
}

const runningAppId = () => Number(Router.MainRunningApp?.appid) || 0;

/**
 * Subscribe to a MobX value in a store of Steam's main window (SteamUIWindows[0][store][key]).
 * Returns an unsubscribe function, or null if not found.
 */
function watchSteamValue(store: string, key: string, onChange: (value: number) => void): (() => void) | null {
  try {
    const target = (window as any).SteamUIStore?.WindowStore?.SteamUIWindows?.[0]?.[store];
    const mobxAdmin = Object.getOwnPropertySymbols(target ?? {})
      .find((symbol) => symbol.description === "mobx administration");
    const observable = mobxAdmin && target[mobxAdmin]?.values_?.get(key);
    if (typeof observable?.observe_ !== "function") return null;
    return observable.observe_((change: { newValue: number }) => onChange(change.newValue));
  } catch (error) {
    console.error(`Pause Game on Menu: cannot watch Steam's ${key}`, error);
    return null;
  }
}

// Steam's composition state 3 = Opaque: its UI covers the game completely (Home, Library, Store, ...)
const COMPOSITION_OPAQUE = 3;

// Steam's screensaver service (the one its "Preview" button and screensaver page use)
const screensaver = findModuleExport(
  (e: any) => typeof e?.RegisterForNotifyActiveStateChanged === "function" && typeof e?.ForceScreensaver === "function",
);

/** Subscribe to screensaver on/off. Returns an unsubscribe function, or null if not found. */
function watchScreensaver(onChange: (active: boolean) => void): (() => void) | null {
  try {
    const registration = screensaver?.RegisterForNotifyActiveStateChanged((msg: any) => {
      onChange(Boolean(msg.Body().active()));
      return 1; // EResult OK, as Steam's own handler returns
    });
    return registration ? () => registration.unregister() : null;
  } catch (error) {
    console.error("Pause Game on Menu: cannot watch the screensaver", error);
    return null;
  }
}

async function isScreensaverActive(): Promise<boolean> {
  try {
    return Boolean((await screensaver?.GetActiveState({}))?.Body().active());
  } catch {
    return false;
  }
}

// What we last reported: the open side menu, except that an active screensaver or Steam's UI
// covering the game counts as "…". Steam closes its menus to show those; without this the game
// resumed and unmuted behind them.
let sideMenu = 0;
let screensaverActive = false;
let gameCovered = false;
let reportedMenu = 0;
let screensaverEndTimer = 0;
const SCREENSAVER_END_GRACE_MS = 500;

function report() {
  const menu = screensaverActive || gameCovered ? 2 : sideMenu;
  if (menu === reportedMenu) return;
  reportedMenu = menu;
  const appid = runningAppId();
  signalOverlay(menu, appid);
  void menuChanged(menu, appid);
}

let stopWatching: (() => void) | null = null;
let stopWatchingComposition: (() => void) | null = null;
let stopWatchingScreensaver: (() => void) | null = null;
// the settings, kept here too because the overlay signal is sent from the frontend
let currentSettings: Settings | null = null;
// app id we told "overlay active", until we tell it "inactive" again
let overlaySignalled: number | null = null;

function setGameOverlay(active: boolean, appid: number) {
  try {
    (window as any).SteamClient.System.NotifyGameOverlayStateChanged(active, appid);
  } catch (error) {
    console.error("Pause Game on Menu: cannot send the overlay signal", error);
  }
}

/** Steam's overlay signal around "…": "active" when it opens, "inactive" when it closes. */
function signalOverlay(menu: number, appid: number) {
  if (menu === 2 && overlaySignalled === null && appid
      && currentSettings && gameSetting(currentSettings, "pause_on_quick_access", appid)) {
    setGameOverlay(true, appid);
    overlaySignalled = appid;
  } else if (menu === 0 && overlaySignalled !== null) {
    setGameOverlay(false, overlaySignalled);
    overlaySignalled = null;
  } else if (menu === 1) {
    overlaySignalled = null; // the Steam menu took over; Steam sends "inactive" when it closes
  }
}

function Content() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => { void getSettings().then(setSettings); }, []);
  const app = Router.MainRunningApp;
  const appid = runningAppId();

  const update = (next: Settings) => {
    currentSettings = next;
    setSettings(next);
  };

  const toggle = (key: Switch) => (value: boolean) => {
    if (!settings) return;
    update({ ...settings, [key]: value });
    void setSetting(key, value);
  };

  // per-game exception; choosing the global value again removes it (as the backend does)
  const toggleGame = (key: Switch) => (value: boolean) => {
    if (!settings) return;
    const game = { ...settings.games[String(appid)], [key]: value };
    if (value === settings[key]) delete game[key];
    const games = { ...settings.games, [String(appid)]: game };
    if (!Object.keys(game).length) delete games[String(appid)];
    update({ ...settings, games });
    void setGameSetting(appid, key, value);
  };

  return (
    <>
      <PanelSection>
        {!stopWatching && (
          <PanelSectionRow>
            <div>Not working: this Steam version doesn't report its menus the way the plugin expects.</div>
          </PanelSectionRow>
        )}
        {settings && (
          <>
            <PanelSectionRow>
              <ToggleField
                label="Pause game while … menu is open"
                description="For games that pause on the Steam menu (like Kena) or when their window is inactive (like Stardew Valley)."
                checked={settings.pause_on_quick_access}
                onChange={toggle("pause_on_quick_access")}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="Mute game sound while … or Steam menu is open"
                checked={settings.mute_on_menus}
                onChange={toggle("mute_on_menus")}
              />
            </PanelSectionRow>
          </>
        )}
      </PanelSection>
      {settings && appid > 0 && (
        <PanelSection title={app?.display_name ?? "This game"}>
          <PanelSectionRow>
            <ToggleField
              label="Pause on … menu"
              description="Only for this game. Starts out like the switch above."
              checked={gameSetting(settings, "pause_on_quick_access", appid)}
              onChange={toggleGame("pause_on_quick_access")}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Mute in menus"
              description="Only for this game. Starts out like the switch above."
              checked={gameSetting(settings, "mute_on_menus", appid)}
              onChange={toggleGame("mute_on_menus")}
            />
          </PanelSectionRow>
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => {
  void getSettings().then((settings) => { currentSettings = settings; });
  // Steam marks the game as covered just before it closes the menu (e.g. Steam menu → Home)
  gameCovered = (window as any).SteamUIStore?.WindowStore?.SteamUIWindows?.[0]?.m_CompositionStateStore
    ?.m_eLatestCompositionState === COMPOSITION_OPAQUE;
  stopWatchingComposition = watchSteamValue("m_CompositionStateStore", "m_eLatestCompositionState", (state) => {
    gameCovered = state === COMPOSITION_OPAQUE;
    report();
  });
  stopWatching = watchSteamValue("m_MenuStore", "m_eOpenSideMenu", (menu) => {
    sideMenu = menu;
    // a menu closing may be Steam making room for the screensaver: ask before resuming the game
    if (menu === 0) void isScreensaverActive().then((active) => { screensaverActive = active; report(); });
    else report();
  });
  stopWatchingScreensaver = watchScreensaver((active) => {
    clearTimeout(screensaverEndTimer);
    if (active) {
      screensaverActive = true;
      report();
      return;
    }
    // Steam restores the menu you were in (e.g. "…") a moment after the screensaver ends; wait for
    // that instead of resuming the game for a split second in between
    screensaverEndTimer = window.setTimeout(() => {
      screensaverActive = false;
      report();
    }, SCREENSAVER_END_GRACE_MS);
  });
  return {
    name: "Pause Game on Menu",
    titleView: <div className={staticClasses.Title}>Pause Game on Menu</div>,
    content: <Content />,
    icon: <FaPause />,
    onDismount() {
      stopWatching?.();
      stopWatching = null;
      stopWatchingComposition?.();
      stopWatchingComposition = null;
      stopWatchingScreensaver?.();
      stopWatchingScreensaver = null;
      clearTimeout(screensaverEndTimer);
      if (overlaySignalled !== null) setGameOverlay(false, overlaySignalled);
      overlaySignalled = null;
    },
  };
});
