# bichito 🐾

A tiny desktop pet (32–48px) that lives in your system tray and **jumps on your
friends' cursors**. When a friend is online you can send your bichito over: it falls
from the top of *their* screen, grabs *their* real mouse cursor, and hangs on. Move
too fast and it loses its grip and walks off. Meanwhile you see a **ghost of their
cursor** on your screen — hover your own cursor over it and your bichito grips harder.
Bichitos also leap on each other at random while both of you are online.

> It never controls or hijacks the real cursor — it only *reads* its position and
> draws the sprite on top via a transparent, click-through overlay. Consensual fun
> between friends (think Shimeji), not input injection.

## Stack
- **App:** Tauri v2 · Rust (tray, overlay, native cursor) + React + Tailwind + Vite
- **Backend:** Rust WebSocket presence/relay server (Hito 2)
- **Infra:** DigitalOcean K8s + Cloudflare DNS via Pulumi (`../infra`) (Hito 4)
- **Landing:** Astro → Cloudflare Pages, hosts the installers (Hito 4)
- **Platforms:** Windows + macOS (Linux later — Wayland blocks global-cursor reads)

## Layout
```
bichito/
  app/          # Tauri desktop app (this is Hito 1)
    src/        # React + Tailwind frontend (onboarding + overlay pet)
    src-tauri/  # Rust: tray, transparent overlay, native window control
  server/       # Rust WS backend            (Hito 2)
  landing/      # Astro download page         (Hito 4)
  assets/       # icon source + character sprite-sheets
```

## Roadmap
1. **App base** ✅ — tray, onboarding (name + character), autonomous corner pet, transparent click-through overlay.
2. **Presence** — Rust WS backend, global online list, tray "friends" menu, send-pet action.
3. **Mouse-grab** — pet falls on a friend's cursor, ghost-cursor streaming, grip physics, random leaps.
4. **Infra + landing** — backend on K8s + Cloudflare DNS (Pulumi), Astro landing with signed Win/macOS installers built in GitHub Actions.

## Develop (Hito 1)
Requires **Node 18** (`nvm use 18`) and a Rust toolchain.
```bash
cd app
nvm use 18
npm install
npm run tauri dev      # runs Vite + the Tauri shell
```
First-run flow: a window asks your name + character → click ¡Empezar! → the window
hides to the tray and the pet starts strolling along the bottom of your screen.
Re-open settings from the tray icon (left-click / "Preferencias").

### Build a local macOS bundle
```bash
cd app && npm run tauri build
```
Windows installers are built in CI on a Windows runner (Hito 4).
