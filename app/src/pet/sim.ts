import { type Pose } from "../lib/characters";
import { DEFAULT_CONFIG, type WorldConfig } from "../lib/world-config";
import type { Env } from "./env";

// The shared "pet world". Everything is NORMALIZED (0..1). A pet I control is
// simulated locally at 60fps and broadcast ~20Hz; pets I don't control are
// PREDICTED from their last snapshot (dead reckoning) so dropped packets don't
// drop render frames. Either player can grab/throw any pet (control handoff).

// idle "activities" a pet cycles through while at rest, instead of only sleeping
export const IDLE_STATES = ["sleeping", "coding", "coffee", "music", "thinking"] as const;
export type IdleState = (typeof IDLE_STATES)[number];

export type PetState =
  | "walk"
  | IdleState
  | "held"
  | "thrown"
  | "leap"
  | "oncursor"
  | "dizzy"
  | "flee"
  | "gone"
  | "play"; // player-controlled (minigame): arrows to move/jump/crouch

function randIdle(exclude?: PetState): IdleState {
  const opts = IDLE_STATES.filter((s) => s !== exclude);
  return opts[Math.floor(Math.random() * opts.length)];
}

export interface Pet {
  owner: string;
  name: string;
  character: string; // built-in CharacterId or a custom avatar name
  controller: string;
  state: PetState;
  x: number;
  y: number;
  vx: number;
  vy: number;
  flip: boolean;
  frame: number;
  spin: number;
  grip: number;
  health: number; // 0..1 — minigame vitality (the green bar during a match). Lives on
  // the pet so it rides the snapshot and both players see the same bar. Full outside
  // matches; the defender decrements its own and it broadcasts.
  target: string; // oncursor: whose cursor
  // local-only bookkeeping
  t: number;
  restT: number; // total time spent resting this cycle (across idle activities)
  frameAcc: number;
  lastSnap: number;
  offX: number;
  offY: number;
  hold: number;
  hitAt: number;
  // gentle-placement tracking: a held pet released with a short travel settles to
  // sleep in place instead of getting dizzy and fleeing.
  placed: boolean;
  lx: number; // launch position when it entered "thrown"
  ly: number;
  // grip-battle cursor tracking (oncursor): prev cursor pos + smoothed speed
  pcx: number;
  pcy: number;
  spd: number;
  lphase: "run" | "climb" | "jump"; // leap approach sub-phase
  wanderNext: number;
}

export interface RemoteCursor {
  x: number;
  y: number;
  active: boolean;
  name: string;
  lastSeen: number;
}

// The minigame plugs into the pet world through this hook (implemented by
// src/game/engine.ts). The Sim owns the loop + transport and simply delegates a
// "play"-state pet's motion here; all game rules/state live behind it. Keeping the
// interface in the Sim (not the game module) means the Sim never imports the game.
export interface PetController {
  drivePet(p: Pet, dt: number, now: number): void; // motion of MY controlled pet
  predictPet(p: Pet, dt: number): void; // dead-reckon a peer's controlled pet
  stepWorld(dt: number, now: number): void; // advance game entities (nail swings, …)
  readonly armed?: boolean; // my pet is placed & napping, focused, waiting for the first key
  // MY pet just settled from a GENTLE placement (a soft drop / slow move / plain
  // click) — "arm" the minigame: keep sleeping + take keyboard focus, but don't start
  // playing until the first key. A hard throw skips this.
  armOnPlace?(p: Pet): void;
  // a pet's health just DROPPED (observed on an incoming snapshot) — i.e. it really took
  // damage. The single source of truth for hit feedback (flash + sound), so you can never
  // see a "hit" without actual damage.
  onDamaged?(owner: string, now: number): void;
}

// states where a HUMAN is actively manipulating a pet (dragging / on a cursor / mid-throw
// / leaping). While in one of these, its owner must NOT reclaim it — that's normal social
// play. Once it settles back to any other state, the owner takes it back (see step()).
const MANIPULATED = new Set<string>(["held", "oncursor", "leap", "thrown"]);
// Only take my pet back after it's been controlled by someone else AND at rest for THIS
// long. The delay is what makes a fresh grab survive: when a friend grabs my pet, the
// control claim arrives ~a frame before the "held" state, and without this hysteresis my
// pet would snap home mid-drag (a claim war). A truly stuck handoff easily outlasts it.
const RECLAIM_AFTER = 1500; // ms

