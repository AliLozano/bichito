// Headless participant "Claude" for the authoritative pet model. Driven by a
// command file ("throw" to leap on the human, "quit" to exit).
//
//   • Its pet roams on the human's screen automatically (server + client handle it).
//   • On "throw": leaps ITS pet onto the human -> human's cursor gets grabbed; Claude
//     streams its ghost chasing + grip so the human must shake it off (accel).
//   • When the human leaps THEIR pet on Claude: Claude (target) streams a circling
//     ghost + a draining grip, then drops it.
import WebSocket from "ws";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8787/ws";
const CMD_FILE = process.env.CMD_FILE || "/tmp/claude_cmd";
const ME = { id: "claude-peer", name: process.env.PEER_NAME || "Claude", character: "fantasma" };

const ws = new WebSocket(URL);
let pets = [];
let names = {};
let theirCursor = {}; // peerId -> {x,y}
let myGhost = { x: 0.5, y: 0.5 };
// as target (someone leapt on me): owner -> {grip, hold, droppedSent}
let asTarget = null;
let lastTargetCursor = { x: 0.5, y: 0.5 }; // where my cursor was when it dropped
// a pet is bouncing on MY (headless) screen: I simulate + stream it to its owner
let bounceSim = null;

const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

ws.on("open", () => {
  log(`[claude] conectado a ${URL}`);
  send({ type: "hello", ...ME });
});

ws.on("message", (buf) => {
  let m;
  try {
    m = JSON.parse(buf.toString());
  } catch {
    return;
  }
  switch (m.type) {
    case "presence":
      names = Object.fromEntries(m.users.map((u) => [u.id, u.name]));
      break;
    case "pets": {
      pets = m.pets;
      const beingLeapt = pets.find((p) => p.state.kind === "leaping" && p.state.who === ME.id);
      if (beingLeapt && (!asTarget || asTarget.owner !== beingLeapt.owner)) {
        asTarget = { owner: beingLeapt.owner, grip: 1, hold: 0, dropped: false };
        log(`[claude] 🎯 ${names[beingLeapt.owner] ?? beingLeapt.owner} me lanzó su mascota (mueve tu cursor sobre mi fantasma)`);
      } else if (!beingLeapt) {
        asTarget = null;
      }
      // a pet bouncing on my screen -> simulate + mirror to its owner
      const bounce = pets.find((p) => p.state.kind === "bouncing" && p.state.who === ME.id);
      if (bounce && (!bounceSim || bounceSim.owner !== bounce.owner)) {
        // start the fall from where it was hanging on my cursor (not the top!)
        bounceSim = { owner: bounce.owner, x: lastTargetCursor.x, y: lastTargetCursor.y, vx: (Math.random() - 0.5) * 0.25, vy: 0.1, t: 0, phase: "bounce" };
        log(`[claude] la mascota de ${names[bounce.owner] ?? bounce.owner} rebota en mi pantalla (la verás rebotar en la tuya)`);
      } else if (!bounce) {
        bounceSim = null;
      }
      break;
    }
    case "peerCursor":
      theirCursor[m.from] = { x: m.x, y: m.y };
      break;
    case "peerGrip":
      if (asTarget && m.from === asTarget.owner) asTarget.hold = Math.min(1, asTarget.hold + m.strength * 0.25);
      break;
    default:
      break;
  }
});

// command file
setInterval(() => {
  if (!existsSync(CMD_FILE)) return;
  let cmd = "";
  try {
    cmd = readFileSync(CMD_FILE, "utf8").trim();
  } catch {
    return;
  }
  if (!cmd) return;
  writeFileSync(CMD_FILE, "");
  if (cmd === "throw") {
    const target = pets.find((p) => p.owner !== ME.id)?.owner ?? Object.keys(names).find((id) => id !== ME.id);
    if (!target) return log("[claude] no hay nadie a quien lanzar");
    log(`[claude] 🐾 ¡SALTO sobre ${names[target] ?? target}! (sácudelo para botarlo)`);
    send({ type: "leap", target });
    myGhost = { x: 0.2, y: 0.2 };
  } else if (cmd === "quit") {
    ws.close();
    process.exit(0);
  }
}, 150);

