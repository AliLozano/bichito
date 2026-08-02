// A headless "fake friend" for local testing without a second machine.
// It connects to the local bichito server and behaves like a real peer so you can
// exercise the whole game against your REAL running app:
//
//   • it shows up in your tray as "Robotín" (online)
//   • every few seconds it throws its pet at you  -> you see a robotito grab your
//     REAL cursor (shake the mouse fast to make it slip and walk off)
//   • when YOU throw your pet at Robotín (tray -> "Saltar sobre Robotín"), it
//     streams a circling cursor back -> you see its GHOST cursor moving; move your
//     mouse over the ghost to grip it (Robotín logs 💗)
//
// Run (Node 18): from app/  ->  npm run fake-friend
// Point elsewhere with BICHITO_SERVER=ws://host:8787/ws, rename with FAKE_NAME=...
import WebSocket from "ws";

const URL = process.env.BICHITO_SERVER || "ws://127.0.0.1:8787/ws";
const ME = {
  id: "fake-robotin",
  name: process.env.FAKE_NAME || "Robotín",
  character: "robotito",
};

const ws = new WebSocket(URL);
let target = null;
let streamTimer = null;
let streamUntil = 0;

const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

ws.on("open", () => {
  console.log(`[robotín] conectado a ${URL} — saludando…`);
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
    case "presence": {
      const others = m.users.filter((u) => u.id !== ME.id);
      target = others[0]?.id ?? null;
      const names = m.users.map((u) => u.name).join(", ") || "(solo yo)";
      console.log(`[robotín] online: ${names}${target ? ` → objetivo: ${target}` : ""}`);
      break;
    }
    case "petIncoming":
      // You threw your pet at me -> I stream my cursor so you see my ghost.
      console.log(`[robotín] ${m.fromName} me lanzó su ${m.character}! te mando mi cursor (verás mi fantasma)…`);
      startStreaming(m.from, 8000);
      break;
    case "peerGrip":
      console.log(`[robotín] me agarras fuerte 💗 strength=${(m.strength ?? 0).toFixed(2)}`);
      break;
    case "peerReleased":
      console.log(`[robotín] se terminó el agarre`);
      break;
    default:
      break;
  }
});

// Every 6s, leap onto you: your REAL cursor gets my robotito hanging on it.
setInterval(() => {
  if (target) {
    console.log(`[robotín] 🐾 ¡salto sobre ti!`);
    send({ type: "sendPet", to: target });
  }
}, 6000);

function startStreaming(to, ms) {
  streamUntil = Date.now() + ms;
  if (streamTimer) return;
  let a = 0;
  streamTimer = setInterval(() => {
    if (Date.now() > streamUntil) {
      clearInterval(streamTimer);
      streamTimer = null;
      send({ type: "released", to });
      return;
    }
    a += 0.15;
    send({ type: "cursor", to, x: 0.5 + Math.cos(a) * 0.18, y: 0.5 + Math.sin(a) * 0.18 });
  }, 50);
}

ws.on("close", () => {
  console.log("[robotín] desconectado");
  process.exit(0);
});
ws.on("error", (e) => console.error("[robotín] error:", e.message));
