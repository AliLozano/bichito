// Headless friend "Claude" for the shared pet-world protocol. It runs a compact
// port of the client Sim: it controls its OWN pet (walks, wanders, broadcasts
// snapshots ~20Hz), claims any pet that lands on its cursor, and drives a slow
// autopilot cursor so the human can play tug-of-war. Commands via a file:
//   throw -> leap Claude's pet onto the human   |   quit -> exit
import WebSocket from "ws";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8787/ws";
const CMD_FILE = process.env.CMD_FILE || "/tmp/claude_cmd";
const ME = { id: "claude-peer", name: process.env.PEER_NAME || "Claude", character: "fantasma" };

// physics (mirrors sim.ts)
const G = 2.6, FLOOR = 0.9, WALK = 0.05, RUN = 0.26, PET_R = 0.03;
const SNAP_MS = 45, CURSOR_MS = 45, MAX_THROW = 1.6;
const rand = (a, b) => a + Math.random() * (b - a);
const now = () => Date.now();
const segDist = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

const ws = new WebSocket(URL);
const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const pets = new Map();        // owner -> pet
const cursors = new Map();     // id -> {x,y,active,lastSeen}
const myCursor = { x: 0.5, y: 0.45 };
const lastSnapSent = new Map();
let lastCursorSent = 0;
// ghost visibility: shown/hidden flag with a 3s hide grace (mirrors sim.ts)
const HIDE_MS = 3000;
let cursorShown = false;
let hideAt = 0;
function tickCursor() {
  const interacting = [...pets.values()].some(
    (p) => p.controller === ME.id && (p.state === "held" || (p.state === "oncursor" && p.target === ME.id))
  );
  if (interacting) { cursorShown = true; hideAt = 0; }
  else if (cursorShown && hideAt === 0) hideAt = now() + HIDE_MS;
  if (hideAt && now() >= hideAt) { cursorShown = false; hideAt = 0; }
}

function blank(owner, name, character, controller) {
  return {
    owner, name, character, controller, state: "walk",
    x: 0.5, y: FLOOR, vx: 0, vy: 0, flip: false, frame: 0, spin: 0, grip: 1, target: "",
    t: 0, frameAcc: 0, hold: 0, offX: 0, offY: 0, wanderNext: rand(0.1, 0.9),
    pcx: NaN, pcy: NaN, spd: 0, lphase: "run",
  };
}

function applySnap(s) {
  let p = pets.get(s.owner);
  if (!p) { p = blank(s.owner, s.name, s.character, s.controller); pets.set(s.owner, p); }
  Object.assign(p, {
    name: s.name, character: s.character, controller: s.controller, state: s.state,
    x: s.x, y: s.y, vx: s.vx, vy: s.vy, flip: s.flip, frame: s.frame, grip: s.grip, target: s.target,
  });
  // a pet leapt onto MY cursor -> I take control
  if (p.state === "oncursor" && p.target === ME.id && p.controller !== ME.id) {
    p.controller = ME.id; p.hold = 0; p.t = 0; p.pcx = NaN; p.spd = 0;
    send({ type: "claim", owner: p.owner });
    log(`[claude] 🎯 ${pets.get(p.owner)?.name ?? p.owner} me lanzó su mascota (forcejeo!)`);
  }
}

ws.on("open", () => { log(`[claude] conectado a ${URL}`); send({ type: "hello", ...ME }); });

ws.on("message", (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  switch (m.type) {
    case "presence": break;
    case "world": {
      for (const s of m.pets) applySnap(s);
      const present = new Set(m.pets.map((s) => s.owner));
      for (const owner of [...pets.keys()]) if (owner !== ME.id && !present.has(owner)) pets.delete(owner);
      break;
    }
    case "peerSnap": applySnap(m.snap); break;
    case "peerClaim": { const p = pets.get(m.owner); if (p) p.controller = m.controller; break; }
    case "peerCursor": cursors.set(m.from, { x: m.x, y: m.y, active: m.active, lastSeen: now() }); break;
    case "peerBump": { const p = pets.get(m.owner); if (p && p.controller === ME.id) { p.state = "thrown"; p.vx = m.vx; p.vy = m.vy; p.t = 0; } break; }
  }
});

