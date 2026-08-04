// Minigame data model. Kept separate from the pet snapshot (src/pet/sim.ts): a
// pet's on-screen motion (x/y/flip/state) still travels as a normal pet snapshot,
// so viewers render a playing pet with zero game knowledge. Only game-specific
// state (below) is game-owned, and only game EVENTS ride the generic relay.

export type SlashDir = "left" | "right" | "up" | "down";
// nail = normal aguijonazo; the rest are charged Nail Arts:
//   great   = Gran Corte  (big forward slash)
//   cyclone = Corte Ciclón (radial spin, hits all around)
//   dash    = Corte Veloz  (lunge forward + slash)
export type ArtKind = "nail" | "great" | "cyclone" | "dash";

// A nail swing: a short-lived hitbox attached to (and following) the owner pet. Two
// overlapping swings CLASH (parry, both bounce, no damage); an un-clashed swing
// overlapping a pet body deals `damage`. Geometry/damage are resolved from the Art at
// creation and travel with the event, so any client/bot can judge without a config
// table. `radial` (cyclone) ignores `dir` and hits all around. `cx/cy` = px center,
// recomputed each frame from the owner pet.
export interface Slash {
  id: string;
  owner: string;
  kind: ArtKind;
  dir: SlashDir;
  reach: number; // sprite-fractions from the pet center to the swing center
  radius: number; // sprite-fractions hitbox radius
  damage: number; // health removed on a clean hit
  knockback: number; // normalized x shove on hit
  radial: boolean; // hits all around (cyclone)
  duration: number; // seconds the hitbox stays active
  t: number; // age (s)
  dead: boolean;
  clashed: boolean;
  hitDone: boolean; // already resolved (hit/clash) — a swing connects at most once
  cx: number;
  cy: number;
}

// Per-player match state, keyed by pet owner id. Grows here as the game grows
// (score, current art, lives…). For now: combat timers only (health is on the Pet).
export interface PlayerState {
  stunUntil: number; // performance.now() ms until input unlocks / flash clears
  attackCdAt: number; // performance.now() ms when this player may swing again
}

export function newPlayer(): PlayerState {
  return { stunUntil: 0, attackCdAt: 0 };
}

// Wire events over the generic relay (invoke "net_game" -> peers get "peer-game").
// Hits are ATTACKER-authoritative: the attacker resolves its own swing against the
// opponent (in its own view — responsive/WYSIWYG) and sends a `hit`; the victim just
// applies it. `slash` is broadcast for RENDERING the arc + local clash detection.
// Add kinds as the game grows — the server never needs to change.
export type GameEvent =
  | {
      kind: "slash";
      owner: string;
      art: ArtKind;
      dir: SlashDir;
      reach: number;
      radius: number;
      damage: number;
      knockback: number;
      radial: boolean;
      duration: number;
      x: number;
      y: number;
    }
  | {
      kind: "hit";
      target: string; // whose pet got hit
      damage: number;
      knockback: number;
      dir: number; // +1/-1 direction to shove the victim (away from the attacker)
    };