// 20fps driver
setInterval(() => {
  // as OWNER: my pet leaping on someone -> chase + grip
  const myLeap = pets.find((p) => p.owner === ME.id && p.state.kind === "leaping");
  if (myLeap && myLeap.state.who) {
    const t = myLeap.state.who;
    const tc = theirCursor[t] ?? { x: 0.5, y: 0.5 };
    // laggy chase: if you move fast I fall behind and can't reinforce (you win)
    myGhost.x += (tc.x - myGhost.x) * 0.05 + Math.cos(Date.now() / 90) * 0.02;
    myGhost.y += (tc.y - myGhost.y) * 0.05 + Math.sin(Date.now() / 70) * 0.02;
    send({ type: "cursor", to: t, x: myGhost.x, y: myGhost.y });
    const gd = Math.hypot(myGhost.x - tc.x, myGhost.y - tc.y);
    if (gd < 0.22) send({ type: "grip", to: t, strength: 1 - gd / 0.22 }); // closeness
  }

  // as TARGET: someone's pet on my cursor -> circle + drain + drop
  if (asTarget && !asTarget.dropped) {
    const O = asTarget.owner;
    // slow, small circle so you can actually chase & pin it (catchable target)
    const a = Date.now() / 1200;
    lastTargetCursor = { x: 0.5 + Math.cos(a) * 0.1, y: 0.45 + Math.sin(a) * 0.07 };
    send({ type: "cursor", to: O, x: lastTargetCursor.x, y: lastTargetCursor.y });
    asTarget.hold = Math.max(0, asTarget.hold - 1.8 * 0.05);
    // smooth constant movement -> tiny drain (~2 min). Occasional ACCELERATION
    // spikes (jerks) drain it fast (seconds).
    asTarget.jerk = Math.max(0, (asTarget.jerk || 0) - 2.5 * 0.05);
    if (Math.random() < 0.012) asTarget.jerk = 0.7;
    const drain = 0.008 + asTarget.jerk;
    asTarget.grip = Math.max(0, Math.min(1, asTarget.grip + (asTarget.hold * 1.5 - drain) * 0.05));
    send({ type: "hold", to: O, level: asTarget.grip });
    if (asTarget.grip <= 0) {
      asTarget.dropped = true;
      send({ type: "released", to: O });
      send({ type: "dropped", owner: O });
      log(`[claude] 👋 tu bichito se soltó de mi cursor`);
    }
  }

  // BOUNCE sim: normalized physics, then it WALKS OFF (fell off the mouse), all
  // streamed to the owner so they see it bounce + walk away on their screen.
  if (bounceSim) {
    const b = bounceSim;
    b.t += 0.05;
    if (b.phase === "bounce") {
      b.vy += 1.6 * 0.05;
      b.x += b.vx * 0.05;
      b.y += b.vy * 0.05;
      if (b.x < 0.05) { b.x = 0.05; b.vx = -b.vx * 0.7; }
      if (b.x > 0.92) { b.x = 0.92; b.vx = -b.vx * 0.7; }
      if (b.y > 0.9) { b.y = 0.9; b.vy = -b.vy * 0.55; b.vx *= 0.8; }
      send({ type: "petPos", to: b.owner, owner: b.owner, x: b.x, y: b.y, flip: b.vx < 0, pose: "fall" });
      const settled = b.y >= 0.89 && Math.abs(b.vy) < 0.15 && Math.abs(b.vx) < 0.08;
      if (settled || b.t > 6) {
        b.phase = "walk";
        b.dir = b.x < 0.5 ? -1 : 1;
      }
    } else {
      // walk off the screen, then it's gone (back to roaming)
      b.x += b.dir * 0.28 * 0.05;
      send({ type: "petPos", to: b.owner, owner: b.owner, x: b.x, y: 0.9, flip: b.dir < 0, pose: "walk" });
      if (b.x < -0.05 || b.x > 1.05) {
        send({ type: "gone", owner: b.owner });
        log(`[claude] la mascota de ${names[b.owner] ?? b.owner} se fue caminando -> roaming`);
        bounceSim = null;
      }
    }
  }
}, 50);

ws.on("close", () => {
  log("[claude] desconectado");
  process.exit(0);
});
ws.on("error", (e) => log(`[claude] error: ${e.message}`));