function simulate(p, dt) {
  p.t += dt;
  switch (p.state) {
    case "walk": {
      const dir = p.wanderNext > p.x ? 1 : -1;
      p.x += dir * WALK * dt; p.flip = dir < 0; p.y = FLOOR;
      p.frameAcc += dt; if (p.frameAcc > 0.12) { p.frameAcc = 0; p.frame ^= 1; }
      if (Math.abs(p.x - p.wanderNext) < 0.02) { p.wanderNext = rand(0.1, 0.9); p.t = 0; }
      break;
    }
    case "held": {
      const nx = myCursor.x + p.offX, ny = myCursor.y + p.offY;
      p.vx = (nx - p.x) / Math.max(dt, 1e-3); p.vy = (ny - p.y) / Math.max(dt, 1e-3);
      p.x = nx; p.y = ny; break;
    }
    case "oncursor": {
      const c = p.target === ME.id ? myCursor : cursors.get(p.target);
      if (c) {
        // grip by cursor SPEED (vs the cursor's own prev pos): normal move ~1min, fast ~seconds.
        const first = Number.isNaN(p.pcx);
        const dvx = first ? 0 : (c.x - p.pcx) / Math.max(dt, 1e-3);
        const dvy = first ? 0 : (c.y - p.pcy) / Math.max(dt, 1e-3);
        const sp = Math.hypot(dvx, dvy);
        p.vx = dvx; p.vy = dvy;
        p.pcx = c.x; p.pcy = c.y;
        p.spd = p.spd * 0.6 + sp * 0.4;
        p.x = c.x; p.y = c.y + 0.02;
        const decay = 0.005 + 0.03 * Math.pow(p.spd, 1.8);
        let reinforce = 0;
        for (const [id, oc] of cursors) {
          if (id === p.target) continue;
          if (oc.active && Math.hypot(oc.x - p.x, oc.y - p.y) < 0.12) reinforce = 1;
        }
        p.hold = Math.min(1, Math.max(0, p.hold - 1.5 * dt + reinforce * 3 * dt));
        p.grip = Math.max(0, Math.min(1, p.grip + (p.hold * 1.2 - decay) * dt));
        if (p.grip <= 0 || p.t > 180) { p.state = "thrown"; p.vx = rand(-0.2, 0.2); p.vy = -0.15; p.t = 0; }
      } else { p.state = "thrown"; p.vy = -0.15; p.t = 0; } // target gone -> drop
      break;
    }
    case "leap": {
      const c = p.target === ME.id ? myCursor : cursors.get(p.target);
      if (!c || !pets.has(p.target) || p.t > 4) { p.state = "flee"; p.wanderNext = p.x < 0.5 ? -0.1 : 1.1; p.t = 0; break; }
      p.frameAcc += dt; if (p.frameAcc > 0.06) { p.frameAcc = 0; p.frame ^= 1; }
      const edge = c.x < 0.5 ? 0.03 : 0.97;
      if (p.lphase === "run") {
        p.y = FLOOR; const dir = edge > p.x ? 1 : -1; p.vx = dir * RUN * 1.7; p.vy = 0; p.x += p.vx * dt; p.flip = dir < 0;
        if (Math.abs(p.x - edge) < 0.03) { p.x = edge; p.lphase = "climb"; }
      } else if (p.lphase === "climb") {
        p.x = edge; p.vx = 0; p.vy = 0; p.flip = edge > 0.5;
        const topY = Math.max(0.05, Math.min(c.y, FLOOR) - 0.05);
        p.y += (topY - p.y) * Math.min(1, dt * 9);
        if (p.y <= topY + 0.02) { p.lphase = "jump"; p.vx = (c.x - p.x) * 2.4; p.vy = -0.15; }
      } else {
        p.vy += G * dt;
        p.x += p.vx * dt + (c.x - p.x) * Math.min(1, dt * 5);
        p.y += p.vy * dt + (c.y - p.y) * Math.min(1, dt * 4);
        p.flip = c.x < p.x;
        if (Math.hypot(p.x - c.x, p.y - c.y) < 0.045) { p.state = "oncursor"; p.grip = 1; p.hold = 0; p.pcx = NaN; p.spd = 0; p.t = 0; }
        else if (p.y >= FLOOR) { p.y = FLOOR; p.state = "dizzy"; p.vx = 0; p.vy = 0; p.spin = 0; p.t = 0; }
      }
      break;
    }
    case "thrown": {
      const spd = Math.hypot(p.vx, p.vy);
      if (spd > MAX_THROW) { p.vx = p.vx / spd * MAX_THROW; p.vy = p.vy / spd * MAX_THROW; }
      p.vy += G * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.spin += p.vx * dt * 90;
      if (p.x < 0.02) { p.x = 0.02; p.vx = -p.vx * 0.7; } else if (p.x > 0.98) { p.x = 0.98; p.vx = -p.vx * 0.7; }
      if (p.y < 0.02) { p.y = 0.02; p.vy = -p.vy * 0.6; } else if (p.y > FLOOR) { p.y = FLOOR; p.vy = -p.vy * 0.5; p.vx *= 0.8; }
      if (p.y >= FLOOR - 0.005 && Math.abs(p.vy) < 0.12 && Math.abs(p.vx) < 0.06) {
        p.state = "dizzy"; p.spin = 0; p.vx = 0; p.vy = 0; p.y = FLOOR; p.t = 0;
      }
      break;
    }
    case "dizzy": {
      p.y = FLOOR;
      p.frameAcc += dt; if (p.frameAcc > 0.15) { p.frameAcc = 0; p.frame ^= 1; }
      if (p.t > 1.4) { p.state = "flee"; p.wanderNext = p.x < 0.5 ? -0.1 : 1.1; p.t = 0; }
      break;
    }
    case "flee": {
      const dir = p.wanderNext > p.x ? 1 : -1;
      p.x += dir * RUN * dt; p.flip = dir < 0; p.y = FLOOR;
      p.frameAcc += dt; if (p.frameAcc > 0.08) { p.frameAcc = 0; p.frame ^= 1; }
      if (p.x < -0.08 || p.x > 1.08) { p.state = "gone"; p.t = 0; }
      break;
    }
    case "gone": {
      if (p.t > rand(4, 9)) {
        const left = Math.random() < 0.5;
        p.x = left ? -0.05 : 1.05; p.y = FLOOR; p.wanderNext = rand(0.2, 0.8); p.state = "walk"; p.t = 0;
      }
      break;
    }
  }
}

