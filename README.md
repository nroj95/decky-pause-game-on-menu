# Pause Game on Menu

A small [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for SteamOS gaming mode
(made for a Lenovo Legion Go S, SteamOS 3.9, Decky 3.3).

- **Pause game while … menu is open** — when the "…" Quick Access menu opens, the game gets two signals:
  Steam's own "overlay active" signal (what the Steam menu sends; games like Kena: Bridge of Spirits pause on
  it, exactly as with the Steam button) and "your window lost focus" (games that pause when inactive, like
  Stardew Valley). When the menu closes, both are taken back. Games that pause into their own pause menu stay
  there, as after the Steam menu.
- **Mute game sound while … or Steam menu is open** — mutes only the game's own audio streams and unmutes
  exactly those when the menu closes.
  If the game dies while muted (crash, kill, Exit from the Steam menu), its next start is not left muted:
  PipeWire/WirePlumber remembers the mute, so the plugin notes what it muted and undoes it when the game's sound returns.

While a game runs, the panel also shows both switches **for that game only** (e.g. no pause for a multiplayer game,
or sound kept on for one). They start out like the global switches; changed ones are saved per game.

Steam's screensaver and Steam's own pages over the game (Home, Library, Store, … opened from the Steam menu)
count as "…": the game stays paused and muted while they show, and resumes when you are back in it.

Nothing is frozen: the game keeps running (multiplayer stays connected) and decides itself whether it pauses.
Games that keep running when unfocused just keep running.

How it works: `src/index.tsx` listens to Steam's own "open side menu" value (no polling), sends
`SteamClient.System.NotifyGameOverlayStateChanged` (which Steam itself only sends for the Steam menu) and tells
`main.py`, which sends an X11 FocusOut/FocusIn to the game window on gamescope's game display (`:1`)
and mutes/unmutes the game's PipeWire streams with `pactl`. No root needed.

## Build and install (on the device)

```sh
pnpm install --frozen-lockfile
node scripts/20261120-070601-deploy-local.ts   # builds, copies with sudo, restarts Decky
```
