# Character assets

**Hito 1 status:** the app ships with *self-contained placeholder critters* drawn as
SVG in `app/src/components/Character.tsx` — zero binary assets, so the app runs and
builds anywhere. This folder is where the **real sprite-sheets** land in Hito 3.

## Target format
- One PNG **sprite-sheet per character**, horizontal frames, transparent background.
- Cell size **48×48** (or 32×32), `image-rendering: pixelated`.
- Poses/rows needed by the engine: `idle`, `walk` (2–4 frames), `jump`, `fall`, `hang`
  (holding the cursor). See `Pose` in `app/src/lib/characters.ts`.

## Where to get them (free, commercial-friendly)
Pick packs whose license allows redistribution in a downloadable app (we host the
installers on the landing page):

| Source | License | Notes |
|--------|---------|-------|
| [Kenney.nl](https://kenney.nl/assets?q=2d) | **CC0** (public domain) | Safest — no attribution required. Great tiny characters. |
| [itch.io — "free pixel character"](https://itch.io/game-assets/free/tag-characters) | varies (check each) | Many CC0 / CC-BY. Read each pack's license. |
| [OpenGameArt LPC](https://opengameart.org/) | CC-BY-SA / GPL | Attribution + share-alike — heavier obligations. |

**Rule:** prefer **CC0**. If CC-BY, add a credit line to the landing footer and to
`ATTRIBUTION.md` here. Avoid anything non-redistributable.

## Adding a new sprite-sheet
1. Drop `gato.png` (etc.) here.
2. Import it in `characters.ts` and set `sprite`/`frames`/`rows` metadata.
3. Replace the SVG `<Character>` internals with an `<img>`/`background-position`
   sprite renderer (the component API — `id/pose/size/flip/frame` — stays the same).
