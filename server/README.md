# bichito-server

Stateless WebSocket **presence + relay** server. Holds the global online list in
memory and forwards "pet thrown at you" events between peers. No database — presence
is ephemeral (this is a toy for friends).

## Run locally
```bash
cd server
cargo run            # listens on :8787  (override with PORT=)
```
- `GET /health` → `ok` (K8s liveness/readiness)
- `GET /ws` → WebSocket endpoint

The desktop app connects to `ws://127.0.0.1:8787/ws` in debug builds and
`wss://ws.pet.alilozano.com/ws` in release (override with `BICHITO_SERVER`).

## Protocol (JSON, `type`-tagged)
Authoritative pet model: each user owns one pet (a global singleton) that ROAMS
between friends' screens. The server owns each pet's high-level state; clients
render from the `pets` table and stream real-time details peer-to-peer.

- Client → server: `hello`, `leap {target}`, `roamed {owner}`, `dropped {owner}`,
  `gone {owner}`, and relays `cursor` / `grip` / `hold` / `released` / `petPos {to,…}`.
- Server → client: `presence {users}`, `pets {pets:[{owner,name,character,state}]}`,
  and relayed `peerCursor` / `peerGrip` / `peerHold` / `peerReleased` / `peerPetPos`.
- Pet `state`: `roaming {who:host}` · `leaping {who:target}` · `bouncing {who:screen}` · `idle`.

See `src/protocol.rs` (mirrored in `app/src-tauri/src/protocol.rs`).

## Deploy (Hito 4)
`Dockerfile` builds a slim image → GHCR → K8s Deployment + Service in namespace
`prod`, exposed at `ws.pet.alilozano.com` via the existing NGINX ingress (WebSocket
upgrade headers) + Cloudflare DNS. Declared in Pulumi (`../../infra`).
