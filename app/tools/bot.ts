// Headless "friend" bot — a REAL networked client that runs the SAME Sim + GameEngine
// as the app (src/pet/sim.ts, src/game/engine.ts). No combat reimplementation, so no
// drift: it wanders like any pet, and when a human starts a duel (their pet enters
// "play") it fights back through the exact engine the app uses.
//
// It plugs in via the Env interface (src/pet/env.ts): a FIXED virtual screen for px
// geometry, and a Transport backed by a direct WebSocket (the app's Transport uses
// Tauri `invoke` instead). Input comes from BotController (src/game/controller.ts) —
// "a human with synthesised keys".
//
// Run:  see tools/run-bot.mjs  (esbuild-bundles this, then node runs it)
import WebSocket from "ws";
import { Sim, IDLE_STATES, type Pet } from "../src/pet/sim";
import { GameEngine } from "../src/game/engine";
import { BotController } from "../src/game/controller";
import { DEFAULT_CONFIG } from "../src/lib/world-config";
import type { Env, SnapMsg } from "../src/pet/env";
import type { CharacterId } from "../src/lib/characters";

const URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8787/ws";
const ME = {
  id: process.env.BOT_ID || "claude-peer",
  name: process.env.PEER_NAME || "Claude",
  character: (process.env.BOT_CHAR || "fantasma") as CharacterId,
};
const VW = 1920,
  VH = 1080; // the bot's virtual screen (px) for normalized<->px conversions
const t = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.log(`${t()} ${s}`);

