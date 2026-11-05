// tools/drag-repro.ts
import WebSocket from "ws";

// src/lib/world-config.ts
var DEFAULT_CONFIG = {
  walkTime: 25,
  sleepTime: 25,
  jumpEvery: 3600,
  // ~once an hour by default (configurable 1/min .. 1/hr .. never)
  runSpeed: 0.26,
  allowLeap: true
};

// src/pet/sim.ts
var IDLE_STATES = ["sleeping", "coding", "coffee", "music", "thinking"];
function randIdle(exclude) {
  const opts = IDLE_STATES.filter((s) => s !== exclude);
  return opts[Math.floor(Math.random() * opts.length)];
}
var MANIPULATED = /* @__PURE__ */ new Set(["held", "oncursor", "leap", "thrown"]);
var RECLAIM_AFTER = 1500;
var G = 2.6;
var FLOOR_MARGIN = 0.2;
var WALK = 0.05;
var SPRITE_PX = 56;
var COLLIDE_R = SPRITE_PX * 0.45;
var SNAP_MS = 45;
var SNAP_MS_MATCH = 20;
var CURSOR_MS = 45;
var INTERP_DELAY = 100;
var BUF_MS = 1e3;
var TELEPORT_DIST = 0.3;
var DIZZY = 1.4;
var GENTLE_DIST = 0.16;
var MAX_LIFT_SPRITES = 4;
var MAX_THROW = 1.6;
var GENTLE_RELEASE_SPEED = 0.6;
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function rand(a, b) {
  return a + Math.random() * (b - a);
}
var Sim = class _Sim {
  // viewport (px) + transport (the net_* wire) are injected so the SAME Sim runs in
  // the browser (window + Tauri invoke) AND headless in the bot (fixed screen + WS).
  constructor(env) {
    this.env = env;
  }
  me = "";
  myName = "";
  myChar = "gato";
  pets = /* @__PURE__ */ new Map();
  cursors = /* @__PURE__ */ new Map();
  myCursor = { x: 0.5, y: 0.5 };
  charging = false;
  // mouse held down over a pet
  now = 0;
  // latest loop timestamp (perf-ms), so event handlers can stamp claims
  ownStuckSince = 0;
  // when my pet first looked "stuck" under someone else's control (0 = not)
  // when I last CLAIMED each pet (grab/leap/auto). A fresh claim is protected from the
  // owner's in-flight snapshots for a grace window (see applySnap) so grabbing someone
  // else's pet can't be ripped back by their still-propagating "I own it" snapshots.
  claimedAt = /* @__PURE__ */ new Map();
  config = { ...DEFAULT_CONFIG };
  // shared group vibe (synced)
  // the minigame plugs in here (set by the overlay). The Sim delegates "play"-state
  // pet motion + game-entity stepping to it, but knows nothing about game rules.
  game;
  setConfig(c) {
    this.config = c;
  }
  // Record that I just took control of `owner` (grab/leap/auto/bot-reclaim). Protects
  // the fresh claim from the previous controller's in-flight snapshots for a grace
  // window (see applySnap). Public so the bot's reclaim marks itself the same way.
  noteClaim(owner) {
    this.claimedAt.set(owner, this.now);
  }
  // Floor line (normalized y) so the sprite's BOTTOM sits FLOOR_MARGIN*sprite above
  // the screen bottom — a pixel-consistent gap on any resolution (sprite center is
  // half a sprite above its bottom, plus the margin).
  floor() {
    const H = this.env.vh();
    return 1 - SPRITE_PX * (0.5 + FLOOR_MARGIN) / H;
  }
  // begin a rest cycle at the edge: cycles through random idle activities (sleeping,
  // coding, coffee, music…) instead of only sleeping. `wanderNext` is reused as the
  // current activity's duration while resting.
  startRest(p, first) {
    p.state = first ?? randIdle();
    p.wanderNext = rand(6, 14);
    p.restT = 0;
    p.t = 0;
    p.frameAcc = 0;
  }
  // deterministic sleeping slot so pets lie down side by side (ranked by owner id),
  // all lined up on the left edge instead of overlapping.
  sleepX(p) {
    const owners = [...this.pets.keys()].sort();
    const rank = Math.max(0, owners.indexOf(p.owner));
    return 0.05 + rank * 0.055;
  }
  lastSnapSent = /* @__PURE__ */ new Map();
  lastCursorSent = 0;
  // Ghost-cursor visibility: an explicit shown/hidden flag broadcast to others.
  // show() is immediate; hide() waits HIDE_MS so it never flickers. Driven each
  // frame by whether I'm DIRECTLY interacting (clicking a pet / a pet on my cursor).
  static HIDE_MS = 3e3;
  cursorShown = false;
  hideAt = 0;
  showCursor() {
    this.cursorShown = true;
    this.hideAt = 0;
  }
  hideCursor(now) {
    if (this.cursorShown && this.hideAt === 0) this.hideAt = now + _Sim.HIDE_MS;
  }
  // Am I directly interacting? clicking a pet, or a pet is clinging to MY cursor.
  // Owning a pet that dangles on someone ELSE does NOT count — that's their turn.
  tickCursor(now) {
    let interacting = this.charging;
    for (const p of this.pets.values()) {
      if (p.controller === this.me && (p.state === "held" || p.state === "oncursor" && p.target === this.me))
        interacting = true;
    }
    if (interacting) this.showCursor();
    else this.hideCursor(now);
    if (this.hideAt && now >= this.hideAt) {
      this.cursorShown = false;
      this.hideAt = 0;
    }
  }
  setMe(id, name, char) {
    this.me = id;
    this.myName = name;
    this.myChar = char;
  }
  blank(owner, name, character, controller) {
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
      buf: []
    };
  }
  // --- ingest from server -------------------------------------------------
  applySnap(s, now) {
    if (!this.me) return;
    let p = this.pets.get(s.owner);
    if (!p) {
      p = this.blank(s.owner, s.name, s.character, s.controller);
      this.pets.set(s.owner, p);
    }
    if (p.controller === this.me && s.controller !== this.me) {
      const justGrabbed = now - (this.claimedAt.get(s.owner) ?? -Infinity) < 800;
      const ownerReclaim = s.controller === s.owner && !justGrabbed;
      if (!ownerReclaim) return;
    }
    const prevController = p.controller;
    p.name = s.name;
    p.character = s.character;
    p.controller = s.controller;
    p.state = s.state;
    p.vx = s.vx;
    p.vy = s.vy;
    p.grip = s.grip;
    const newHealth = s.health ?? 1;
    if (newHealth < p.health - 1e-6) this.game?.onDamaged?.(s.owner, now);
    p.health = newHealth;
    p.target = s.target;
    p.lastSnap = now;
    if (p.controller !== prevController) p.buf.length = 0;
    if (s.controller === this.me) {
      p.x = s.x;
      p.y = s.y;
      p.flip = s.flip;
      p.frame = s.frame;
    } else if (s.state === "gone") {
      p.buf.length = 0;
    } else {
      const last2 = p.buf[p.buf.length - 1];
      if (last2 && Math.hypot(s.x - last2.x, s.y - last2.y) > TELEPORT_DIST) p.buf.length = 0;
      p.buf.push({ t: now, x: s.x, y: s.y, flip: s.flip, frame: s.frame });
      while (p.buf.length > 2 && now - p.buf[0].t > BUF_MS) p.buf.shift();
    }
    if (p.state === "oncursor" && p.target === this.me && p.controller !== this.me) {
      p.controller = this.me;
      p.pcx = NaN;
      p.spd = 0;
      p.hold = 0;
      p.t = 0;
      this.claimedAt.set(p.owner, now);
      this.env.transport.claim(p.owner);
    }
  }
  onWorld(pets, now) {
    if (!this.me) return;
    for (const s of pets) if (s.owner !== this.me || !this.pets.has(this.me)) this.applySnap(s, now);
    if (!this.pets.has(this.me)) {
      const p = this.blank(this.me, this.myName, this.myChar, this.me);
      this.pets.set(this.me, p);
    }
    const present = new Set(pets.map((s) => s.owner));
    for (const owner of [...this.pets.keys()]) {
      if (owner !== this.me && !present.has(owner)) this.pets.delete(owner);
    }
  }
  onClaim(owner, controller) {
    const p = this.pets.get(owner);
    if (p) p.controller = controller;
  }
  onBump(owner, vx, vy) {
    const p = this.pets.get(owner);
    if (p && p.controller === this.me) {
      p.state = "thrown";
      p.placed = false;
      p.vx = vx;
      p.vy = vy;
      p.t = 0;
    }
  }
  onCursor(from, x, y, active, now) {
    const name = this.pets.get(from)?.name ?? "";
    this.cursors.set(from, { x, y, active, name, lastSeen: now });
  }
  // --- input --------------------------------------------------------------
  // Hit-test as a pixel CIRCLE sized to the actual sprite (SPRITE_PX), so it's
  // resolution/DPI-independent and isotropic (no aspect-distorted "padding").
  // `radiusPx` lets callers use a tight radius for grabbing and a generous one
  // for arming click-capture (which needs margin to beat toggle latency).
  petAt(px, py, radiusPx = SPRITE_PX * 0.64) {
    const W = this.env.vw();
    const H = this.env.vh();
    const cx = px * W;
    const cy = py * H;
    let best;
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
  grab(p) {
    p.controller = this.me;
    p.state = "held";
    p.offX = p.x - this.myCursor.x;
    p.offY = p.y - this.myCursor.y;
    p.vx = 0;
    p.vy = 0;
    this.claimedAt.set(p.owner, this.now);
    this.env.transport.claim(p.owner);
  }
  releaseHeld(p) {
    if (p.state !== "held") return;
    const sp = Math.hypot(p.vx, p.vy);
    if (!this.config.allowLeap || sp < GENTLE_RELEASE_SPEED) {
      p.vx = 0;
      p.vy = 0;
    } else if (sp > MAX_THROW) {
      p.vx = p.vx / sp * MAX_THROW;
      p.vy = p.vy / sp * MAX_THROW;
    }
    p.placed = true;
    p.lx = p.x;
    p.ly = p.y;
    p.state = "thrown";
    p.t = 0;
  }
  // send MY pet at a target: it runs to the edge, climbs, and leaps onto the cursor
  leap(target) {
    if (!this.config.allowLeap) return;
    const p = this.pets.get(this.me);
    if (!p || target === this.me) return;
    if (!this.pets.has(target)) return;
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
  step(dt, now) {
    this.now = now;
    this.reclaimOwnPet(now);
    for (const p of this.pets.values()) {
      if (p.controller === this.me) this.simulate(p, dt, now);
      else this.interpolate(p, now);
    }
    this.game?.stepWorld(dt, now);
    this.collide(now, dt);
    this.tickCursor(now);
    this.broadcast(now);
    this.broadcastCursor(now);
    for (const [id, c] of this.cursors) if (now - c.lastSeen > 1500) this.cursors.delete(id);
  }
  // I always own MY pet: if a friend grabbed/leapt it and then let it SETTLE (it's no
  // longer held/on-a-cursor/mid-throw), take control back. Otherwise a stale handoff
  // pins my pet on their client — the server rejects my snapshots (incl. health drops),
  // which silently breaks combat ("le pego y no le baja la vida"). Skipped while it's
  // actively being manipulated, so normal grab/throw social play still works.
  reclaimOwnPet(now) {
    const mine = this.pets.get(this.me);
    if (!mine || mine.controller === this.me || MANIPULATED.has(mine.state)) {
      this.ownStuckSince = 0;
      return;
    }
    if (this.ownStuckSince === 0) this.ownStuckSince = now;
    if (now - this.ownStuckSince < RECLAIM_AFTER) return;
    if (now - (this.claimedAt.get(this.me) ?? -Infinity) < 500) return;
    mine.controller = this.me;
    this.claimedAt.set(this.me, now);
    this.env.transport.claim(this.me);
    this.ownStuckSince = 0;
  }
  simulate(p, dt, now) {
    const FLOOR = this.floor();
    p.t += dt;
    switch (p.state) {
      case "walk": {
        p.frameAcc += dt;
        if (p.frameAcc > 0.12) {
          p.frameAcc = 0;
          p.frame ^= 1;
        }
        const sleepy = p.t > this.config.walkTime;
        const goal = sleepy ? this.sleepX(p) : p.wanderNext;
        const dir = goal > p.x ? 1 : -1;
        p.x += dir * WALK * dt;
        p.flip = dir < 0;
        p.y = FLOOR;
        if (Math.abs(p.x - goal) < 0.02) {
          if (sleepy) this.startRest(p);
          else p.wanderNext = rand(0.1, 0.9);
        }
        break;
      }
      case "play":
        this.game?.drivePet(p, dt, now);
        break;
      case "sleeping":
      case "coding":
      case "coffee":
      case "music":
      case "thinking": {
        p.y = FLOOR;
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
            const rest = p.restT;
            this.startRest(p, randIdle(p.state));
            p.restT = rest;
          }
        }
        break;
      }
      case "held": {
        const maxLift = MAX_LIFT_SPRITES * SPRITE_PX / this.env.vh();
        if (!this.config.allowLeap && p.y < FLOOR - maxLift) {
          this.releaseHeld(p);
          break;
        }
        const nx = this.myCursor.x + p.offX;
        const ny = this.myCursor.y + p.offY;
        const ivx = (nx - p.x) / Math.max(dt, 1e-3);
        const ivy = (ny - p.y) / Math.max(dt, 1e-3);
        const keep = 0.6;
        p.vx = p.vx * keep + ivx * (1 - keep);
        p.vy = p.vy * keep + ivy * (1 - keep);
        p.x = nx;
        p.y = ny;
        break;
      }
      case "oncursor": {
        const c = p.target === this.me ? this.myCursor : this.cursors.get(p.target);
        if (c) {
          const first = Number.isNaN(p.pcx);
          const dvx = first ? 0 : (c.x - p.pcx) / Math.max(dt, 1e-3);
          const dvy = first ? 0 : (c.y - p.pcy) / Math.max(dt, 1e-3);
          const sp = Math.hypot(dvx, dvy);
          p.vx = dvx;
          p.vy = dvy;
          p.pcx = c.x;
          p.pcy = c.y;
          p.spd = p.spd * 0.6 + sp * 0.4;
          p.x = c.x;
          p.y = c.y + 0.02;
          const decay = 5e-3 + 0.03 * Math.pow(p.spd, 1.8);
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
          p.state = "thrown";
          p.vy = -0.15;
          p.t = 0;
        }
        break;
      }
      case "leap": {
        const c = p.target === this.me ? this.myCursor : this.cursors.get(p.target);
        if (!c || !this.pets.has(p.target) || p.t > 4) {
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
        const edge = c.x < 0.5 ? 0.03 : 0.97;
        if (p.lphase === "run") {
          p.y = FLOOR;
          const dir = edge > p.x ? 1 : -1;
          p.vx = dir * this.config.runSpeed * 1.7;
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
            p.vx = (c.x - p.x) * 2.4;
            p.vy = -0.15;
          }
        } else {
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
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_THROW) {
          p.vx = p.vx / sp * MAX_THROW;
          p.vy = p.vy / sp * MAX_THROW;
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
        if (p.y >= FLOOR - 5e-3 && Math.abs(p.vy) < 0.12 && Math.abs(p.vx) < 0.06) {
          const gentle = p.placed && Math.hypot(p.x - p.lx, p.y - p.ly) < GENTLE_DIST;
          p.placed = false;
          p.spin = 0;
          p.vx = 0;
          p.vy = 0;
          p.y = FLOOR;
          p.t = 0;
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
        p.t += dt;
        if (p.t > rand(4, 9)) {
          const left = Math.random() < 0.5;
          p.x = left ? -0.05 : 1.05;
          p.y = FLOOR;
          p.wanderNext = rand(0.2, 0.8);
          p.state = "walk";
          p.health = 1;
          p.t = 0;
        }
        break;
      }
    }
  }
  // Entity interpolation for pets someone else controls: render at (now - INTERP_DELAY)
  // by lerping between the two buffered snapshots that bracket that instant. This is
  // smooth and never overshoots (we only ever move between positions that really
  // happened), replacing the old extrapolate-then-snap dead reckoning that rubber-banded.
  interpolate(p, now) {
    const buf = p.buf;
    if (buf.length === 0) return;
    const renderT = now - INTERP_DELAY;
    if (buf.length < 2 || renderT <= buf[0].t) {
      const s = buf[0];
      p.x = s.x;
      p.y = s.y;
      p.flip = s.flip;
      p.frame = s.frame;
      return;
    }
    for (let i = buf.length - 1; i >= 1; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (a.t <= renderT && renderT <= b.t) {
        const span = b.t - a.t || 1;
        const u = Math.max(0, Math.min(1, (renderT - a.t) / span));
        p.x = a.x + (b.x - a.x) * u;
        p.y = a.y + (b.y - a.y) * u;
        p.flip = u < 0.5 ? a.flip : b.flip;
        p.frame = u < 0.5 ? a.frame : b.frame;
        return;
      }
    }
    const last2 = buf[buf.length - 1];
    p.x = last2.x;
    p.y = last2.y;
    p.flip = last2.flip;
    p.frame = last2.frame;
  }
  collide(now, dt) {
    const W = this.env.vw();
    const H = this.env.vh();
    for (const a of this.pets.values()) {
      if (a.controller !== this.me) continue;
      const moving = a.state === "thrown" || a.state === "oncursor";
      if (!moving) continue;
      if (now - a.hitAt < 250) continue;
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
          a.hitAt = now;
          a.state = "thrown";
          a.placed = false;
          a.vx = nx * K;
          a.vy = ny * K - 0.2;
          a.t = 0;
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
  broadcast(now) {
    for (const p of this.pets.values()) {
      if (p.controller !== this.me) continue;
      const last2 = this.lastSnapSent.get(p.owner) ?? 0;
      const interval = p.state === "play" ? SNAP_MS_MATCH : SNAP_MS;
      if (now - last2 < interval) continue;
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
        target: p.target
      });
    }
  }
  broadcastCursor(now) {
    if (now - this.lastCursorSent < CURSOR_MS) return;
    this.lastCursorSent = now;
    this.env.transport.cursor(this.myCursor.x, this.myCursor.y, this.cursorShown);
  }
  pose(p) {
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
};

// src/game/config.ts
var GAME = {
  moveSpeed: 0.36,
  // horizontal move speed while controlled (normalized/s)
  gravity: 1.9,
  // gentler than the social-world gravity -> floatier, readable jumps
  canJump: true,
  // flag: allow the in-combat jump (Up). Flip to false to disable later.
  jumpSprites: 0.8,
  // jump apex height, in sprite-heights — a small hop (px-consistent)
  idleRelease: 5,
  // seconds of no input before control auto-releases into rest
  // --- Hollow-Knight-style nail (melee) ---
  swingCooldown: 0.3,
  // seconds between normal nail swings
  artCooldown: 0.7,
  // longer cooldown after a charged Art
  chargeTime: 0.5,
  // hold Space this long to charge a Nail Art (else it's a normal swing)
  dashDist: 0.09,
  // Corte Veloz (Dash Slash) forward lunge (normalized x)
  pogoSprites: 1.7,
  // apex of the down-attack (pogo) bounce, in sprite-heights
  clashKnockback: 0.018,
  // normalized x shove when two nails clash (parry)
  stunMs: 260,
  // brief input-lock after being hit
  clashStunMs: 120,
  // even briefer lock after a clash (parry) — recover fast
  // per-move geometry & damage. reach/radius in sprite-fractions, damage in health,
  // knockback in normalized x, duration in seconds. radial = hits all around (cyclone).
  arts: {
    nail: { reach: 0.9, radius: 0.6, damage: 0.2, knockback: 0.02, duration: 0.16, radial: false },
    great: { reach: 1.4, radius: 0.9, damage: 0.4, knockback: 0.05, duration: 0.26, radial: false },
    cyclone: { reach: 0, radius: 1.25, damage: 0.34, knockback: 0.04, duration: 0.42, radial: true },
    dash: { reach: 1.2, radius: 0.78, damage: 0.3, knockback: 0.045, duration: 0.2, radial: false }
  }
};

// src/game/sound.ts
var ctx = null;
var master = null;
var volume = 0.6;
function ac() {
  if (ctx) return ctx;
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}
function tone(freq, dur, type, peak, glideTo) {
  const c = ac();
  if (!c || !master || volume <= 0) return;
  const t = c.currentTime;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(1e-4, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 6e-3);
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function noise(dur, freq, peak, q = 0.8) {
  const c = ac();
  if (!c || !master || volume <= 0) return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}
var sfx = {
  swing: () => noise(0.12, 1500, 0.22),
  // whoosh
  art: () => {
    noise(0.24, 800, 0.4);
    tone(180, 0.28, "sawtooth", 0.18, 90);
  },
  hit: () => {
    tone(130, 0.16, "sine", 0.5, 70);
    noise(0.08, 320, 0.28);
  },
  clash: () => {
    tone(2300, 0.13, "triangle", 0.32);
    tone(3300, 0.1, "square", 0.14);
  },
  ready: () => tone(880, 0.12, "sine", 0.18),
  // charge fully loaded
  enemySwing: () => noise(0.1, 1100, 0.1)
  // faint — the opponent swung
};

// src/game/types.ts
function newPlayer() {
  return { stunUntil: 0, attackCdAt: 0 };
}

// src/game/engine.ts
var GameEngine = class {
  constructor(sim) {
    this.sim = sim;
  }
  input = { left: false, right: false, up: false, down: false };
  slashes = [];
  armed = false;
  // placed & sleeping, holding keyboard focus, waiting for the first key
  controlling = false;
  // am I keyboard-controlling MY pet right now
  players = /* @__PURE__ */ new Map();
  // perf-ms until which to FLASH a pet I just landed a hit on (attacker-side feedback,
  // since the victim applies the damage remotely). Keyed by victim owner.
  flashUntil = /* @__PURE__ */ new Map();
  seq = 0;
  chargeStartAt = null;
  // perf-ms the attack key went down (charging)
  chargeReadyPinged = false;
  player(owner) {
    let ps = this.players.get(owner);
    if (!ps) this.players.set(owner, ps = newPlayer());
    return ps;
  }
  get active() {
    return this.controlling;
  }
  // whether to flash a pet: my own pet while stunned, or any pet observed taking damage
  isStunned(owner, now) {
    const ps = this.players.get(owner);
    if (ps && now < ps.stunUntil) return true;
    return now < (this.flashUntil.get(owner) ?? 0);
  }
  // A pet really took damage (its health dropped on an incoming snapshot). This is the
  // ONLY place peer hit-feedback fires, so the flash + sound are always in lockstep with
  // actual damage — no more "se ve el golpe pero no baja la vida".
  onDamaged(owner, now) {
    this.flashUntil.set(owner, now + GAME.stunMs);
    sfx.hit();
  }
  // 0..1 nail-art charge progress for MY pet (drives the glow in PetView)
  chargeLevel(now) {
    if (this.chargeStartAt == null) return 0;
    return Math.min(1, (now - this.chargeStartAt) / (GAME.chargeTime * 1e3));
  }
  // --- lifecycle -----------------------------------------------------------
  // Gentle placement -> ARM: the pet enters combat mode NOW (state "play", holding its
  // nail, standing ready) but I'm not controlling it yet — it just waits, keyboard
  // focused, for the first key. It does NOT fall back into the sleeping/idle cycle, so
  // it always reads as "ready to fight", never "stuck sleeping/working".
  arm() {
    const p = this.sim.pets.get(this.sim.me);
    if (!p) return;
    this.armed = true;
    this.controlling = false;
    this.chargeStartAt = null;
    p.controller = this.sim.me;
    p.state = "sleeping";
    p.vx = 0;
    p.vy = 0;
    p.grip = 0;
    p.health = 1;
    p.t = 0;
    p.frameAcc = 0;
    const ps = this.player(this.sim.me);
    ps.stunUntil = 0;
    ps.attackCdAt = 0;
    this.sim.env.transport.claim(p.owner);
    this.sim.env.transport.arm();
  }
  armOnPlace(_p) {
    this.arm();
  }
  // first key while armed (or resuming from an idle pause) -> take control.
  enter() {
    const p = this.sim.pets.get(this.sim.me);
    if (!p) return;
    this.armed = false;
    this.controlling = true;
    this.chargeStartAt = null;
    p.controller = this.sim.me;
    p.state = "play";
    p.t = 0;
    this.sim.env.transport.focus();
  }
  // fully exit combat -> back to the social world (sleep/walk). Drag/Escape/click/blur.
  leave() {
    const wasCombat = this.controlling || this.armed;
    this.controlling = false;
    this.armed = false;
    this.chargeStartAt = null;
    this.input = { left: false, right: false, up: false, down: false };
    const p = this.sim.pets.get(this.sim.me);
    if (p && wasCombat) {
      p.health = 1;
      this.sim.startRest(p);
    }
  }
  // --- PetController: motion of play-state pets (called from the Sim loop) --
  drivePet(p, dt, now) {
    const FLOOR = this.sim.floor();
    const grounded = p.y >= FLOOR - 1e-3;
    const ps = this.player(p.owner);
    const stunned = now < ps.stunUntil;
    if (stunned) this.chargeStartAt = null;
    let moving = false;
    if (!stunned) {
      if (this.input.left) {
        p.x -= GAME.moveSpeed * dt;
        p.flip = true;
        moving = true;
      }
      if (this.input.right) {
        p.x += GAME.moveSpeed * dt;
        p.flip = false;
        moving = true;
      }
    }
    p.x = Math.max(0.03, Math.min(0.97, p.x));
    if (GAME.canJump && this.input.up && grounded && !stunned) {
      const apex = GAME.jumpSprites * SPRITE_PX / this.sim.env.vh();
      p.vy = -Math.sqrt(2 * GAME.gravity * apex);
    }
    p.vy += GAME.gravity * dt;
    p.y += p.vy * dt;
    if (p.y > FLOOR) {
      p.y = FLOOR;
      p.vy = 0;
    }
    p.vx = moving ? p.flip ? -GAME.moveSpeed : GAME.moveSpeed : 0;
    p.grip = 0;
    if (this.chargeStartAt != null && !this.chargeReadyPinged && now - this.chargeStartAt >= GAME.chargeTime * 1e3) {
      this.chargeReadyPinged = true;
      sfx.ready();
    }
    if (moving) {
      p.frameAcc += dt;
      if (p.frameAcc > 0.1) {
        p.frameAcc = 0;
        p.frame ^= 1;
      }
    }
    const busy = moving || this.input.up || !grounded || stunned || this.chargeStartAt != null || this.slashes.some((s) => s.owner === p.owner);
    if (busy) p.t = 0;
    if (p.t > GAME.idleRelease) {
      this.controlling = false;
      this.armed = true;
      this.chargeStartAt = null;
      p.state = "sleeping";
      p.frameAcc = 0;
    }
  }
  predictPet(p, dt) {
    p.vy += GAME.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const f = this.sim.floor();
    if (p.y > f) {
      p.y = f;
      p.vy = 0;
    }
    if (p.vx !== 0) {
      p.frameAcc += dt;
      if (p.frameAcc > 0.1) {
        p.frameAcc = 0;
        p.frame ^= 1;
      }
    }
  }
  // --- combat: attack key down starts a charge, key up swings -------------
  // A quick tap -> normal aguijonazo (direction from the held arrow). Holding past
  // GAME.chargeTime and releasing -> a Nail Art chosen by the held direction:
  //   Down -> Corte Ciclón (radial) | Left/Right -> Corte Veloz (dash) | else Gran Corte.
  startCharge() {
    if (!this.controlling) return;
    const p = this.sim.pets.get(this.sim.me);
    if (!p || p.state !== "play") return;
    const now = performance.now();
    if (now < this.player(p.owner).stunUntil) return;
    this.chargeStartAt = now;
    this.chargeReadyPinged = false;
  }
  releaseCharge() {
    if (this.chargeStartAt == null) return;
    const now = performance.now();
    const held = now - this.chargeStartAt;
    this.chargeStartAt = null;
    this.chargeReadyPinged = false;
    const p = this.sim.pets.get(this.sim.me);
    if (!p || p.state !== "play") return;
    const ps = this.player(p.owner);
    if (now < ps.stunUntil || now < ps.attackCdAt) return;
    const grounded = p.y >= this.sim.floor() - 0.02;
    const opp = this.nearestOpponent(p);
    let art;
    let dir;
    if (held >= GAME.chargeTime * 1e3) {
      art = this.input.down ? "cyclone" : this.input.left || this.input.right ? "dash" : "great";
      if (art !== "cyclone" && opp) p.flip = opp.x < p.x;
      dir = p.flip ? "left" : "right";
    } else {
      art = "nail";
      if (this.input.up) dir = "up";
      else if (this.input.down && !grounded) dir = "down";
      else {
        if (opp) p.flip = opp.x < p.x;
        dir = p.flip ? "left" : "right";
      }
    }
    this.swing(p, ps, art, dir, now);
  }
  // nearest opponent pet within melee-ish range (to auto-face a swing), else undefined
  nearestOpponent(p) {
    let best;
    let bd = Infinity;
    for (const q of this.sim.pets.values()) {
      if (q.owner === p.owner || q.state === "gone") continue;
      const d = Math.abs(q.x - p.x);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return bd < 0.25 ? best : void 0;
  }
  swing(p, ps, art, dir, now) {
    ps.attackCdAt = now + (art === "nail" ? GAME.swingCooldown : GAME.artCooldown) * 1e3;
    const a = GAME.arts[art];
    if (art === "dash") {
      const d = p.flip ? -1 : 1;
      p.x = Math.max(0.03, Math.min(0.97, p.x + d * GAME.dashDist));
    }
    const s = {
      id: `${this.sim.me}:${++this.seq}`,
      owner: this.sim.me,
      kind: art,
      dir,
      reach: a.reach,
      radius: a.radius,
      damage: a.damage,
      knockback: a.knockback,
      radial: a.radial,
      duration: a.duration,
      t: 0,
      dead: false,
      clashed: false,
      hitDone: false,
      cx: 0,
      cy: 0
    };
    this.slashes.push(s);
    this.sim.env.transport.game({
      kind: "slash",
      owner: this.sim.me,
      art,
      dir,
      reach: a.reach,
      radius: a.radius,
      damage: a.damage,
      knockback: a.knockback,
      radial: a.radial,
      duration: a.duration,
      x: p.x,
      y: p.y
    });
    if (art === "nail") sfx.swing();
    else sfx.art();
    p.t = 0;
  }
  center(s, p, W, H) {
    const reach = SPRITE_PX * s.reach;
    let cx = p.x * W;
    let cy = p.y * H;
    if (s.radial) return { cx, cy };
    if (s.dir === "left") cx -= reach;
    else if (s.dir === "right") cx += reach;
    else if (s.dir === "up") cy -= reach;
    else cy += reach;
    return { cx, cy };
  }
  stepWorld(dt, now) {
    if (!this.slashes.length) return;
    const W = this.sim.env.vw();
    const H = this.sim.env.vh();
    const bodyR = SPRITE_PX * 0.45 + SPRITE_PX * 0.3;
    for (const s of this.slashes) {
      s.t += dt;
      const owner = this.sim.pets.get(s.owner);
      if (!owner || owner.state === "gone" || s.t > s.duration) {
        s.dead = true;
        continue;
      }
      const c = this.center(s, owner, W, H);
      s.cx = c.cx;
      s.cy = c.cy;
    }
    const myPet = this.sim.pets.get(this.sim.me);
    for (const s of this.slashes) {
      if (s.dead || s.hitDone || s.owner !== this.sim.me || !myPet) continue;
      let didClash = false;
      for (const o of this.slashes) {
        if (o.dead || o.owner === s.owner) continue;
        if (Math.hypot(s.cx - o.cx, s.cy - o.cy) < (s.radius + o.radius) * SPRITE_PX) {
          s.clashed = true;
          o.clashed = true;
          s.hitDone = true;
          sfx.clash();
          this.recoil(s, now);
          didClash = true;
          break;
        }
      }
      if (didClash) continue;
      for (const q of this.sim.pets.values()) {
        if (q.owner === s.owner || q.state === "gone") continue;
        if (Math.hypot(s.cx - q.x * W, s.cy - q.y * H) < s.radius * SPRITE_PX + bodyR) {
          s.hitDone = true;
          const dir = q.x < myPet.x ? -1 : 1;
          this.sim.env.transport.game({ kind: "hit", target: q.owner, damage: s.damage, knockback: s.knockback, dir });
          if (s.dir === "down" && myPet.y < this.sim.floor() - 0.02) myPet.vy = -this.pogoVel(H);
          break;
        }
      }
    }
    this.slashes = this.slashes.filter((s) => !s.dead);
  }
  // apply a hit dealt to MY pet by an opponent (attacker-authoritative). Works even
  // when I'm NOT in a match: an un-controlled pet is a punching bag — it takes hits
  // and loses health until it's KO'd (then it stumbles off and respawns full).
  takeHit(damage, knockback, dir) {
    const me = this.sim.pets.get(this.sim.me);
    if (!me || me.state === "gone") return;
    const now = performance.now();
    const ps = this.player(this.sim.me);
    if (now < ps.stunUntil) return;
    ps.stunUntil = now + GAME.stunMs;
    me.health = Math.max(0, me.health - damage);
    if (me.health <= 1e-6) me.health = 0;
    me.x = Math.max(0.03, Math.min(0.97, me.x + dir * knockback));
    me.vy = -Math.sqrt(2 * GAME.gravity * (SPRITE_PX * 0.25) / this.sim.env.vh());
    sfx.hit();
    if (me.health === 0) this.knockout(me);
  }
  pogoVel(H) {
    return Math.sqrt(2 * GAME.gravity * (GAME.pogoSprites * SPRITE_PX) / H);
  }
  recoil(a, now) {
    const me = this.sim.pets.get(this.sim.me);
    if (!me || me.state !== "play") return;
    const H = this.sim.env.vh();
    if (a.dir === "down" && me.y < this.sim.floor() - 0.02) {
      me.vy = -this.pogoVel(H);
      return;
    }
    const kb = a.dir === "left" ? 1 : a.dir === "right" ? -1 : 0;
    me.x = Math.max(0.03, Math.min(0.97, me.x + kb * GAME.clashKnockback));
    me.vy = -Math.sqrt(2 * GAME.gravity * (SPRITE_PX * 0.18) / H);
    this.player(this.sim.me).stunUntil = now + GAME.clashStunMs;
  }
  knockout(me) {
    this.controlling = false;
    this.armed = false;
    this.chargeStartAt = null;
    this.input = { left: false, right: false, up: false, down: false };
    me.state = "dizzy";
    me.vx = 0;
    me.vy = 0;
    me.spin = 0;
    me.t = 0;
  }
  onPeerEvent(_from, data) {
    if (!data) return;
    if (data.kind === "slash") {
      this.slashes.push({
        id: `${data.owner}:${++this.seq}`,
        owner: data.owner,
        kind: data.art,
        dir: data.dir,
        reach: data.reach,
        radius: data.radius,
        damage: data.damage,
        knockback: data.knockback,
        radial: data.radial,
        duration: data.duration,
        t: 0,
        dead: false,
        clashed: false,
        hitDone: false,
        cx: 0,
        cy: 0
      });
      sfx.enemySwing();
    } else if (data.kind === "hit" && data.target === this.sim.me) {
      this.takeHit(data.damage, data.knockback, data.dir);
    }
  }
};

// tools/drag-repro.ts
var URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8799/ws";
function makeClient(id) {
  const ws = new WebSocket(URL);
  const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  const env = {
    vw: () => 1920,
    vh: () => 1080,
    transport: { claim: (o) => send({ type: "claim", owner: o }), snap: (s) => send({ type: "snap", snap: s }), cursor: (x, y, active) => send({ type: "cursor", x, y, active }), bump: (o, vx, vy) => send({ type: "bump", owner: o, vx, vy }), game: (d) => send({ type: "game", data: d }), focus() {
    }, arm() {
    } }
  };
  const sim = new Sim(env);
  sim.game = new GameEngine(sim);
  sim.setMe(id, id, "gato");
  ws.on("open", () => send({ type: "hello", id, name: id, character: "gato" }));
  ws.on("message", (b) => {
    let m;
    try {
      m = JSON.parse(b.toString());
    } catch {
      return;
    }
    const now = performance.now();
    if (m.type === "world") sim.onWorld(m.pets, now);
    else if (m.type === "peerSnap") sim.applySnap(m.snap, now);
    else if (m.type === "peerClaim") sim.onClaim(m.owner, m.controller);
    else if (m.type === "peerCursor") sim.onCursor(m.from, m.x, m.y, m.active, now);
    else if (m.type === "peerBump") sim.onBump(m.owner, m.vx, m.vy);
  });
  return { ws, sim };
}
var A = makeClient("repro-a");
var B = makeClient("repro-b");
var last = performance.now();
var FIXED = 1 / 60;
var accA = 0;
var accB = 0;
setInterval(() => {
  const t = performance.now();
  const dt = Math.min((t - last) / 1e3, 0.25);
  last = t;
  accA += dt;
  while (accA >= FIXED) {
    A.sim.step(FIXED, t);
    accA -= FIXED;
  }
  accB += dt;
  while (accB >= FIXED) {
    B.sim.step(FIXED, t);
    accB -= FIXED;
  }
}, 1e3 / 60);
var grabbed = false;
var lostAt = -1;
var followSamples = 0;
var followOk = 0;
setTimeout(() => {
  const bPet = A.sim.pets.get("repro-b");
  if (!bPet) {
    console.log("!! A no ve a B");
    process.exit(1);
  }
  A.sim.myCursor.x = bPet.x;
  A.sim.myCursor.y = bPet.y;
  A.sim.grab(bPet);
  grabbed = true;
  let k = 0;
  const drag = setInterval(() => {
    A.sim.myCursor.x = Math.min(0.9, A.sim.myCursor.x + 8e-3);
    if (++k >= 200) clearInterval(drag);
  }, 1e3 / 60);
}, 1200);
var mon = setInterval(() => {
  if (!grabbed) return;
  const a = A.sim.pets.get("repro-b");
  if (a.controller !== "repro-a" && lostAt < 0) lostAt = A.sim.myCursor.x;
  followSamples++;
  if (Math.abs(a.x - A.sim.myCursor.x) < 0.06) followOk++;
}, 1e3 / 60);
setTimeout(() => {
  clearInterval(mon);
  const held = A.sim.pets.get("repro-b").controller === "repro-a";
  console.log(`grab held to end: ${held ? "YES \u2705" : "NO \u274C (lost at cursor x=" + lostAt.toFixed(2) + ")"}   follow-cursor: ${followSamples ? Math.round(100 * followOk / followSamples) : 0}%`);
  process.exit(0);
}, 5200);
