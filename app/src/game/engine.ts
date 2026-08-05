import { SPRITE_PX, type Pet, type Sim, type PetController } from "../pet/sim";
import { GAME } from "./config";
import { sfx } from "./sound";
import { newPlayer, type Slash, type SlashDir, type ArtKind, type GameEvent, type PlayerState } from "./types";

// The minigame: a Hollow-Knight-style nail duel layered on the shared pet world.
// While a pet is "in a match" (pet.state === "play") the engine drives its motion and
// owns the combat: directional nail swings (aguijonazo / corte superior / pogo), three
// charged Nail Arts (Gran Corte / Corte Ciclón / Corte Veloz), a CLASH/parry when two
// swings collide, and health (which lives on the Pet so both players see the bar). The
// pet's motion still travels as an ordinary pet snapshot; only game EVENTS (a swing)
// ride the generic relay. Each client judges hits against the pets IT controls, so
// each player decides its own damage/clash — latency-tolerant.
export class GameEngine implements PetController {
  input = { left: false, right: false, up: false, down: false };
  slashes: Slash[] = [];
  armed = false; // placed & sleeping, holding keyboard focus, waiting for the first key
  private controlling = false; // am I keyboard-controlling MY pet right now
  private players = new Map<string, PlayerState>();
  // perf-ms until which to FLASH a pet I just landed a hit on (attacker-side feedback,
  // since the victim applies the damage remotely). Keyed by victim owner.
  private flashUntil = new Map<string, number>();
  private seq = 0;
  private chargeStartAt: number | null = null; // perf-ms the attack key went down (charging)
  private chargeReadyPinged = false;

  constructor(private sim: Sim) {}

  private player(owner: string): PlayerState {
    let ps = this.players.get(owner);
    if (!ps) this.players.set(owner, (ps = newPlayer()));
    return ps;
  }

  get active(): boolean {
    return this.controlling;
  }

  // whether to flash a pet: my own pet while stunned, or any pet observed taking damage
  isStunned(owner: string, now: number): boolean {
    const ps = this.players.get(owner);
    if (ps && now < ps.stunUntil) return true;
    return now < (this.flashUntil.get(owner) ?? 0);
  }

  // A pet really took damage (its health dropped on an incoming snapshot). This is the
  // ONLY place peer hit-feedback fires, so the flash + sound are always in lockstep with
  // actual damage — no more "se ve el golpe pero no baja la vida".
  onDamaged(owner: string, now: number) {
    this.flashUntil.set(owner, now + GAME.stunMs);
    sfx.hit();
  }

  // 0..1 nail-art charge progress for MY pet (drives the glow in PetView)
  chargeLevel(now: number): number {
    if (this.chargeStartAt == null) return 0;
    return Math.min(1, (now - this.chargeStartAt) / (GAME.chargeTime * 1000));
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
    p.state = "sleeping"; // nap while waiting — the FIRST key starts the match
    p.vx = 0;
    p.vy = 0;
    p.grip = 0;
    p.health = 1; // fresh match starts at full health
    p.t = 0;
    p.frameAcc = 0;
    const ps = this.player(this.sim.me);
    ps.stunUntil = 0;
    ps.attackCdAt = 0;
    this.sim.env.transport.claim(p.owner);
    this.sim.env.transport.arm(); // keyboard focus, mouse still passes through
  }

  armOnPlace(_p: Pet) {
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
    this.sim.env.transport.focus(); // now capture the mouse too (drag exits play)
  }

  // fully exit combat -> back to the social world (sleep/walk). Drag/Escape/click/blur.
  leave() {
    const wasCombat = this.controlling || this.armed;
    this.controlling = false;
    this.armed = false;
    this.chargeStartAt = null;
    this.input = { left: false, right: false, up: false, down: false };
    const p = this.sim.pets.get(this.sim.me);
    // return to a normal (cycling) social rest — this also un-freezes the armed nap.
    if (p && wasCombat) {
      p.health = 1; // fully heal on leaving combat (no lingering damaged bar in social)
      this.sim.startRest(p);
    }
  }

