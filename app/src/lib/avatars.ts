// A user-authored pet skin received from Rust (list_avatars) or from a peer (presence).
// `clips` maps a clip name (idle/walk/coffee/…) to its sanitized SVG source. We render
// clips as an INERT <img> (data URI) so a peer's SVG can never run scripts.
import type { Pose } from "./characters";

export interface Avatar {
  name: string;
  clips: Record<string, string>;
}

// Pick the best clip for the current render state, always falling back so something
// shows: requested (combat > activity > pose) -> idle -> any available clip.
export function pickClip(
  avatar: Avatar,
  opts: { pose?: Pose; activity?: string; combat?: boolean }
): string | undefined {
  const { clips } = avatar;
  const order: (string | undefined)[] = [
    opts.combat ? "combat" : undefined,
    opts.activity, // coding | coffee | music | thinking
    opts.pose, // idle | walk | jump | fall | hang | sleep | crouch
    "idle",
  ];
  for (const key of order) {
    if (key && clips[key]) return clips[key];
  }
  // last resort: any clip the avatar does have
  const first = Object.values(clips)[0];
  return first;
}

// Inline the SVG as a data URI. <img>-loaded SVGs are inert (no script/foreignObject/
// external fetch), which is our XSS guarantee for peer-supplied art.
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
