import type { ArtKind } from "./types";

// All minigame tunables live here — balancing the game means editing only this
// file. Physics is in NORMALIZED units (0..1 of the screen), seconds, unless noted.
// These used to be scattered constants inside the pet Sim; they belong to the game.
export const GAME = {
  moveSpeed: 0.36, // horizontal move speed while controlled (normalized/s)
  gravity: 1.9, // gentler than the social-world gravity -> floatier, readable jumps
  canJump: true, // flag: allow the in-combat jump (Up). Flip to false to disable later.
  jumpSprites: 0.8, // jump apex height, in sprite-heights — a small hop (px-consistent)
  idleRelease: 5, // seconds of no input before control auto-releases into rest

  // --- Hollow-Knight-style nail (melee) ---
  swingCooldown: 0.3, // seconds between normal nail swings
  artCooldown: 0.7, // longer cooldown after a charged Art
  chargeTime: 0.5, // hold Space this long to charge a Nail Art (else it's a normal swing)
  dashDist: 0.09, // Corte Veloz (Dash Slash) forward lunge (normalized x)
  pogoSprites: 1.7, // apex of the down-attack (pogo) bounce, in sprite-heights
  clashKnockback: 0.018, // normalized x shove when two nails clash (parry)
  stunMs: 260, // brief input-lock after being hit
  clashStunMs: 120, // even briefer lock after a clash (parry) — recover fast

  // per-move geometry & damage. reach/radius in sprite-fractions, damage in health,
  // knockback in normalized x, duration in seconds. radial = hits all around (cyclone).
  arts: {
    nail: { reach: 0.9, radius: 0.6, damage: 0.2, knockback: 0.02, duration: 0.16, radial: false },
    great: { reach: 1.4, radius: 0.9, damage: 0.4, knockback: 0.05, duration: 0.26, radial: false },
    cyclone: { reach: 0.0, radius: 1.25, damage: 0.34, knockback: 0.04, duration: 0.42, radial: true },
    dash: { reach: 1.2, radius: 0.78, damage: 0.3, knockback: 0.045, duration: 0.2, radial: false },
  } as Record<
    ArtKind,
    { reach: number; radius: number; damage: number; knockback: number; duration: number; radial: boolean }
  >,
} as const;