  // --- PetController: motion of play-state pets (called from the Sim loop) --
  drivePet(p: Pet, dt: number, now: number) {
    const FLOOR = this.sim.floor();
    const grounded = p.y >= FLOOR - 0.001;
    const ps = this.player(p.owner);
    const stunned = now < ps.stunUntil;
    if (stunned) this.chargeStartAt = null; // getting hit cancels a charge
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
    // Jump (Up): always available while in combat, gated only by the GAME.canJump flag.
    if (GAME.canJump && this.input.up && grounded && !stunned) {
      const apex = (GAME.jumpSprites * SPRITE_PX) / this.sim.env.vh();
      p.vy = -Math.sqrt(2 * GAME.gravity * apex);
    }
    p.vy += GAME.gravity * dt;
    p.y += p.vy * dt;
    if (p.y > FLOOR) {
      p.y = FLOOR;
      p.vy = 0;
    }
    p.vx = moving ? (p.flip ? -GAME.moveSpeed : GAME.moveSpeed) : 0; // for viewer extrapolation
    p.grip = 0;
    // ping once when a charge finishes loading (so the player knows an Art is ready)
    if (this.chargeStartAt != null && !this.chargeReadyPinged && now - this.chargeStartAt >= GAME.chargeTime * 1000) {
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
    const busy =
      moving ||
      this.input.up ||
      !grounded ||
      stunned ||
      this.chargeStartAt != null ||
      this.slashes.some((s) => s.owner === p.owner);
    if (busy) p.t = 0; // reset the idle timer while doing anything
    // idle too long -> pause into a nap (armed, focused, health kept); a key resumes.
    // Fully exiting to the social world is only via drag / Escape / click / blur.
    if (p.t > GAME.idleRelease) {
      this.controlling = false;
      this.armed = true;
      this.chargeStartAt = null;
      p.state = "sleeping";
      p.frameAcc = 0;
    }
  }

  predictPet(p: Pet, dt: number) {
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
    // face the nearest opponent for horizontal swings, so a casual attack connects even
    // if I last walked the other way (melee auto-aim). Up/down/cyclone keep their axis.
    const opp = this.nearestOpponent(p);
    let art: ArtKind;
    let dir: SlashDir;
    if (held >= GAME.chargeTime * 1000) {
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
  private nearestOpponent(p: Pet): Pet | undefined {
    let best: Pet | undefined;
    let bd = Infinity;
    for (const q of this.sim.pets.values()) {
      if (q.owner === p.owner || q.state === "gone") continue;
      const d = Math.abs(q.x - p.x);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return bd < 0.25 ? best : undefined;
  }

  private swing(p: Pet, ps: PlayerState, art: ArtKind, dir: SlashDir, now: number) {
    ps.attackCdAt = now + (art === "nail" ? GAME.swingCooldown : GAME.artCooldown) * 1000;
    const a = GAME.arts[art];
    if (art === "dash") {
      const d = p.flip ? -1 : 1; // lunge forward
      p.x = Math.max(0.03, Math.min(0.97, p.x + d * GAME.dashDist));
    }
    const s: Slash = {
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
      cy: 0,
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
      y: p.y,
    });
    if (art === "nail") sfx.swing();
    else sfx.art();
    p.t = 0;
  }

  private center(s: Slash, p: Pet, W: number, H: number) {
    const reach = SPRITE_PX * s.reach;
    let cx = p.x * W;
    let cy = p.y * H;
    if (s.radial) return { cx, cy }; // cyclone stays centered on the pet
    if (s.dir === "left") cx -= reach;
    else if (s.dir === "right") cx += reach;
    else if (s.dir === "up") cy -= reach;
    else cy += reach;
    return { cx, cy };
  }

  stepWorld(dt: number, now: number) {
    if (!this.slashes.length) return;
    const W = this.sim.env.vw();
    const H = this.sim.env.vh();
    // body radius + a forgiveness margin: the opponent's position is a ~45ms-old
    // snapshot (dead-reckoned), so a tight window drops hits on small desync. The
    // margin keeps close swings connecting.
    const bodyR = SPRITE_PX * 0.45 + SPRITE_PX * 0.3;

    // advance ages, recompute centers, cull expired / orphaned
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

    // Resolve MY OWN swings (attacker-authoritative) against opponents. A swing
    // connects at most once (hitDone).
    const myPet = this.sim.pets.get(this.sim.me);
    for (const s of this.slashes) {
      if (s.dead || s.hitDone || s.owner !== this.sim.me || !myPet) continue;

      // 1) CLASH (parry): my swing overlapping an opponent's active swing. Both sides
      // detect this locally (each has both swings), so both recoil — no event needed.
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

      // 2) HIT: my swing overlapping an opponent's BODY -> tell them (they apply it).
      for (const q of this.sim.pets.values()) {
        if (q.owner === s.owner || q.state === "gone") continue;
        if (Math.hypot(s.cx - q.x * W, s.cy - q.y * H) < s.radius * SPRITE_PX + bodyR) {
          s.hitDone = true;
          const dir = q.x < myPet.x ? -1 : 1; // shove the victim away from me
          this.sim.env.transport.game({ kind: "hit", target: q.owner, damage: s.damage, knockback: s.knockback, dir });
          // NOTE: no optimistic flash/sound here — feedback fires when the victim's health
          // actually drops (Sim.applySnap -> onDamaged), so a "hit" can't show without damage.
          // attacker pogo: a connecting down-swing while airborne bounces me up
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
  private takeHit(damage: number, knockback: number, dir: number) {
    const me = this.sim.pets.get(this.sim.me);
    if (!me || me.state === "gone") return;
    const now = performance.now();
    const ps = this.player(this.sim.me);
    if (now < ps.stunUntil) return; // brief i-frames — one hit per stun window
    ps.stunUntil = now + GAME.stunMs;
    // gradual per-hit damage whether or not I'm actively fighting — pestering a passive
    // pet knocks it around and wears it down (matches the bot), no one-shot grief.
    me.health = Math.max(0, me.health - damage);
    if (me.health <= 1e-6) me.health = 0; // snap float residue so KO fires on the hit that empties it
    me.x = Math.max(0.03, Math.min(0.97, me.x + dir * knockback));
    me.vy = -Math.sqrt((2 * GAME.gravity * (SPRITE_PX * 0.25)) / this.sim.env.vh());
    sfx.hit();
    if (me.health === 0) this.knockout(me); // -> dizzy -> flee -> respawn at full health
  }

  private pogoVel(H: number) {
    return Math.sqrt((2 * GAME.gravity * (GAME.pogoSprites * SPRITE_PX)) / H);
  }

  private recoil(a: Slash, now: number) {
    const me = this.sim.pets.get(this.sim.me);
    if (!me || me.state !== "play") return;
    const H = this.sim.env.vh();
    if (a.dir === "down" && me.y < this.sim.floor() - 0.02) {
      me.vy = -this.pogoVel(H); // clashing a down-swing pogos me up
      return;
    }
    const kb = a.dir === "left" ? 1 : a.dir === "right" ? -1 : 0;
    me.x = Math.max(0.03, Math.min(0.97, me.x + kb * GAME.clashKnockback));
    me.vy = -Math.sqrt((2 * GAME.gravity * (SPRITE_PX * 0.18)) / H);
    this.player(this.sim.me).stunUntil = now + GAME.clashStunMs;
  }

  private knockout(me: Pet) {
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

  onPeerEvent(_from: string, data: GameEvent) {
    if (!data) return;
    if (data.kind === "slash") {
      // track the opponent's swing so it renders + so my swings can clash with it
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
        cy: 0,
      });
      sfx.enemySwing();
    } else if (data.kind === "hit" && data.target === this.sim.me) {
      this.takeHit(data.damage, data.knockback, data.dir);
    }
  }
}
