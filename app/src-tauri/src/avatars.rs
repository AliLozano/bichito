// Custom pet skins the user authors themselves. They live in a plain folder in the
// user's home so anyone can drop SVGs in and create as many pets as they like:
//
//   ~/.bichito/avatars/<PetName>/<clip>.svg      (idle.svg, walk.svg, coffee.svg, …)
//   ~/.bichito/avatars/SKILL.md                  (how-to, scaffolded on first run)
//
// The active avatar's clips ride ONCE on presence (see presence.rs / protocol.rs) to
// every friend, who renders them as an INERT `<img>` (no script execution). We still
// sanitize here as defense-in-depth.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::protocol::Avatar;

// Clip names we recognize (== the render poses + idle activities + optional combat).
// A creator provides any subset; missing clips fall back to `idle` at render time.
const CLIPS: &[&str] = &[
    "idle", "walk", "jump", "fall", "hang", "sleep", "crouch", "coffee", "coding", "music",
    "thinking", "combat",
];

const MAX_SVG_BYTES: usize = 128 * 1024; // cap so a single clip can't bloat presence

fn avatars_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|h| h.join(".bichito").join("avatars"))
}

/// Validate + lightly clean a user SVG. Returns None if it looks unsafe/invalid.
/// The hard XSS guarantee is that peers render via `<img>` (inert); this is a second
/// line of defense + keeps obviously-bad files out of the wire.
fn sanitize_svg(raw: &str) -> Option<String> {
    if raw.len() > MAX_SVG_BYTES {
        return None;
    }
    // normalize whitespace for scanning (handlers can be separated by tabs/newlines)
    let lower: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_whitespace() { ' ' } else { c })
        .collect();
    if !lower.contains("<svg") {
        return None; // must actually be an SVG
    }
    // reject active/dangerous constructs outright
    for bad in [
        "<script", "</script", "<foreignobject", "<!doctype", "<!entity", "javascript:",
    ] {
        if lower.contains(bad) {
            return None;
        }
    }
    // reject inline event handlers: an attribute like ` on<letters>=`
    if has_event_handler(&lower) {
        return None;
    }
    // reject external references in href/src (data: is fine and inert under <img>)
    if has_external_ref(&lower) {
        return None;
    }
    Some(raw.trim().to_string())
}

// scan for ` on<letters>=` (onload/onclick/onbegin/…)
fn has_event_handler(lower_ws: &str) -> bool {
    let b = lower_ws.as_bytes();
    let mut i = 0;
    while let Some(pos) = lower_ws[i..].find(" on") {
        let o = i + pos + 1; // index of 'o'
        let mut j = o;
        while j < b.len() && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        let mut k = j;
        while k < b.len() && b[k] == b' ' {
            k += 1;
        }
        // "on" + at least one more letter, then '=' -> an event handler attribute
        if j >= o + 3 && k < b.len() && b[k] == b'=' {
            return true;
        }
        i = o + 1;
    }
    false
}

// reject href/src/xlink:href pointing at http(s):// (external fetch). Note xmlns is a
// URI too, but it's never in an href/src attribute, so this doesn't false-positive.
fn has_external_ref(lower_ws: &str) -> bool {
    for attr in ["href", "src"] {
        let mut i = 0;
        while let Some(pos) = lower_ws[i..].find(attr) {
            let after = i + pos + attr.len();
            // skip the attr name, optional spaces, '=', spaces, opening quote
            let rest = lower_ws[after..].trim_start();
            let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
            let rest = rest
                .strip_prefix('"')
                .or_else(|| rest.strip_prefix('\''))
                .unwrap_or(rest);
            if rest.starts_with("http://") || rest.starts_with("https://") {
                return true;
            }
            i = after;
        }
    }
    false
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name != "."
}

fn load_one(dir: &Path) -> Option<Avatar> {
    let name = dir.file_name()?.to_str()?.to_string();
    if !safe_name(&name) {
        return None;
    }
    let mut clips = HashMap::new();
    for clip in CLIPS {
        let p = dir.join(format!("{clip}.svg"));
        // Don't follow symlinks: these files are read AND broadcast to peers, so a
        // symlinked clip pointing outside the avatars folder would be a local-file
        // exfiltration vector.
        if fs::symlink_metadata(&p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Some(clean) = sanitize_svg(&raw) {
                clips.insert((*clip).to_string(), clean);
            }
        }
    }
    if clips.is_empty() {
        return None; // a folder with no valid clip isn't an avatar
    }
    Some(Avatar { name, clips })
}

