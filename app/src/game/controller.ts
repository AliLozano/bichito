import type { Pet } from "../pet/sim";
import type { ArtKind } from "./types";
import { GAME } from "./config";

// A Controller is an INPUT SOURCE for a combatant pet. Humans and bots both implement
// it, so the engine drives every "play" pet through the exact same code path — a bot is
// literally "a human with synthesised input". This is what lets us keep ONE combat brain
// (engine.ts) instead of the old headless reimplementation.
export interface Controller {
  // held movement/jump intent (like arrow keys)
  readonly input: { left: boolean; right: boolean; up: boolean; down: boolean };
  // per-frame update. Bots run their AI here; humans are driven by key events so it's
  // (almost) a no-op. `opponent` is the nearest enemy pet, if any.
  think(self: Pet, opponent: Pet | undefined, dt: number, now: number): void;
  // one attack to perform this frame (the engine picks the direction), or null.
  takeAttack(now: number): ArtKind | null;
}

// Human: arrow keys write `input`; Space CHARGES, and on release queues a nail (quick
// tap) or a Nail Art (held past GAME.chargeTime, chosen by the held direction).
export class HumanController implements Controller {
  input = { left: false, right: false, up: false, down: false };
  onChargeReady?: () => void; // fired once when a charge finishes loading (SFX cue)
  private chargeStartAt: number | null = null;
  private readyPinged = false;
  private queued: ArtKind | null = null;

  startCharge(now: number) {
    this.chargeStartAt = now;
    this.readyPinged = false;
  }
  releaseCharge(now: number) {
    if (this.chargeStartAt == null) return;
    const held = now - this.chargeStartAt;
    this.chargeStartAt = null;
    this.readyPinged = false;
    if (held >= GAME.chargeTime * 1000) {
      this.queued = this.input.down ? "cyclone" : this.input.left || this.input.right ? "dash" : "great";
    } else {
      this.queued = "nail";
    }
  }
  cancelCharge() {
    this.chargeStartAt = null;
    this.readyPinged = false;
  }
  chargeLevel(now: number): number {
    if (this.chargeStartAt == null) return 0;
    return Math.min(1, (now - this.chargeStartAt) / (GAME.chargeTime * 1000));
  }
  reset() {
    this.input = { left: false, right: false, up: false, down: false };
    this.cancelCharge();
    this.queued = null;
  }

  think(_self: Pet, _opp: Pet | undefined, _dt: number, now: number) {
    if (this.chargeStartAt != null && !this.readyPinged && now - this.chargeStartAt >= GAME.chargeTime * 1000) {
      this.readyPinged = true;
      this.onChargeReady?.();
    }
  }
  takeAttack(_now: number): ArtKind | null {
    const a = this.queued;
    this.queued = null;
    return a;
  }
}

// Bot: a simple duel AI. Closes to nail range, faces the opponent, taps nail on a
// cadence, jumps occasionally, backs off if too close. Emits the SAME input a human
// would, so the engine can't tell the difference.
export class BotController implements Controller {
  input = { left: false, right: false, up: false, down: false };
  private nextAttackAt = 0;
  private nextJumpAt = 0;
  private queued: ArtKind | null = null;

  think(self: Pet, opp: Pet | undefined, _dt: number, now: number) {
    this.input.left = this.input.right = this.input.up = this.input.down = false;
    if (!opp) return;
    const dx = opp.x - self.x;
    const dist = Math.abs(dx);
    if (dist > 0.08) {
      if (dx > 0) this.input.right = true;
      else this.input.left = true;
    } else if (dist < 0.045) {
      if (dx > 0) this.input.left = true; // too close -> back off
      else this.input.right = true;
    }
    if (now >= this.nextJumpAt && dist < 0.14) {
      this.nextJumpAt = now + 1500 + rnd() * 2500;
      this.input.up = true;
    }
    if (dist < 0.11 && now >= this.nextAttackAt) {
      this.nextAttackAt = now + 600 + rnd() * 500;
      this.queued = "nail";
    }
  }
  takeAttack(_now: number): ArtKind | null {
    const a = this.queued;
    this.queued = null;
    return a;
  }
}

function rnd() {
  return Math.random();
}