// physics in normalized units (y grows downward). aspect-agnostic on purpose.
const G = 2.6; // gravity /s^2
const FLOOR_MARGIN = 0.2; // gap below the sprite, as a fraction of the sprite size (px-consistent on any screen)
const WALK = 0.05;
export const SPRITE_PX = 56; // pet sprite size in CSS px (shared with PetView)
export const COLLIDE_R = SPRITE_PX * 0.45; // pet↔pet collision radius in px (isotropic circle)
const SNAP_MS = 45; // normal broadcast interval (~22Hz) — plenty for ambient pets
const SNAP_MS_MATCH = 20; // while a pet is in a match ("play"), broadcast ~50Hz so
// the fast dueling motion (jump/crouch/dodge) stays crisp for the opponent
const CURSOR_MS = 45;
const DIZZY = 1.4; // dazed pause after landing — a window to grab it before it flees
const GENTLE_DIST = 0.16; // a released pet that traveled less than this settles to sleep in place (no dizzy/flee)
const MAX_LIFT_SPRITES = 4; // when leaping is off, a held pet lifted more than this many sprite-heights above the floor auto-drops
const MAX_THROW = 1.6; // cap on throw speed (norm/s) — a hard flick can't fling it infinitely fast
// Below this release speed (norm/s) a let-go counts as a GENTLE PLACEMENT: it drops in
// place (velocity zeroed) so it settles + "arms" for combat. Only a firmer flick above
// this keeps its (smoothed) throw momentum and arcs. Without this, the smoothed throw
// velocity drifted gentle placements past GENTLE_DIST -> dizzy -> couldn't enter combat.
const GENTLE_RELEASE_SPEED = 0.6;

// shortest distance from point (px,py) to segment (x1,y1)-(x2,y2) — for swept collision
function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

export class Sim {
  me = "";
  myName = "";
  myChar: string = "gato";
  pets = new Map<string, Pet>();
  cursors = new Map<string, RemoteCursor>();
  myCursor = { x: 0.5, y: 0.5 };
  charging = false; // mouse held down over a pet
  now = 0; // latest loop timestamp (perf-ms), so event handlers can stamp claims
  private ownStuckSince = 0; // when my pet first looked "stuck" under someone else's control (0 = not)
  // when I last CLAIMED each pet (grab/leap/auto). A fresh claim is protected from the
  // owner's in-flight snapshots for a grace window (see applySnap) so grabbing someone
  // else's pet can't be ripped back by their still-propagating "I own it" snapshots.
  private claimedAt = new Map<string, number>();
  config: WorldConfig = { ...DEFAULT_CONFIG }; // shared group vibe (synced)
  // the minigame plugs in here (set by the overlay). The Sim delegates "play"-state
  // pet motion + game-entity stepping to it, but knows nothing about game rules.
  game?: PetController;

  // viewport (px) + transport (the net_* wire) are injected so the SAME Sim runs in
  // the browser (window + Tauri invoke) AND headless in the bot (fixed screen + WS).
  constructor(public readonly env: Env) {}

  setConfig(c: WorldConfig) {
    this.config = c;
  }

  // Record that I just took control of `owner` (grab/leap/auto/bot-reclaim). Protects
  // the fresh claim from the previous controller's in-flight snapshots for a grace
  // window (see applySnap). Public so the bot's reclaim marks itself the same way.
  noteClaim(owner: string) {
    this.claimedAt.set(owner, this.now);
  }

  // Floor line (normalized y) so the sprite's BOTTOM sits FLOOR_MARGIN*sprite above
  // the screen bottom — a pixel-consistent gap on any resolution (sprite center is
  // half a sprite above its bottom, plus the margin).
  floor(): number {
    const H = this.env.vh();
    return 1 - (SPRITE_PX * (0.5 + FLOOR_MARGIN)) / H;
  }

  // begin a rest cycle at the edge: cycles through random idle activities (sleeping,
  // coding, coffee, music…) instead of only sleeping. `wanderNext` is reused as the
  // current activity's duration while resting.
  startRest(p: Pet, first?: PetState) {
    p.state = first ?? randIdle();
    p.wanderNext = rand(6, 14);
    p.restT = 0;
    p.t = 0;
    p.frameAcc = 0;
    // NOTE: does NOT reset health — a wandering/idle pet calls this constantly, so
    // healing here would out-heal a pester (health stuck near full). Health refills on
    // respawn (gone -> walk) and on entering/leaving combat.
  }