/// All custom avatars (for the Preferences picker + rendering the local pet).
pub fn load_all(app: &AppHandle) -> Vec<Avatar> {
    let Some(root) = avatars_root(app) else {
        return vec![];
    };
    let mut out = vec![];
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(a) = load_one(&p) {
                    out.push(a);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// A single avatar by folder name (the active one to attach to Hello/SetAvatar).
pub fn load_named(app: &AppHandle, name: &str) -> Option<Avatar> {
    if !safe_name(name) {
        return None;
    }
    let root = avatars_root(app)?;
    let dir = root.join(name);
    if dir.is_dir() {
        load_one(&dir)
    } else {
        None
    }
}

/// Create the avatars folder + SKILL.md + a starter avatar the first time, so it's
/// discoverable. No-op if the folder already exists.
pub fn scaffold(app: &AppHandle) {
    let Some(root) = avatars_root(app) else {
        return;
    };
    let first_run = !root.exists();
    if fs::create_dir_all(&root).is_err() {
        return;
    }
    // CLAUDE.md: how-to for creating avatars — readable by the user, and picked up as
    // project context if they open Claude Code in this folder. Write if missing; clean
    // up any legacy SKILL.md from an earlier version.
    let _ = fs::remove_file(root.join("SKILL.md"));
    let guide = root.join("CLAUDE.md");
    if !guide.exists() {
        let _ = fs::write(&guide, CLAUDE_MD);
    }
    // Example avatar: on first run create it; on later runs only TOP UP missing clips
    // (so it self-heals to the full set of poses) without overwriting the user's edits.
    // If the user deleted the example on purpose, we respect that (don't resurrect it).
    let ex = root.join("ejemplo-bloop");
    if first_run || ex.exists() {
        if fs::create_dir_all(&ex).is_ok() {
            for (clip, svg) in EXAMPLE_CLIPS {
                let p = ex.join(format!("{clip}.svg"));
                if !p.exists() {
                    let _ = fs::write(p, svg);
                }
            }
        }
    }
}

/// Command: list custom avatars for the settings UI.
#[tauri::command]
pub fn list_avatars(app: AppHandle) -> Vec<Avatar> {
    load_all(&app)
}

/// Command: open the avatars folder in the OS file manager so the user can drop SVGs
/// in. Ensures the folder (and its SKILL.md + example) exist first.
#[tauri::command]
pub fn open_avatars_dir(app: AppHandle) -> Result<(), String> {
    scaffold(&app); // no-op if it already exists; recreates it if the user deleted it
    let root = avatars_root(&app).ok_or_else(|| "no se encontró el home".to_string())?;
    let _ = fs::create_dir_all(&root);
    reveal(&root)
}

fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

const CLAUDE_MD: &str = r##"# Crear mascotas (avatares) para bichito

Esta carpeta guarda los avatares personalizados de tu mascota. Este archivo es una
guía para crearlos — legible por ti, y también usable por **Claude Code** si lo abres
aquí (pídele: "créame un avatar de <lo que sea>"). Los avatares aparecen automáticamente
en **Preferencias → Cambiar personaje**, junto a los que vienen por defecto.

## Cómo crear una

1. Crea una carpeta aquí con el nombre de tu mascota, por ejemplo:
   `~/.bichito/avatars/MiGatito/`
2. Adentro pon un SVG por cada "pose". El único obligatorio es `idle.svg`; los demás
   son opcionales y, si faltan, se usa `idle.svg`.
3. Abre **Preferencias** en bichito → tu mascota aparece en la lista. Selecciónala.

## Poses reconocidas (nombres de archivo)

| Archivo         | Cuándo se usa                                  |
|-----------------|------------------------------------------------|
| `idle.svg`      | quieto (obligatorio / fallback de todo)        |
| `walk.svg`      | caminando                                      |
| `jump.svg`      | saltando                                       |
| `fall.svg`      | cayendo                                        |
| `hang.svg`      | colgando del cursor                            |
| `sleep.svg`     | durmiendo                                      |
| `coffee.svg`    | tomando café (actividad idle)                  |
| `coding.svg`    | programando (actividad idle)                   |
| `music.svg`     | escuchando música (actividad idle)             |
| `thinking.svg`  | pensando (actividad idle)                      |
| `combat.svg`    | en modo pelea del minijuego (opcional)         |

## Reglas del SVG

- Un solo elemento `<svg>` por archivo. Recomendado `viewBox="0 0 24 24"` para que
  calce de tamaño con los demás (se dibuja cuadrado).
- Mantenlo liviano (máx. ~128 KB por archivo).
- **No** se permiten `<script>`, atributos `on...=` (onload, onclick…),
  `<foreignObject>`, ni referencias externas (`href="http..."`). Se ignoran/rechazan:
  por seguridad, el avatar de un amigo se dibuja como imagen inerte.
- Puedes incrustar imágenes como `data:` URIs si quieres usar un dibujo rasterizado.

## Ejemplo

Mira la carpeta `ejemplo-bloop/` que se creó junto a este archivo: trae un SVG por CADA
pose de la tabla de arriba (idle, walk, jump, coffee, combat, …) que puedes copiar y editar
para entender cómo se ve cada una.
"##;

// The example avatar ships EVERY recognized clip so a creator sees, at a glance, all
// the poses/activities they can draw (idle/walk/jump/fall/hang/sleep + the idle
// activities coffee/coding/music/thinking + combat). Each is a tiny self-contained SVG.
const EXAMPLE_CLIPS: &[(&str, &str)] = &[
    (
        "idle",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="13" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.5" cy="12" r="1.4" fill="#0b1220"/>
  <circle cx="14.5" cy="12" r="1.4" fill="#0b1220"/>
  <path d="M9.5 16 q2.5 2 5 0" fill="none" stroke="#0b1220" stroke-width="1" stroke-linecap="round"/>
</svg>
"##,
    ),
    (
        "walk",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="12.5" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.5" cy="11.5" r="1.4" fill="#0b1220"/>
  <circle cx="14.5" cy="11.5" r="1.4" fill="#0b1220"/>
  <path d="M9.5 15 q2.5 2.4 5 0" fill="none" stroke="#0b1220" stroke-width="1" stroke-linecap="round"/>
  <rect x="8" y="19" width="2.2" height="2.4" rx="1" fill="#0369a1"/>
  <rect x="13.8" y="19" width="2.2" height="2.4" rx="1" fill="#0369a1"/>
</svg>
"##,
    ),
    (
        "jump",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="22.2" rx="4" ry="0.9" fill="#000" opacity="0.1"/>
  <circle cx="12" cy="10.5" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.5" cy="9.5" r="1.4" fill="#0b1220"/>
  <circle cx="14.5" cy="9.5" r="1.4" fill="#0b1220"/>
  <path d="M10 13 q2 1.6 4 0" fill="none" stroke="#0b1220" stroke-width="1" stroke-linecap="round"/>
  <rect x="9" y="17" width="2" height="1.8" rx="0.9" fill="#0369a1"/>
  <rect x="13" y="17" width="2" height="1.8" rx="0.9" fill="#0369a1"/>
</svg>
"##,
    ),
    (
        "fall",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="13" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <rect x="4.4" y="4.5" width="2" height="4.4" rx="1" fill="#7dd3fc" stroke="#0369a1" stroke-width="0.6" transform="rotate(-25 5.4 6.7)"/>
  <rect x="17.6" y="4.5" width="2" height="4.4" rx="1" fill="#7dd3fc" stroke="#0369a1" stroke-width="0.6" transform="rotate(25 18.6 6.7)"/>
  <circle cx="9.5" cy="12" r="1.7" fill="#0b1220"/>
  <circle cx="14.5" cy="12" r="1.7" fill="#0b1220"/>
  <ellipse cx="12" cy="16" rx="1.3" ry="1.6" fill="#0b1220"/>
</svg>
"##,
    ),
    (
        "hang",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <rect x="6.5" y="2.5" width="2" height="5" rx="1" fill="#7dd3fc" stroke="#0369a1" stroke-width="0.6"/>
  <rect x="15.5" y="2.5" width="2" height="5" rx="1" fill="#7dd3fc" stroke="#0369a1" stroke-width="0.6"/>
  <circle cx="12" cy="14" r="6.8" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.6" cy="13" r="1.4" fill="#0b1220"/>
  <circle cx="14.4" cy="13" r="1.4" fill="#0b1220"/>
  <path d="M9.6 16.5 q2.4 1.6 4.8 0" fill="none" stroke="#0b1220" stroke-width="1" stroke-linecap="round"/>
</svg>
"##,
    ),
    (
        "sleep",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="14" r="6.5" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <path d="M8 13.5 q1.4 1.2 2.8 0" fill="none" stroke="#0b1220" stroke-width="0.9" stroke-linecap="round"/>
  <path d="M13.2 13.5 q1.4 1.2 2.8 0" fill="none" stroke="#0b1220" stroke-width="0.9" stroke-linecap="round"/>
  <text x="17" y="8" font-size="4" fill="#0369a1">z</text>
</svg>
"##,
    ),
    (
        "coffee",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="13" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.5" cy="11.5" r="1.3" fill="#0b1220"/>
  <circle cx="14.5" cy="11.5" r="1.3" fill="#0b1220"/>
  <path d="M9.6 8.5 q0.8 0.8 0 1.6 q-0.8 0.8 0 1.6" fill="none" stroke="#fff" stroke-width="0.5" opacity="0.6" stroke-linecap="round"/>
  <path d="M10.4 15 h4.6 v2.2 a2.3 2.3 0 0 1 -4.6 0 z" fill="#fff" stroke="#0369a1" stroke-width="0.7"/>
  <path d="M15 15.4 a1.3 1.3 0 0 1 0 2.2" fill="none" stroke="#0369a1" stroke-width="0.7"/>
</svg>
"##,
    ),
    (
        "coding",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21.5" rx="6" ry="1.2" fill="#000" opacity="0.12"/>
  <circle cx="12" cy="11" r="6.5" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.7" cy="10" r="1.2" fill="#0b1220"/>
  <circle cx="14.3" cy="10" r="1.2" fill="#0b1220"/>
  <rect x="7" y="15" width="10" height="5.2" rx="0.6" fill="#1e293b" stroke="#0369a1" stroke-width="0.6"/>
  <rect x="8.5" y="16" width="4" height="0.6" rx="0.3" fill="#4ade80"/>
  <rect x="8.5" y="17.3" width="6" height="0.6" rx="0.3" fill="#60a5fa"/>
  <rect x="8.5" y="18.6" width="3" height="0.6" rx="0.3" fill="#fbbf24"/>
</svg>
"##,
    ),
    (
        "music",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="13" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.5" cy="12" r="1.3" fill="#0b1220"/>
  <circle cx="14.5" cy="12" r="1.3" fill="#0b1220"/>
  <path d="M4.8 10 Q12 2 19.2 10" fill="none" stroke="#334155" stroke-width="1.1" stroke-linecap="round"/>
  <rect x="3.4" y="9.8" width="2.6" height="3.6" rx="1.1" fill="#334155"/>
  <rect x="18" y="9.8" width="2.6" height="3.6" rx="1.1" fill="#334155"/>
  <circle cx="20.6" cy="6" r="0.7" fill="#0369a1"/>
  <rect x="21.1" y="3.4" width="0.5" height="2.6" fill="#0369a1"/>
</svg>
"##,
    ),
    (
        "thinking",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="13" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <circle cx="9.5" cy="12" r="1.3" fill="#0b1220"/>
  <circle cx="14.5" cy="12" r="1.3" fill="#0b1220"/>
  <path d="M10 15.5 h4" fill="none" stroke="#0b1220" stroke-width="1" stroke-linecap="round"/>
  <circle cx="18" cy="7" r="0.7" fill="#fff" stroke="#0369a1" stroke-width="0.4"/>
  <circle cx="19.6" cy="5.2" r="1" fill="#fff" stroke="#0369a1" stroke-width="0.4"/>
  <ellipse cx="21.6" cy="3" rx="2.2" ry="1.6" fill="#fff" stroke="#0369a1" stroke-width="0.5"/>
</svg>
"##,
    ),
    (
        "combat",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <ellipse cx="12" cy="21" rx="6" ry="1.4" fill="#000" opacity="0.15"/>
  <circle cx="12" cy="13" r="7" fill="#7dd3fc" stroke="#0369a1" stroke-width="1"/>
  <path d="M7.5 9.6 l2.4 1.1" fill="none" stroke="#0b1220" stroke-width="0.9" stroke-linecap="round"/>
  <path d="M16.5 9.6 l-2.4 1.1" fill="none" stroke="#0b1220" stroke-width="0.9" stroke-linecap="round"/>
  <circle cx="9.6" cy="12.4" r="1.2" fill="#0b1220"/>
  <circle cx="14.4" cy="12.4" r="1.2" fill="#0b1220"/>
  <path d="M10 16 q2 -1 4 0" fill="none" stroke="#0b1220" stroke-width="1" stroke-linecap="round"/>
  <rect x="18" y="12" width="1.4" height="3.6" rx="0.5" fill="#7c5b34" stroke="#0369a1" stroke-width="0.3"/>
  <path d="M18.1 12 L22.6 6.6 L23.4 7.4 L18.9 12.8 Z" fill="#eef2f7" stroke="#0369a1" stroke-width="0.4" stroke-linejoin="round"/>
</svg>
"##,
    ),
];