function predict(p, dt) {
  if (p.state === "thrown") { p.vy += G * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
}

function collide(dt) {
  for (const a of pets.values()) {
    if (a.controller !== ME.id) continue;
    if (a.state !== "thrown" && a.state !== "held" && a.state !== "oncursor") continue;
    if (now() - (a.hitAt || 0) < 250) continue;
    const ax0 = a.x - a.vx * dt, ay0 = a.y - a.vy * dt;
    for (const b of pets.values()) {
      if (b === a || b.state === "gone") continue;
      const d = segDist(b.x, b.y, ax0, ay0, a.x, a.y);
      if (d < PET_R * 2) {
        const dd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const nx = (a.x - b.x) / dd, ny = (a.y - b.y) / dd, K = 0.5;
        a.hitAt = now(); a.state = "thrown";
        a.vx = nx * K; a.vy = ny * K - 0.2; a.t = 0;
        const bvx = -nx * K, bvy = -ny * K - 0.2;
        if (b.controller === ME.id) { b.state = "thrown"; b.vx = bvx; b.vy = bvy; b.t = 0; b.hitAt = now(); }
        else send({ type: "bump", owner: b.owner, vx: bvx, vy: bvy });
        break;
      }
    }
  }
}

function broadcast() {
  const t = now();
  for (const p of pets.values()) {
    if (p.controller !== ME.id) continue;
    if (t - (lastSnapSent.get(p.owner) ?? 0) < SNAP_MS) continue;
    lastSnapSent.set(p.owner, t);
    send({ type: "snap", snap: {
      owner: p.owner, name: p.name, character: p.character, controller: p.controller,
      state: p.state, x: p.x, y: p.y, vx: p.vx, vy: p.vy, flip: p.flip, frame: p.frame, grip: p.grip, target: p.target,
    }});
  }
}

function broadcastCursor() {
  const t = now();
  if (t - lastCursorSent < CURSOR_MS) return;
  lastCursorSent = t;
  send({ type: "cursor", x: myCursor.x, y: myCursor.y, active: cursorShown });
}

// main tick ~60fps
let lastTick = now();
setInterval(() => {
  const t = now(); const dt = Math.min((t - lastTick) / 1000, 0.05); lastTick = t;
  // autopilot cursor: slow lissajous so a pet on it is catchable
  const a = t / 1300;
  myCursor.x = 0.5 + Math.cos(a) * 0.12;
  myCursor.y = 0.45 + Math.sin(a * 1.3) * 0.09;
  for (const p of pets.values()) p.controller === ME.id ? simulate(p, dt) : predict(p, dt);
  collide(dt);
  tickCursor();
  broadcast();
  broadcastCursor();
  for (const [id, c] of cursors) if (t - c.lastSeen > 1500) cursors.delete(id);
}, 16);

// leap MY pet onto a target's cursor
function leap(target) {
  const p = pets.get(ME.id);
  if (!p || target === ME.id || !pets.has(target)) return;
  if (p.state === "oncursor" || p.state === "held" || p.state === "leap" || p.state === "thrown") return;
  p.controller = ME.id; p.state = "leap"; p.lphase = "run"; p.target = target; p.grip = 1; p.hold = 0; p.t = 0;
  p.pcx = NaN; p.spd = 0;
  send({ type: "claim", owner: ME.id });
}

// command file
setInterval(() => {
  if (!existsSync(CMD_FILE)) return;
  let cmd = ""; try { cmd = readFileSync(CMD_FILE, "utf8").trim(); } catch { return; }
  if (!cmd) return; writeFileSync(CMD_FILE, "");
  if (cmd === "throw") {
    const target = [...pets.values()].find((p) => p.owner !== ME.id)?.owner;
    if (!target) return log("[claude] no hay nadie a quien lanzar");
    leap(target);
    log(`[claude] 🐾 ¡SALTO sobre ${pets.get(target)?.name ?? target}! (sácudelo para botarlo)`);
  } else if (cmd === "quit") { ws.close(); process.exit(0); }
}, 150);

// occasional random leap (like a real friend's app)
setInterval(() => {
  const mine = pets.get(ME.id);
  if (!mine || (mine.state !== "walk" && mine.state !== "gone")) return;
  if (Math.random() > 0.4) return;
  const target = [...pets.values()].find((p) => p.owner !== ME.id && p.state !== "gone")?.owner;
  if (target) { leap(target); log(`[claude] 🎲 salto random sobre tu cursor!`); }
}, 15000);

ws.on("close", () => { log("[claude] desconectado"); process.exit(0); });
ws.on("error", (e) => log(`[claude] error: ${e.message}`));
