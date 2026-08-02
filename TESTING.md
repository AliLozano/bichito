# Cómo probar bichito

Tres formas, de la más rápida a la más real.

## 1) Local: tu app real + un "amigo falso" (recomendado) 🐾

Prueba TODO el juego en tu Mac sin segunda máquina. El amigo falso (`Robotín`) es un
script headless que se conecta al server y actúa como un peer de verdad.

**3 terminales** (todas con `nvm use 18` donde aplique):

```bash
# Terminal 1 — server
cd ~/code/personal/bichito/server
cargo run
# -> "bichito-server listening on 0.0.0.0:8787"

# Terminal 2 — la app real (build debug usa ws://127.0.0.1:8787 automáticamente)
cd ~/code/personal/bichito/app
nvm use 18
npm install          # la primera vez
npm run tauri dev
# -> onboarding: pon tu nombre, elige personaje, ¡Empezar! (se va al tray)

# Terminal 3 — el amigo falso
cd ~/code/personal/bichito/app
nvm use 18
npm run fake-friend
```

**Qué deberías ver / hacer:**
- En el **tray** (barra de arriba) aparece 🟢 y "🐾 Saltar sobre Robotín" habilitado.
- Cada ~6s **Robotín salta sobre ti**: un robotito cae y **se agarra de tu cursor real**.
  Mueve el mouse **rápido** para que pierda el agarre, caiga y se vaya caminando.
- Click en el tray → **"Saltar sobre Robotín"**: Robotín te devuelve su cursor y verás
  su **cursor fantasma** moviéndose en círculo. Pasa tu mouse **encima del fantasma**:
  Robotín loguea `💗 me agarras fuerte`.
- La consola de Robotín narra todo lo que pasa.

> Cambia el nombre del falso: `FAKE_NAME="Pepe" npm run fake-friend`. Puedes correr
> varios a la vez (cambia también el `id` dentro del script si quieres 2+).

## 2) Dos máquinas reales (tu Mac + otra Mac/Windows) 🖥️🖥️

Antes de tener la infra (Hito 4), corran contra el server de tu LAN:

```bash
# En tu Mac: server escuchando en la red
cd ~/code/personal/bichito/server && cargo run     # ya bindea 0.0.0.0:8787
ipconfig getifaddr en0                              # tu IP local, p.ej. 192.168.1.50
```

En la **otra** máquina, apunta la app a tu IP (el build debug por defecto usa localhost):

```bash
BICHITO_SERVER=ws://192.168.1.50:8787/ws npm run tauri dev
```

(Ambas en la misma red; abre el puerto 8787 en el firewall del Mac si hace falta.)
Después del **Hito 4**, ya no hace falta nada de esto: el build release apunta solo a
`wss://ws.pet.alilozano.com/ws` y cualquiera con el instalador se conecta.

## 3) Tests del protocolo (headless, sin GUI)

Para validar el server/relay rápido (lo que usamos en desarrollo):

```bash
# requiere websocat (brew install websocat)
cd ~/code/personal/bichito/server && cargo run &   # server
# smoke de presencia + lanzar pet:
bash /ruta/al/scratchpad/ws_smoke.sh
# smoke de agarre (cursor/grip/released):
bash /ruta/al/scratchpad/ws_grab.sh
```

## Notas macOS
- Leer el cursor global (`cursor_position`) **no requiere permisos** (no inyecta input).
- El overlay es transparente + click-through; no roba clicks a lo que está debajo.
- Si el overlay no cubre bien la pantalla, revisa `arm_overlay` en `src-tauri/src/lib.rs`
  (usa el monitor primario).
