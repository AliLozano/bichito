// Integration test for the shared pet-world protocol. Two synthetic clients:
// A (human) and B (friend). Verifies: world has both pets each controlled by its
// owner; A leaps onto B -> B auto-claims (control handoff); the server rejects a
// stale snap after handoff; cursor/bump relay carry `from`/`owner` and skip the
// sender; disconnect removes the pet and re-homes controlled pets.
//
// Run (Node 18):  node tools/itest.mjs
// Against an isolated server:  BICHITO_SERVER=ws://127.0.0.1:8799/ws node tools/itest.mjs
import WebSocket from "ws";
const URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8787/ws";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, c) => { results.push([c, n]); console.log(`${c ? "✅" : "❌"} ${n}`); };

function mk(id, name, character) {
  const ws = new WebSocket(URL);
  const c = { id, ws, world: null, snaps: [], claims: [], cursors: [], bumps: [], presence: null };
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === "world") c.world = m.pets;
    else if (m.type === "peerSnap") c.snaps.push(m.snap);
    else if (m.type === "peerClaim") c.claims.push(m);
    else if (m.type === "peerCursor") c.cursors.push(m);
    else if (m.type === "peerBump") c.bumps.push(m);
    else if (m.type === "presence") c.presence = m.users;
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.ready = new Promise((r) => ws.on("open", () => { c.send({ type: "hello", id, name, character }); r(); }));
  return c;
}

const snapOf = (owner, controller, state, target = "") => ({
  type: "snap", snap: { owner, name: owner, character: "gato", controller, state,
    x: 0.5, y: 0.9, vx: 0, vy: 0, flip: false, frame: 0, grip: 1, target },
});

const A = mk("A", "Ana", "gato");
const B = mk("B", "Beto", "rana");

await A.ready; await wait(150); await B.ready; await wait(250);

// 1. world has both pets, each controlled by its owner
const w = B.world || [];
ok("world has 2 pets", w.length === 2);
ok("pet A controlled by A", w.find((p) => p.owner === "A")?.controller === "A");
ok("pet B controlled by B", w.find((p) => p.owner === "B")?.controller === "B");

// 2. presence lists both
ok("presence has 2 users", (A.presence || []).length === 2);

// 3. A leaps its pet onto B: claim A + snap oncursor target=B
A.send({ type: "claim", owner: "A" });
A.send(snapOf("A", "A", "oncursor", "B"));
await wait(150);
ok("B received A's oncursor snap", B.snaps.some((s) => s.owner === "A" && s.state === "oncursor" && s.target === "B"));
ok("A did NOT receive its own snap", !A.snaps.some((s) => s.owner === "A"));

// 4. B auto-claims A's pet (control handoff) -> A sees peerClaim
B.send({ type: "claim", owner: "A" });
await wait(150);
ok("A sees peerClaim owner=A controller=B", A.claims.some((c) => c.owner === "A" && c.controller === "B"));

// 5. server rejects a stale snap from the former controller (A no longer controls A)
A.snaps.length = 0; B.snaps.length = 0;
A.send(snapOf("A", "A", "thrown", ""));
await wait(120);
ok("server rejects stale snap after handoff", !B.snaps.some((s) => s.owner === "A" && s.state === "thrown"));

// 6. cursor relay carries `from`, not echoed to sender
B.cursors.length = 0;
A.send({ type: "cursor", x: 0.3, y: 0.4, active: true });
await wait(120);
ok("B receives A's cursor with from=A active", B.cursors.some((c) => c.from === "A" && c.active === true));
ok("A does not receive its own cursor", A.cursors.length === 0);

// 7. bump relay
B.bumps.length = 0;
A.send({ type: "bump", owner: "B", vx: 0.2, vy: -0.1 });
await wait(120);
ok("B receives bump for owner=B", B.bumps.some((b) => b.owner === "B" && b.vx === 0.2));

// 8. disconnect removes pet + reassigns controlled pets to owner
B.ws.close();
await wait(300);
const w2 = A.world || [];
ok("after B leaves, world has 1 pet", w2.length === 1);
ok("A's pet re-homed to A (B was controlling it)", w2.find((p) => p.owner === "A")?.controller === "A");

await wait(100);
A.ws.close();
const pass = results.filter(([c]) => c).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
