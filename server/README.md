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
`wss://ws.bichito.creavity.io/ws` in release (override with `BICHITO_SERVER`).

## Protocol (JSON, `type`-tagged)
Client → server: `hello {id,name,character}`, `sendPet {to}`
Server → client: `presence {users:[{id,name,character}]}`, `petIncoming {from,fromName,character}`

See `src/protocol.rs` (mirrored in `app/src-tauri/src/protocol.rs`).

## Deploy (Hito 4)
`Dockerfile` builds a slim image → GHCR → K8s Deployment + Service in namespace
`prod`, exposed at `ws.bichito.creavity.io` via the existing NGINX ingress (WebSocket
upgrade headers) + Cloudflare DNS. Declared in Pulumi (`../../infra`).
