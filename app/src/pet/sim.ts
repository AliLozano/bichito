import { invoke } from "@tauri-apps/api/core";
import { type CharacterId, type Pose } from "../lib/characters";

// The shared "pet world". Everything is NORMALIZED (0..1). A pet I control is
// simulated locally at 60fps and broadcast ~20Hz; pets I don't control are
// PREDICTED from their last snapshot (dead reckoning) so dropped packets don't
// drop render frames. Either player can grab/throw any pet (control handoff).

export type PetState = "walk" | "held" | "thrown" | "leap" | "oncursor" | "dizzy" | "flee" | "gone";

export interface Pet {
  owner: string;
  name: string;
  character: CharacterId;
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
  target: string; // oncursor: whose cursor
  // local-only bookkeeping
  t: number;
  frameAcc: number;
  lastSnap: number;
  offX: number;
  offY: number;
  hold: number;
  hitAt: number;
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

// physics in normalized units (y grows downward). aspect-agnostic on purpose.
const G = 2.6; // gravity /s^2
const FLOOR = 0.9;
const WALK = 0.05;
const RUN = 0.26;
const PET_R = 0.03; // collision radius (normalized)
const SNAP_MS = 45;
const CURSOR_MS = 45;
const DIZZY = 1.4; // dazed pause after landing — a window to grab it before it flees
const MAX_THROW = 1.6; // cap on throw speed (norm/s) — a hard flick can't fling it infinitely fast

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
  myChar: CharacterId = "gato";
  pets = new Map<string, Pet>();
  cursors = new Map<string, RemoteCursor>();
  myCursor = { x: 0.5, y: 0.5 };
  charging = false; // mouse held down over a pet
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

  setMe(id: string, name: string, char: CharacterId) {
    this.me = id;
    this.myName = name;
    this.myChar = char;
  }

