// Environment injection so the SAME Sim + GameEngine run in the browser (the app) AND
// headless in Node (the practice "friend" bot) — no reimplementation, no drift.
//
//   - Viewport: pixel dimensions used to convert normalized (0..1) coords to px for
//     collision/hit geometry. App = the window; bot = a fixed virtual screen.
//   - Transport: the SEND side of the wire (the net_* calls). App = Tauri `invoke`
//     (which forwards to the shared WebSocket); bot = a direct WebSocket. The RECEIVE
//     side is wired by each host (overlay listeners / bot message loop) into Sim methods.

/** One pet snapshot as sent on the wire (matches server PetSnap, camelCase). */
export interface SnapMsg {
  owner: string;
  name: string;
  character: string;
  controller: string;
  state: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  flip: boolean;
  frame: number;
  grip: number;
  health: number;
  target: string;
}

export interface Transport {
  claim(owner: string): void;
  snap(s: SnapMsg): void;
  cursor(x: number, y: number, active: boolean): void;
  bump(owner: string, vx: number, vy: number): void;
  game(data: unknown): void; // opaque minigame event (net_game)
  focus(): void; // grab keyboard + mouse (app enters a match); bot: no-op
  arm(): void; // grab keyboard only (app arms a match); bot: no-op
}

export interface Env {
  vw(): number; // viewport width in px
  vh(): number; // viewport height in px
  transport: Transport;
}
