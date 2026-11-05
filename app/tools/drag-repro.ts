import WebSocket from "ws";
import { Sim } from "../src/pet/sim";
import { GameEngine } from "../src/game/engine";
import type { Env, SnapMsg } from "../src/pet/env";
const URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8799/ws";
function makeClient(id: string) {
  const ws = new WebSocket(URL);
  const send = (o: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  const env: Env = {
    vw: () => 1920, vh: () => 1080,
    transport: { claim: (o) => send({ type: "claim", owner: o }), snap: (s: SnapMsg) => send({ type: "snap", snap: s }), cursor: (x, y, active) => send({ type: "cursor", x, y, active }), bump: (o, vx, vy) => send({ type: "bump", owner: o, vx, vy }), game: (d) => send({ type: "game", data: d }), focus() {}, arm() {} },
  };
  const sim = new Sim(env); sim.game = new GameEngine(sim); sim.setMe(id, id, "gato");
  ws.on("open", () => send({ type: "hello", id, name: id, character: "gato" }));
  ws.on("message", (b) => {
    let m: any; try { m = JSON.parse(b.toString()); } catch { return; }
    const now = performance.now();
    if (m.type === "world") sim.onWorld(m.pets, now);
    else if (m.type === "peerSnap") sim.applySnap(m.snap, now);
    else if (m.type === "peerClaim") sim.onClaim(m.owner, m.controller);
    else if (m.type === "peerCursor") sim.onCursor(m.from, m.x, m.y, m.active, now);
    else if (m.type === "peerBump") sim.onBump(m.owner, m.vx, m.vy);
  });
  return { ws, sim };
}
const A = makeClient("repro-a"), B = makeClient("repro-b");
let last = performance.now(); const FIXED = 1 / 60; let accA = 0, accB = 0;
setInterval(() => {
  const t = performance.now(); const dt = Math.min((t - last) / 1000, 0.25); last = t;
  accA += dt; while (accA >= FIXED) { A.sim.step(FIXED, t); accA -= FIXED; }
  accB += dt; while (accB >= FIXED) { B.sim.step(FIXED, t); accB -= FIXED; }
}, 1000 / 60);
let grabbed = false, lostAt = -1, followSamples = 0, followOk = 0;
setTimeout(() => {
  const bPet = A.sim.pets.get("repro-b");
  if (!bPet) { console.log("!! A no ve a B"); process.exit(1); }
  A.sim.myCursor.x = bPet.x; A.sim.myCursor.y = bPet.y; A.sim.grab(bPet); grabbed = true;
  let k = 0; const drag = setInterval(() => { A.sim.myCursor.x = Math.min(0.9, A.sim.myCursor.x + 0.008); if (++k >= 200) clearInterval(drag); }, 1000 / 60);
}, 1200);
const mon = setInterval(() => {
  if (!grabbed) return;
  const a = A.sim.pets.get("repro-b")!;
  if (a.controller !== "repro-a" && lostAt < 0) lostAt = A.sim.myCursor.x; // grab lost
  followSamples++;
  if (Math.abs(a.x - A.sim.myCursor.x) < 0.06) followOk++;
}, 1000 / 60);
setTimeout(() => {
  clearInterval(mon);
  const held = A.sim.pets.get("repro-b")!.controller === "repro-a";
  console.log(`grab held to end: ${held ? "YES ✅" : "NO ❌ (lost at cursor x=" + lostAt.toFixed(2) + ")"}   follow-cursor: ${followSamples ? Math.round(100 * followOk / followSamples) : 0}%`);
  process.exit(0);
}, 5200);