  // deterministic sleeping slot so pets lie down side by side (ranked by owner id),
  // all lined up on the left edge instead of overlapping.
  private sleepX(p: Pet): number {
    const owners = [...this.pets.keys()].sort();
    const rank = Math.max(0, owners.indexOf(p.owner));
    return 0.05 + rank * 0.055;
  }
  private lastSnapSent = new Map<string, number>();
  private lastCursorSent = 0;
  // Ghost-cursor visibility: an explicit shown/hidden flag broadcast to others.
  // show() is immediate; hide() waits HIDE_MS so it never flickers. Driven each
  // frame by whether I'm DIRECTLY interacting (clicking a pet / a pet on my cursor).
  private static readonly HIDE_MS = 3000;
  private cursorShown = false;
  private hideAt = 0;

  private showCursor() {
    this.cursorShown = true;
    this.hideAt = 0;
  }
  private hideCursor(now: number) {
    if (this.cursorShown && this.hideAt === 0) this.hideAt = now + Sim.HIDE_MS;
  }
  // Am I directly interacting? clicking a pet, or a pet is clinging to MY cursor.
  // Owning a pet that dangles on someone ELSE does NOT count — that's their turn.
  private tickCursor(now: number) {
    let interacting = this.charging;
    for (const p of this.pets.values()) {
      // I'm holding it (dragging), or it's clinging to MY cursor. A pet I'm leaping
      // onto SOMEONE ELSE (oncursor target!=me) is their turn, not mine.
      if (
        p.controller === this.me &&
        (p.state === "held" || (p.state === "oncursor" && p.target === this.me))
      )
        interacting = true;
    }
    if (interacting) this.showCursor();
    else this.hideCursor(now);
    if (this.hideAt && now >= this.hideAt) {
      this.cursorShown = false;
      this.hideAt = 0;
    }
  }

  setMe(id: string, name: string, char: string) {
    this.me = id;
    this.myName = name;
    this.myChar = char;
  }

  private blank(owner: string, name: string, character: string, controller: string): Pet {
    return {
      owner,
      name,
      character,
      controller,
      state: "walk",
      x: 0.5,
      y: this.floor(),
      vx: 0,
      vy: 0,
      flip: false,
      frame: 0,
      spin: 0,
      grip: 1,
      health: 1,
      target: "",
      t: 0,
      restT: 0,
      frameAcc: 0,
      lastSnap: 0,
      offX: 0,
      offY: 0,
      hold: 0,
      hitAt: 0,
      placed: false,
      lx: 0,
      ly: 0,
      pcx: NaN,
      pcy: NaN,
      spd: 0,
      lphase: "run",
      wanderNext: rand(1, 4),
    };
  }

  // --- ingest from server -------------------------------------------------
  applySnap(s: any, now: number) {
    if (!this.me) return; // not identified yet — ignore until setMe
    let p = this.pets.get(s.owner);
    if (!p) {
      p = this.blank(s.owner, s.name, s.character, s.controller);
      this.pets.set(s.owner, p);
    }
    // A pet I control is authoritative locally: a delayed snapshot from a former
    // controller (still in-flight during a handoff) must not clobber it. Control
    // changes arrive via PeerClaim/onClaim, so once p.controller is me, ignore —
    // EXCEPT when the pet's own OWNER is driving it (s.controller === s.owner): the
    // owner reclaiming its own pet is ground truth and must win, otherwise a stale
    // claim of mine freezes their pet forever (it renders stuck in an idle activity,
    // no health bar, while it actually fights on their side).
    // BUT: if I *just* grabbed this pet, my Claim is still propagating; the owner's
    // in-flight "I own it" snapshots would rip the fresh grab out of my hand (the
    // intermittent "no puedo levantar la mascota del amigo"). Protect it briefly.
    if (p.controller === this.me && s.controller !== this.me) {
      const justGrabbed = now - (this.claimedAt.get(s.owner) ?? -Infinity) < 800;
      const ownerReclaim = s.controller === s.owner && !justGrabbed;
      if (!ownerReclaim) return; // keep my control (fresh grab, or a non-owner's stale snap)
    }
    p.name = s.name;
    p.character = s.character;
    p.controller = s.controller;
    p.state = s.state;
    p.x = s.x;
    p.y = s.y;
    p.vx = s.vx;
    p.vy = s.vy;
    p.flip = s.flip;
    p.frame = s.frame;
    p.grip = s.grip;
    const newHealth = s.health ?? 1;
    // health only ever DROPS on damage, so a decrease on the wire IS a real hit landing
    // — the single trigger for hit feedback (flash + sound), consistent by construction.
    if (newHealth < p.health - 1e-6) this.game?.onDamaged?.(s.owner, now);
    p.health = newHealth;
    p.target = s.target;
    p.lastSnap = now;
    // if a pet leapt onto MY cursor, I take control (only I know my cursor)
    if (p.state === "oncursor" && p.target === this.me && p.controller !== this.me) {
      p.controller = this.me;
      p.pcx = NaN; // reset grip-battle speed tracking on takeover
      p.spd = 0;
      p.hold = 0;
      p.t = 0;
      this.claimedAt.set(p.owner, now);
      this.env.transport.claim(p.owner);
    }
  }