  private blank(owner: string, name: string, character: string, controller: string): Pet {
    return {
      owner,
      name,
      character: character as CharacterId,
      controller,
      state: "walk",
      x: 0.5,
      y: FLOOR,
      vx: 0,
      vy: 0,
      flip: false,
      frame: 0,
      spin: 0,
      grip: 1,
      target: "",
      t: 0,
      frameAcc: 0,
      lastSnap: 0,
      offX: 0,
      offY: 0,
      hold: 0,
      hitAt: 0,
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
    // changes arrive via PeerClaim/onClaim, so once p.controller is me, ignore.
    if (p.controller === this.me && s.controller !== this.me) return;
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
    p.target = s.target;
    p.lastSnap = now;
    // if a pet leapt onto MY cursor, I take control (only I know my cursor)
    if (p.state === "oncursor" && p.target === this.me && p.controller !== this.me) {
      p.controller = this.me;
      p.pcx = NaN; // reset grip-battle speed tracking on takeover
      p.spd = 0;
      p.hold = 0;
      p.t = 0;
      invoke("net_claim", { owner: p.owner }).catch(() => {});
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
  petAt(px: number, py: number): Pet | undefined {
    let best: Pet | undefined;
    let bd = PET_R * 1.6;
    for (const p of this.pets.values()) {
      if (p.state === "gone") continue;
      const d = Math.hypot(p.x - px, p.y - py);
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
    invoke("net_claim", { owner: p.owner }).catch(() => {});
  }

  releaseHeld(p: Pet) {
    if (p.state !== "held") return;
    // the fling inherits the cursor's speed — cap it so a hard flick can't launch
    // it at "infinite" speed (which also causes it to tunnel through collisions).
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > MAX_THROW) {
      p.vx = (p.vx / sp) * MAX_THROW;
      p.vy = (p.vy / sp) * MAX_THROW;
    }
    p.state = "thrown";
    p.t = 0;
  }

  // send MY pet at a target: it runs to the edge, climbs, and leaps onto the cursor
  leap(target: string) {
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
    invoke("net_claim", { owner: p.owner }).catch(() => {});
  }

  // --- main loop ----------------------------------------------------------
  step(dt: number, now: number) {
    for (const p of this.pets.values()) {
      if (p.controller === this.me) this.simulate(p, dt);
      else this.predict(p, dt);
    }
    this.collide(now, dt);
    this.tickCursor(now);
    this.broadcast(now);
    this.broadcastCursor(now);
    // prune stale cursors
    for (const [id, c] of this.cursors) if (now - c.lastSeen > 1500) this.cursors.delete(id);
  }

  private simulate(p: Pet, dt: number) {
    p.t += dt;
    switch (p.state) {
      case "walk": {
        p.frameAcc += dt;
        if (p.frameAcc > 0.12) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        const goal = p.wanderNext; // reused as target x
        const dir = goal > p.x ? 1 : -1;
        p.x += dir * WALK * dt;
        p.flip = dir < 0;
        p.y = FLOOR;
        if (Math.abs(p.x - goal) < 0.02) {
          p.wanderNext = rand(0.1, 0.9);
          p.t = 0;
        }
        break;
      }
      case "held": {
        const nx = this.myCursor.x + p.offX;
        const ny = this.myCursor.y + p.offY;
        p.vx = (nx - p.x) / Math.max(dt, 1e-3);
        p.vy = (ny - p.y) / Math.max(dt, 1e-3);
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
          p.vx = dir * RUN * 1.7; // real velocity so viewers extrapolate smoothly
          p.vy = 0;
          p.x += p.vx * dt; // fast, so the mouse can't escape
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
          // land dazed — sit and wobble for a beat so it can be grabbed again
          p.state = "dizzy";
          p.spin = 0;
          p.vx = 0;
          p.vy = 0;
          p.y = FLOOR;
          p.t = 0;
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
        p.x += dir * RUN * dt;
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
    } else if (
      p.state === "flee" ||
      p.state === "walk" ||
      p.state === "dizzy" ||
      p.state === "leap"
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
    for (const a of this.pets.values()) {
      if (a.controller !== this.me) continue;
      // a pet is a collider while thrown, held, or clinging to my cursor (oncursor)
      const moving = a.state === "thrown" || a.state === "held" || a.state === "oncursor";
      if (!moving) continue;
      if (now - a.hitAt < 250) continue;
      // where a was last frame — check the whole swept segment, not just the
      // endpoint, so a fast pet can't tunnel straight through another.
      const ax0 = a.x - a.vx * dt;
      const ay0 = a.y - a.vy * dt;
      for (const b of this.pets.values()) {
        if (b === a || b.state === "gone") continue;
        const d = segDist(b.x, b.y, ax0, ay0, a.x, a.y);
        if (d < PET_R * 2) {
          const nx = (a.x - b.x) / (Math.hypot(a.x - b.x, a.y - b.y) || 1);
          const ny = (a.y - b.y) / (Math.hypot(a.x - b.x, a.y - b.y) || 1);
          const K = 0.5;
          // recoil myself — knocked loose off the cursor/hand into a bounce
          a.hitAt = now;
          a.state = "thrown";
          a.vx = nx * K;
          a.vy = ny * K - 0.2;
          a.t = 0;
          // bump the other (its controller applies it; if I control it, apply now)
          const bvx = -nx * K;
          const bvy = -ny * K - 0.2;
          if (b.controller === this.me) {
            b.state = "thrown";
            b.vx = bvx;
            b.vy = bvy;
            b.t = 0;
            b.hitAt = now;
          } else {
            invoke("net_bump", { owner: b.owner, vx: bvx, vy: bvy }).catch(() => {});
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
      if (now - last < SNAP_MS) continue;
      this.lastSnapSent.set(p.owner, now);
      invoke("net_snap", {
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
        target: p.target,
      }).catch(() => {});
    }
  }

  private broadcastCursor(now: number) {
    if (now - this.lastCursorSent < CURSOR_MS) return;
    this.lastCursorSent = now;
    // visibility is decided by tickCursor (show/hide + 3s grace)
    invoke("net_cursor", { x: this.myCursor.x, y: this.myCursor.y, active: this.cursorShown }).catch(
      () => {}
    );
  }

  pose(p: Pet): Pose {
    switch (p.state) {
      case "walk":
      case "flee":
        return "walk";
      case "leap":
        return p.lphase === "jump" ? "jump" : "walk";
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
