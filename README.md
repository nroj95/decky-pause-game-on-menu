# Pause Game on Menu

A small [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for SteamOS gaming mode
(made for a Lenovo Legion Go S, SteamOS 3.9, Decky 3.3).

- **Pause game while … menu is open** — when the "…" Quick Access menu opens, the game is told its window
  lost focus, so games that pause when their window is inactive (like Stardew Valley) pause themselves.
  When the menu closes, the game gets focus back. The Steam menu already does this on its own.
- **Mute game sound while … or Steam menu is open** — mutes only the game's own audio streams and unmutes
  exactly those when the menu closes.

Nothing is frozen: the game keeps running (multiplayer stays connected) and decides itself whether it pauses.
Games that keep running when unfocused just keep running.

How it works: `src/index.tsx` listens to Steam's own "open side menu" value (no polling) and tells
`main.py`, which sends an X11 FocusOut/FocusIn to the game window on gamescope's game display (`:1`)
and mutes/unmutes the game's PipeWire streams with `pactl`. No root needed.

## Build and install (on the device)

```sh
pnpm install --frozen-lockfile
node scripts/20261120-070601-deploy-local.ts   # builds, copies with sudo, restarts Decky
```
