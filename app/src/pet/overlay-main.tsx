import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Pet, type Spawn } from "./Pet";
import { GrabPet } from "./GrabPet";
import { GhostCursor } from "./GhostCursor";
import { RemotePet } from "./RemotePet";
import { loadProfile, type Profile } from "./../lib/store";
import type { CharacterId } from "../lib/characters";
import "../styles.css";

// The overlay renders purely from the SERVER's authoritative pet table (`pets`).
// Each pet is a global singleton owned by one person; the server says where it is
// and I render only the ones that concern me, based on my role:
//   • roaming@me   -> I host it: a wandering, grabbable pet (owner's character)
//   • leaping@me   -> a friend's pet is on MY cursor (I'm the target)  -> GrabPet
//   • owner==me & leaping -> MY pet is on a friend's cursor (I'm the thrower) -> GhostCursor
//   • bouncing@me  -> it dropped/bounces on my screen -> loose grabbable pet

interface PetState {
  kind: "idle" | "roaming" | "leaping" | "bouncing";
  who?: string;
}
interface PetInfo {
  owner: string;
  name: string;
  character: string;
  state: PetState;
}

function Overlay() {
  const [me, setMe] = useState<Profile | null>(null);
  const [pets, setPets] = useState<PetInfo[]>([]);
  const dropSpawns = useRef<Record<string, Spawn>>({});

  useEffect(() => {
    invoke("set_clickthrough", { ignore: true }).catch(() => {}); // known-good start
    invoke("cursor_poll_start").catch(() => {}); // cursor hit-testing + feed

    loadProfile().then(setMe);
    invoke<PetInfo[]>("get_pets").then(setPets).catch(() => {}); // snapshot on load
    const unPets = listen<PetInfo[]>("pets", (e) => setPets(e.payload));
    const unProfile = listen<Profile>("profile-changed", (e) => setMe(e.payload));
    return () => {
      unPets.then((f) => f());
      unProfile.then((f) => f());
    };
  }, []);

  if (!me) return null;
  const myId = me.id;

  const roaming = pets.filter((p) => p.state.kind === "roaming" && p.state.who === myId);
  const grabOnMe = pets.find((p) => p.state.kind === "leaping" && p.state.who === myId);
  const myLeap = pets.find((p) => p.owner === myId && p.state.kind === "leaping");
  // bouncing on my screen (I run the physics + stream it to the owner)
  const bouncing = pets.filter((p) => p.state.kind === "bouncing" && p.state.who === myId);
  // MY pet bouncing on a friend's screen (I watch it mirrored)
  const myBouncing = pets.filter(
    (p) => p.state.kind === "bouncing" && p.owner === myId && p.state.who !== myId
  );

  return (
    <>
      {/* friends' pets wandering my screen (I host them) */}
      {roaming.map((p) => (
        <Pet
          key={"roam:" + p.owner}
          character={p.character as CharacterId}
          label={p.name}
          onLeave={() => invoke("roamed", { owner: p.owner }).catch(() => {})}
        />
      ))}

      {/* a friend's pet clinging to my real cursor */}
      {grabOnMe && (
        <GrabPet
          key={"grab:" + grabOnMe.owner}
          from={grabOnMe.owner}
          fromName={grabOnMe.name}
          character={grabOnMe.character as CharacterId}
          onEnd={(drop) => {
            dropSpawns.current[grabOnMe.owner] = drop;
            invoke("dropped", { owner: grabOnMe.owner }).catch(() => {});
          }}
        />
      )}

      {/* MY pet on a friend's ghost cursor (I threw it) */}
      {myLeap && myLeap.state.who && (
        <GhostCursor
          key={"ghost:" + myLeap.state.who}
          from={myLeap.state.who}
          character={me.character}
          onEnd={() => {}}
        />
      )}

      {/* it bounces on my screen (grabbable, re-throwable); I mirror it to the
          owner so they see it too -> then back to roaming */}
      {bouncing.map((p) => (
        <Pet
          key={"bounce:" + p.owner}
          character={p.character as CharacterId}
          label={p.name}
          streamTo={p.owner}
          owner={p.owner}
          spawn={
            dropSpawns.current[p.owner] ?? {
              x: window.innerWidth / 2,
              y: 80,
              vx: (Math.random() - 0.5) * 300,
              vy: 120,
            }
          }
          onGone={() => {
            delete dropSpawns.current[p.owner];
            invoke("gone", { owner: p.owner }).catch(() => {});
          }}
        />
      ))}

      {/* MY pet bouncing on a friend's screen — mirrored so I see it fall/bounce */}
      {myBouncing.map((p) => (
        <RemotePet
          key={"remote:" + p.owner}
          character={me.character}
          from={p.state.who as string}
          owner={p.owner}
          label={p.name}
        />
      ))}
    </>
  );
}

// Single React root across HMR reloads (avoids stacked overlays / duplicate pets).
const container = document.getElementById("overlay")!;
const store = window as unknown as { __bichitoOverlayRoot?: ReactDOM.Root };
const root = store.__bichitoOverlayRoot ?? (store.__bichitoOverlayRoot = ReactDOM.createRoot(container));
root.render(<Overlay />);