  onWorld(pets: any[], now: number) {
    if (!this.me) return; // not identified yet
    for (const s of pets) if (s.owner !== this.me || !this.pets.has(this.me)) this.applySnap(s, now);
    // ensure my own pet exists & is mine
    if (!this.pets.has(this.me)) {
      const p = this.blank(this.me, this.myName, this.myChar, this.me);
      this.pets.set(this.me, p);
    }
    // prune pets that left the world (a friend disconnected) — keep mine
    const present = new Set(pets.map((s) => s.owner));
    for (const owner of [...this.pets.keys()]) {
      if (owner !== this.me && !present.has(owner)) this.pets.delete(owner);
    }
  }

  onClaim(owner: string, controller: string) {
    const p = this.pets.get(owner);
    if (p) p.controller = controller;
  }

  onBump(owner: string, vx: number, vy: number) {
    const p = this.pets.get(owner);
    if (p && p.controller === this.me) {
      p.state = "thrown";
      p.placed = false; // a collision makes it flee, not settle
      p.vx = vx;
      p.vy = vy;
      p.t = 0;
    }
  }

  onCursor(from: string, x: number, y: number, active: boolean, now: number) {
    const name = this.pets.get(from)?.name ?? "";
    this.cursors.set(from, { x, y, active, name, lastSeen: now });
  }

