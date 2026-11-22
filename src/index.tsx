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
 * Panel: two switches, stored by the backend (settings.json in Decky's settings folder).
 */
import { PanelSection, PanelSectionRow, Router, ToggleField, staticClasses } from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useState } from "react";
import { FaPause } from "react-icons/fa";

type Settings = { pause_on_quick_access: boolean; mute_on_menus: boolean };

const getSettings = callable<[], Settings>("get_settings");
const setSetting = callable<[key: keyof Settings, value: boolean], void>("set_setting");
const menuChanged = callable<[menu: number], void>("menu_changed");

/** Subscribe to Steam's open-side-menu value. Returns an unsubscribe function, or null if not found. */
function watchSideMenu(onChange: (menu: number) => void): (() => void) | null {
  try {
    const menuStore = (window as any).SteamUIStore?.WindowStore?.SteamUIWindows?.[0]?.m_MenuStore;
    const mobxAdmin = Object.getOwnPropertySymbols(menuStore ?? {})
      .find((symbol) => symbol.description === "mobx administration");
    const observable = mobxAdmin && menuStore[mobxAdmin]?.values_?.get("m_eOpenSideMenu");
    if (typeof observable?.observe_ !== "function") return null;
    return observable.observe_((change: { newValue: number }) => onChange(change.newValue));
  } catch (error) {
    console.error("Pause Game on Menu: cannot watch Steam's menus", error);
    return null;
  }
}

let stopWatching: (() => void) | null = null;
// the pause switch, kept here too because the overlay signal is sent from the frontend
let pauseOnQuickAccess = false;
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
function signalOverlay(menu: number) {
  if (menu === 2 && pauseOnQuickAccess && overlaySignalled === null) {
    const appid = Number(Router.MainRunningApp?.appid);
    if (!appid) return;
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

  const toggle = (key: keyof Settings) => (value: boolean) => {
    setSettings((old) => old && { ...old, [key]: value });
    if (key === "pause_on_quick_access") pauseOnQuickAccess = value;
    void setSetting(key, value);
  };

  return (
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
  );
}

export default definePlugin(() => {
  void getSettings().then((settings) => { pauseOnQuickAccess = settings.pause_on_quick_access; });
  stopWatching = watchSideMenu((menu) => {
    signalOverlay(menu);
    void menuChanged(menu);
  });
  return {
    name: "Pause Game on Menu",
    titleView: <div className={staticClasses.Title}>Pause Game on Menu</div>,
    content: <Content />,
    icon: <FaPause />,
    onDismount() {
      stopWatching?.();
      stopWatching = null;
      if (overlaySignalled !== null) setGameOverlay(false, overlaySignalled);
      overlaySignalled = null;
    },
  };
});