const ws = new WebSocket(URL);
const send = (o: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

const env: Env = {
  vw: () => VW,
  vh: () => VH,
  transport: {
    claim: (owner) => send({ type: "claim", owner }),
    snap: (s: SnapMsg) => send({ type: "snap", snap: s }),
    cursor: (x, y, active) => send({ type: "cursor", x, y, active }),
    bump: (owner, vx, vy) => send({ type: "bump", owner, vx, vy }),
    game: (data) => send({ type: "game", data }),
    focus: () => {}, // no window to focus, headless
    arm: () => {},
  },
};

const sim = new Sim(env);
const game = new GameEngine(sim);
sim.game = game;
const bot = new BotController();
sim.setMe(ME.id, ME.name, ME.character);

// states from which the bot may step into a duel (grounded + idle-ish); NOT while
// dizzy/fleeing/gone/being-thrown/held, so a KO plays out and it respawns cleanly.
const FIGHTABLE = new Set<string>(["walk", ...IDLE_STATES]);

// A "friend" isn't glued to the keyboard: when you start attacking, its pet stays
// distracted (wandering, taking hits as a punching bag) for a beat before it NOTICES
// and grabs control to defend. Tunable so you can make it more/less attentive.
const REACT_MIN = Number(process.env.BOT_REACT_MIN || 1800); // ms
const REACT_MAX = Number(process.env.BOT_REACT_MAX || 4000); // ms

// states where a HUMAN is actively manipulating my pet (dragging / it's on their cursor
// / mid-throw / leaping). I must NOT reclaim it here — that's normal social play; yanking
// it back mid-drag made it "fall from the cursor". I only take it back once it settles.
const MANIPULATED = new Set<string>(["held", "oncursor", "leap", "thrown"]);

ws.on("open", () => {
  log(`[bot] conectado a ${URL} como ${ME.id}`);
  send({ type: "hello", ...ME, config: DEFAULT_CONFIG });
});
ws.on("close", () => log("[bot] desconectado"));
ws.on("error", (e) => log(`[bot] error ${(e as Error).message}`));

ws.on("message", (buf) => {
  let m: any;
  try {
    m = JSON.parse(buf.toString());
  } catch {
    return;
  }
  const now = performance.now();
  switch (m.type) {
    case "config":
      sim.setConfig(m.config);
      break;
    case "world":
      sim.onWorld(m.pets, now);
      break;
    case "peerSnap":
      sim.applySnap(m.snap, now);
      break;
    case "peerClaim":
      sim.onClaim(m.owner, m.controller);
      break;
    case "peerCursor":
      sim.onCursor(m.from, m.x, m.y, m.active, now);
      break;
    case "peerBump":
      sim.onBump(m.owner, m.vx, m.vy);
      break;
    case "peerGame":
      game.onPeerEvent(m.from, m.data); // hits land here -> takeHit -> health drops -> broadcast
      break;
    case "presence":
      break;
  }
});

// --- AI loop: same cadence as the app's rAF (~60fps) --------------------------
let last = performance.now();
let lastClaim = 0;
let lastHp = 100;
let lastKey = "";
let noticeAt = 0; // when the distracted pet reacts and takes control (0 = not yet reacting)

setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const myPet = sim.pets.get(ME.id);
  if (myPet) {
    // Reclaim my own pet only once it's at REST again (a human let it settle). NOT while
    // they're actively holding/throwing it — that's normal social play, and stealing it
    // back mid-drag made it drop from the cursor ("lo suelta desde el centro"). This
    // still recovers it from a stuck idle-claim (the original "vida no baja" cause).
    if (myPet.controller !== ME.id && !MANIPULATED.has(myPet.state) && now - lastClaim > 500) {
      lastClaim = now;
      myPet.controller = ME.id;
      sim.noteClaim(ME.id); // grace-protect my reclaim like any grab (shared Sim rule)
      env.transport.claim(ME.id);
      // If you placed it to rest, start a FRESH rest cycle: the local rest timers are
      // stale from an earlier cycle, so without this it thinks the nap is over and
      // instantly wakes and walks (instead of staying in reposo like before).
      if ((IDLE_STATES as readonly string[]).includes(myPet.state)) sim.startRest(myPet, myPet.state);
    }

    // nearest other pet, and whether it's actively dueling (state "play")
    let opp: Pet | undefined;
    let bd = Infinity;
    for (const q of sim.pets.values()) {
      if (q.owner === ME.id || q.state === "gone") continue;
      const d = Math.abs(q.x - myPet.x);
      if (d < bd) {
        bd = d;
        opp = q;
      }
    }
    const humanFighting = !!opp && opp.state === "play" && bd < 0.5;

    if (humanFighting && FIGHTABLE.has(myPet.state)) {
      // distracted friend: wait a beat before defending, so you get free hits first.
      // takeHit still drains its health while it wanders (it's a punching bag until it
      // notices). Once it has reacted (noticeAt set) it re-engages instantly after naps.
      if (noticeAt === 0) noticeAt = now + REACT_MIN + Math.random() * (REACT_MAX - REACT_MIN);
      if (now >= noticeAt) game.enter(); // now it notices -> takes control to fight back
    } else if (!humanFighting) {
      noticeAt = 0; // opponent stopped -> forget; next time it's distracted again
      // clear controlling AND the frozen "armed nap": the engine's 5s idle-release can
      // park the pet in an armed nap (sim freezes it), and if you walk away while it's
      // parked, nothing else would ever un-freeze it -> stuck forever (the "..." bug).
      if (game.active || game.armed) game.leave(); // -> startRest, back to wandering
    }

    if (game.active) {
      bot.think(myPet, opp, dt, now);
      game.input.left = bot.input.left;
      game.input.right = bot.input.right;
      game.input.up = bot.input.up;
      game.input.down = bot.input.down;
      if (bot.takeAttack(now)) {
        game.startCharge();
        game.releaseCharge(); // held ~0 -> a quick nail (aguijonazo) toward the opponent
      }
    }

    // surface health changes so we can see the duel working from the logs
    const hp = Math.round(myPet.health * 100);
    if (hp !== lastHp) {
      lastHp = hp;
      log(`[bot] vida ${hp}%  (estado ${myPet.state})`);
    }
    // DIAGNOSTIC: log every state/flag transition so we can see where it wedges
    const key = `${myPet.state}|act=${game.active}|arm=${game.armed}|ctl=${myPet.controller === ME.id ? "me" : myPet.controller}|notice=${noticeAt ? "set" : "0"}|hf=${humanFighting}`;
    if (key !== lastKey) {
      lastKey = key;
      log(`[bot] » ${key}  (bd=${bd === Infinity ? "-" : bd.toFixed(2)})`);
    }
  }

  sim.step(dt, now);
}, 1000 / 60);