  // --- input --------------------------------------------------------------
  // Hit-test as a pixel CIRCLE sized to the actual sprite (SPRITE_PX), so it's
  // resolution/DPI-independent and isotropic (no aspect-distorted "padding").
  // `radiusPx` lets callers use a tight radius for grabbing and a generous one
  // for arming click-capture (which needs margin to beat toggle latency).
  petAt(px: number, py: number, radiusPx: number = SPRITE_PX * 0.64): Pet | undefined {
    const W = this.env.vw();
    const H = this.env.vh();
    const cx = px * W;
    const cy = py * H;
    let best: Pet | undefined;
    let bd = radiusPx;
    for (const p of this.pets.values()) {
      if (p.state === "gone") continue;
      const d = Math.hypot(p.x * W - cx, p.y * H - cy);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  grab(p: Pet) {
    p.controller = this.me;
    p.state = "held";
    p.offX = p.x - this.myCursor.x;
    p.offY = p.y - this.myCursor.y;
    p.vx = 0;
    p.vy = 0;
    this.claimedAt.set(p.owner, this.now);
    this.env.transport.claim(p.owner);
  }

  releaseHeld(p: Pet) {
    if (p.state !== "held") return;
    const sp = Math.hypot(p.vx, p.vy);
    if (!this.config.allowLeap || sp < GENTLE_RELEASE_SPEED) {
      // less-intrusive mode OR a gentle placement (slow release): drop in place so it
      // settles + arms, instead of drifting on the smoothed throw velocity.
      p.vx = 0;
      p.vy = 0;
    } else if (sp > MAX_THROW) {
      // the fling inherits the cursor's speed — cap it so a hard flick can't launch
      // it at "infinite" speed (which also causes it to tunnel through collisions).
      p.vx = (p.vx / sp) * MAX_THROW;
      p.vy = (p.vy / sp) * MAX_THROW;
    }
    // eligible to settle-and-sleep if it lands close to here (a gentle placement)
    p.placed = true;
    p.lx = p.x;
    p.ly = p.y;
    p.state = "thrown";
    p.t = 0;
  }

  // send MY pet at a target: it runs to the edge, climbs, and leaps onto the cursor
  leap(target: string) {
    if (!this.config.allowLeap) return; // leaping disabled (less-intrusive mode)
    const p = this.pets.get(this.me);
    if (!p || target === this.me) return;
    if (!this.pets.has(target)) return; // don't chase a ghost
    // already busy (on a cursor, held, mid-leap or airborne) -> ignore
    if (p.state === "oncursor" || p.state === "held" || p.state === "leap" || p.state === "thrown")
      return;
    p.controller = this.me;
    p.state = "leap";
    p.lphase = "run";
    p.target = target;
    p.grip = 1;
    p.hold = 0;
    p.pcx = NaN;
    p.spd = 0;
    p.t = 0;
    this.claimedAt.set(p.owner, this.now);
    this.env.transport.claim(p.owner);
  }

  // --- main loop ----------------------------------------------------------
  step(dt: number, now: number) {
    this.now = now;
    this.reclaimOwnPet(now);
    for (const p of this.pets.values()) {
      if (p.controller === this.me) this.simulate(p, dt, now);
      else this.predict(p, dt);
    }
    this.game?.stepWorld(dt, now); // advance minigame entities (nail swings, …)
    this.collide(now, dt);
    this.tickCursor(now);
    this.broadcast(now);
    this.broadcastCursor(now);
    // prune stale cursors
    for (const [id, c] of this.cursors) if (now - c.lastSeen > 1500) this.cursors.delete(id);
  }

  // I always own MY pet: if a friend grabbed/leapt it and then let it SETTLE (it's no
  // longer held/on-a-cursor/mid-throw), take control back. Otherwise a stale handoff
  // pins my pet on their client — the server rejects my snapshots (incl. health drops),
  // which silently breaks combat ("le pego y no le baja la vida"). Skipped while it's
  // actively being manipulated, so normal grab/throw social play still works.
  private reclaimOwnPet(now: number) {
    const mine = this.pets.get(this.me);
    // I control it, or a friend is actively handling it (held/on-cursor/mid-throw) ->
    // not stuck. Reset the timer so a fresh grab (or any active drag) is never reclaimed.
    if (!mine || mine.controller === this.me || MANIPULATED.has(mine.state)) {
      this.ownStuckSince = 0;
      return;
    }
    // Someone else controls my pet and it's at rest. Wait out RECLAIM_AFTER before taking
    // it back, so the brief window at the START of a legit grab (claim arrives a frame
    // before the "held" state) doesn't trigger a reclaim tug-of-war.
    if (this.ownStuckSince === 0) this.ownStuckSince = now;
    if (now - this.ownStuckSince < RECLAIM_AFTER) return;
    if (now - (this.claimedAt.get(this.me) ?? -Infinity) < 500) return; // debounce claims
    mine.controller = this.me;
    this.claimedAt.set(this.me, now);
    this.env.transport.claim(this.me);
    this.ownStuckSince = 0;
  }

  private simulate(p: Pet, dt: number, now: number) {
    const FLOOR = this.floor();
    p.t += dt;
    switch (p.state) {
      case "walk": {
        p.frameAcc += dt;
        if (p.frameAcc > 0.12) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        // after wandering for walkTime, get sleepy: go to the shared sleeping spot
        // (all pets line up next to each other on the left edge).
        const sleepy = p.t > this.config.walkTime;
        const goal = sleepy ? this.sleepX(p) : p.wanderNext;
        const dir = goal > p.x ? 1 : -1;
        p.x += dir * WALK * dt;
        p.flip = dir < 0;
        p.y = FLOOR;
        if (Math.abs(p.x - goal) < 0.02) {
          if (sleepy) this.startRest(p); // begin the idle-activity cycle at the edge
          else p.wanderNext = rand(0.1, 0.9);
        }
        break;
      }
      case "play":
        // player-controlled: motion + combat live in the minigame (src/game/engine.ts).
        this.game?.drivePet(p, dt, now);
        break;
      // resting: cycle random idle activities (sleeping / coding / coffee / music /
      // thinking). Each lasts `wanderNext` seconds; after the total rest budget
      // (config.sleepTime) it wakes and walks again.
      case "sleeping":
      case "coding":
      case "coffee":
      case "music":
      case "thinking": {
        p.y = FLOOR;
        // armed & waiting to fight: hold a steady nap (don't cycle to coding/coffee or
        // wake) until the first key starts the match.
        if (p.owner === this.me && this.game?.armed) {
          p.frameAcc = 0;
          break;
        }
        p.restT += dt;
        p.frameAcc += dt;
        if (p.frameAcc > 0.6) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        if (p.t > p.wanderNext) {
          if (p.restT > this.config.sleepTime) {
            p.state = "walk";
            p.wanderNext = rand(0.1, 0.9);
            p.t = 0;
          } else {
            // switch to a different activity (keep resting)
            const rest = p.restT;
            this.startRest(p, randIdle(p.state));
            p.restT = rest; // preserve total rest across the switch
          }
        }
        break;
      }
      case "held": {
        // less-intrusive mode: if you lift it more than a few sprite-heights above
        // the floor, it drops instead of going up (px-consistent on any screen).
        const maxLift = (MAX_LIFT_SPRITES * SPRITE_PX) / this.env.vh();
        if (!this.config.allowLeap && p.y < FLOOR - maxLift) {
          this.releaseHeld(p);
          break;
        }
        const nx = this.myCursor.x + p.offX;
        const ny = this.myCursor.y + p.offY;
        // Throw velocity = a SMOOTHED (EMA) cursor velocity, not just this frame's delta.
        // Raw last-frame delta is often ~0 at the instant of release (you decelerate the
        // mouse before letting go, and the Rust cursor poller / rAF loop drift out of
        // phase so some frames carry no fresh cursor update) — which made the fling drop
        // straight down as if braked. Smoothing keeps the flick's momentum through a
        // single dead frame; a genuine still-hold still decays to ~0 (a plain drop).
        const ivx = (nx - p.x) / Math.max(dt, 1e-3);
        const ivy = (ny - p.y) / Math.max(dt, 1e-3);
        const keep = 0.6; // weight on recent history
        p.vx = p.vx * keep + ivx * (1 - keep);
        p.vy = p.vy * keep + ivy * (1 - keep);
        p.x = nx;
        p.y = ny;
        break;
      }
      case "oncursor": {
        // it's on a cursor I control (the target is me)
        const c = p.target === this.me ? this.myCursor : this.cursors.get(p.target);
        if (c) {
          // grip battle by cursor SPEED: normal movement -> hangs ~1 min; moving the
          // mouse fast -> drops in seconds. Speed is measured against the cursor's own
          // previous position (not the pet's 0.02 offset, which would read a phantom
          // 0.02/dt every frame and drain instantly).
          const first = Number.isNaN(p.pcx);
          const dvx = first ? 0 : (c.x - p.pcx) / Math.max(dt, 1e-3);
          const dvy = first ? 0 : (c.y - p.pcy) / Math.max(dt, 1e-3);
          const sp = Math.hypot(dvx, dvy);
          p.vx = dvx; // expose cursor velocity so this pet collides while on the cursor
          p.vy = dvy;
          p.pcx = c.x;
          p.pcy = c.y;
          p.spd = p.spd * 0.6 + sp * 0.4; // light smoothing so fast flicks register quickly
          p.x = c.x;
          p.y = c.y + 0.02;
          // decay(speed): still -> stays; ~0.6 "normal" -> ~1 min; ~4 "fast" -> ~3s.
          const decay = 0.005 + 0.03 * Math.pow(p.spd, 1.8);
          let reinforce = 0;
          for (const [id, oc] of this.cursors) {
            if (id === p.target) continue;
            if (oc.active && Math.hypot(oc.x - p.x, oc.y - p.y) < 0.12) reinforce = 1;
          }
          p.hold = Math.min(1, Math.max(0, p.hold - 1.5 * dt + reinforce * 3 * dt));
          p.grip = Math.max(0, Math.min(1, p.grip + (p.hold * 1.2 - decay) * dt));
          if (p.grip <= 0 || p.t > 180) {
            p.state = "thrown";
            p.vx = rand(-0.2, 0.2);
            p.vy = -0.15;
            p.t = 0;
          }
        } else {
          // target's cursor is gone (they disconnected) -> let go and drop
          p.state = "thrown";
          p.vy = -0.15;
          p.t = 0;
        }
        break;
      }
      case "leap": {
        // approach: run to the nearest edge, climb it, then leap onto the cursor.
        const c = p.target === this.me ? this.myCursor : this.cursors.get(p.target);
        if (!c || !this.pets.has(p.target) || p.t > 4) {
          // target vanished (or the leap stalled) -> abort and run off
          p.state = "flee";
          p.wanderNext = p.x < 0.5 ? -0.1 : 1.1;
          p.t = 0;
          break;
        }
        p.frameAcc += dt;
        if (p.frameAcc > 0.06) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        const edge = c.x < 0.5 ? 0.03 : 0.97; // climb the edge nearest the target
        if (p.lphase === "run") {
          p.y = FLOOR;
          const dir = edge > p.x ? 1 : -1;
          p.vx = dir * this.config.runSpeed * 1.7; // fast so the mouse can't escape
          p.vy = 0;
          p.x += p.vx * dt;
          p.flip = dir < 0;
          if (Math.abs(p.x - edge) < 0.03) {
            p.x = edge;
            p.lphase = "climb";
          }
        } else if (p.lphase === "climb") {
          p.x = edge;
          p.vx = 0;
          p.vy = 0;
          p.flip = edge > 0.5;
          const topY = Math.max(0.05, Math.min(c.y, FLOOR) - 0.05);
          p.y += (topY - p.y) * Math.min(1, dt * 9);
          if (p.y <= topY + 0.02) {
            p.lphase = "jump";
            p.vx = (c.x - p.x) * 2.4; // launch toward the cursor
            p.vy = -0.15;
          }
        } else {
          // jump: ballistic arc steered onto the (moving) cursor
          p.vy += G * dt;
          p.x += p.vx * dt + (c.x - p.x) * Math.min(1, dt * 5);
          p.y += p.vy * dt + (c.y - p.y) * Math.min(1, dt * 4);
          p.flip = c.x < p.x;
          if (Math.hypot(p.x - c.x, p.y - c.y) < 0.045) {
            p.state = "oncursor";
            p.grip = 1;
            p.hold = 0;
            p.pcx = NaN;
            p.spd = 0;
            p.t = 0;
          } else if (p.y >= FLOOR) {
            // missed the cursor and hit the floor -> land dazed (grabbable), don't
            // keep falling off-screen forever
            p.y = FLOOR;
            p.state = "dizzy";
            p.vx = 0;
            p.vy = 0;
            p.spin = 0;
            p.t = 0;
          }
        }
        break;
      }
      case "thrown": {
        // hard cap the speed (defensive — no runaway velocity, keeps collisions sane)
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_THROW) {
          p.vx = (p.vx / sp) * MAX_THROW;
          p.vy = (p.vy / sp) * MAX_THROW;
        }
        p.vy += G * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.spin += p.vx * dt * 90;
        if (p.x < 0.02) {
          p.x = 0.02;
          p.vx = -p.vx * 0.7;
        } else if (p.x > 0.98) {
          p.x = 0.98;
          p.vx = -p.vx * 0.7;
        }
        if (p.y < 0.02) {
          p.y = 0.02;
          p.vy = -p.vy * 0.6;
        } else if (p.y > FLOOR) {
          p.y = FLOOR;
          p.vy = -p.vy * 0.5;
          p.vx *= 0.8;
        }
        if (p.y >= FLOOR - 0.005 && Math.abs(p.vy) < 0.12 && Math.abs(p.vx) < 0.06) {
          const gentle = p.placed && Math.hypot(p.x - p.lx, p.y - p.ly) < GENTLE_DIST;
          p.placed = false;
          p.spin = 0;
          p.vx = 0;
          p.vy = 0;
          p.y = FLOOR;
          p.t = 0;
          // a gentle placement of a FRIEND's pet settles it to sleep. MINE instead goes
          // combat-ready ("armed": stands holding its nail, keyboard focused, waiting for
          // the first key). A plain click lands here too (~0 travel). A hard/high throw
          // gets dizzy and runs off.
          if (gentle) {
            if (p.owner === this.me && this.game?.armOnPlace) this.game.armOnPlace(p);
            else this.startRest(p, "sleeping");
          } else p.state = "dizzy";
        }
        break;
      }
      case "dizzy": {
        p.y = FLOOR;
        p.frameAcc += dt;
        if (p.frameAcc > 0.15) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        if (p.t > DIZZY) {
          p.state = "flee";
          p.wanderNext = p.x < 0.5 ? -0.1 : 1.1;
          p.t = 0;
        }
        break;
      }
      case "flee": {
        p.frameAcc += dt;
        if (p.frameAcc > 0.08) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        const dir = p.wanderNext > p.x ? 1 : -1;
        p.x += dir * this.config.runSpeed * dt;
        p.flip = dir < 0;
        p.y = FLOOR;
        if (p.x < -0.08 || p.x > 1.08) {
          p.state = "gone";
          p.t = 0;
        }
        break;
      }
      case "gone": {
        p.t += dt; // already added above; extra pause
        if (p.t > rand(4, 9)) {
          // respawn walking in from an edge
          const left = Math.random() < 0.5;
          p.x = left ? -0.05 : 1.05;
          p.y = FLOOR;
          p.wanderNext = rand(0.2, 0.8);
          p.state = "walk";
          p.health = 1; // respawn at full health
          p.t = 0;
        }
        break;
      }
    }
  }

  // dead-reckoning for pets someone else controls
  private predict(p: Pet, dt: number) {
    if (p.state === "thrown") {
      p.vy += G * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.spin += p.vx * dt * 90;
    } else if (p.state === "play") {
      // dead-reckon a player-controlled pet between snapshots (game owns the physics)
      this.game?.predictPet(p, dt);
    } else if (
      p.state === "flee" ||
      p.state === "walk" ||
      p.state === "dizzy" ||
      p.state === "leap" ||
      (IDLE_STATES as readonly string[]).includes(p.state)
    ) {
      p.x += p.vx * dt; // usually 0; snapshots drive position
      p.frameAcc += dt;
      if (p.frameAcc > 0.1) {
        p.frameAcc = 0;
        p.frame ^= 1;
      }
    }
    // held/oncursor: position comes from snapshots (follows their cursor)
  }

  private collide(now: number, dt: number) {
    // detect in PIXELS so the collision zone is a real circle (normalized units are
    // aspect-distorted). Positions convert to px via the window; the bounce direction
    // stays normalized (velocities are normalized).
    const W = this.env.vw();
    const H = this.env.vh();
    for (const a of this.pets.values()) {
      if (a.controller !== this.me) continue;
      // a pet is a collider while thrown, held, or clinging to my cursor (oncursor)
      const moving = a.state === "thrown" || a.state === "held" || a.state === "oncursor";
      if (!moving) continue;
      if (now - a.hitAt < 250) continue;
      // where a was last frame — check the whole swept segment, not just the
      // endpoint, so a fast pet can't tunnel straight through another.
      const ax0 = (a.x - a.vx * dt) * W;
      const ay0 = (a.y - a.vy * dt) * H;
      for (const b of this.pets.values()) {
        if (b === a || b.state === "gone") continue;
        const d = segDist(b.x * W, b.y * H, ax0, ay0, a.x * W, a.y * H);
        if (d < COLLIDE_R * 2) {
          const dd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          const nx = (a.x - b.x) / dd;
          const ny = (a.y - b.y) / dd;
          const K = 0.5;
          // recoil myself — knocked loose off the cursor/hand into a bounce
          a.hitAt = now;
          a.state = "thrown";
          a.placed = false;
          a.vx = nx * K;
          a.vy = ny * K - 0.2;
          a.t = 0;
          // bump the other (its controller applies it; if I control it, apply now)
          const bvx = -nx * K;
          const bvy = -ny * K - 0.2;
          if (b.controller === this.me) {
            b.state = "thrown";
            b.placed = false;
            b.vx = bvx;
            b.vy = bvy;
            b.t = 0;
            b.hitAt = now;
          } else {
            this.env.transport.bump(b.owner, bvx, bvy);
          }
          break;
        }
      }
    }
  }

  private broadcast(now: number) {
    for (const p of this.pets.values()) {
      if (p.controller !== this.me) continue;
      const last = this.lastSnapSent.get(p.owner) ?? 0;
      // a pet in a match broadcasts faster so the opponent sees crisp dueling motion
      const interval = p.state === "play" ? SNAP_MS_MATCH : SNAP_MS;
      if (now - last < interval) continue;
      this.lastSnapSent.set(p.owner, now);
      this.env.transport.snap({
        owner: p.owner,
        name: p.name,
        character: p.character,
        controller: p.controller,
        state: p.state,
        x: p.x,
        y: p.y,
        vx: p.vx,
        vy: p.vy,
        flip: p.flip,
        frame: p.frame,
        grip: p.grip,
        health: p.health,
        target: p.target,
      });
    }
  }

  private broadcastCursor(now: number) {
    if (now - this.lastCursorSent < CURSOR_MS) return;
    this.lastCursorSent = now;
    // visibility is decided by tickCursor (show/hide + 3s grace)
    this.env.transport.cursor(this.myCursor.x, this.myCursor.y, this.cursorShown);
  }

  pose(p: Pet): Pose {
    switch (p.state) {
      case "walk":
      case "flee":
        return "walk";
      case "play":
        return p.y < this.floor() - 0.01 ? "jump" : "walk";
      case "leap":
        return p.lphase === "jump" ? "jump" : "walk";
      case "sleeping":
        return "sleep";
      case "coding":
      case "coffee":
      case "music":
      case "thinking":
      case "dizzy":
        return "idle";
      case "held":
      case "oncursor":
        return "hang";
      case "thrown":
        return "fall";
      default:
        return "idle";
    }
  }
}
