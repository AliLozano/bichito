# Cómo probar bichito

Tres formas, de la más rápida a la más real.

## 1) Local: tu app real + un "amigo falso" (recomendado) 🐾

Prueba TODO el juego en tu Mac sin segunda máquina. El amigo falso (`Claude`) es un
script headless que corre un port del `Sim`: controla su propia mascota (camina,
deambula, hace broadcast ~20Hz) y forcejea contigo por el control (handoff).

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

# Terminal 3 — el amigo falso "Claude"
cd ~/code/personal/bichito/app
nvm use 18
CMD_FILE=/tmp/claude_cmd node tools/peer-claude.mjs
```

**Qué deberías ver / hacer:**
- Ambas mascotas (la tuya y la de Claude) **caminan por tu pantalla** y son
  agarrables por cualquiera — el mundo es compartido y siempre sincronizado.
- **Agarra una mascota**: acércale el mouse y mantén click; la arrastras. Suéltala y
  sale disparada (thrown), rebota, aterriza **mareada** (💫, ~1.4s) y luego **se va
  corriendo**. Ese microestado mareado es tu ventana para volver a agarrarla.
- **Colisiónalas**: lanza una contra la otra; rebotan como contra una pared (recoil)
  y ambas caen mareadas.
- **Manda a Claude a saltar**: `echo throw > /tmp/claude_cmd`. La mascota de Claude
  salta a **tu cursor**; muévelo **con tirones** (aceleración) para botarla — el
  movimiento suave no la suelta.
- Cuando alguien interactúa ves su **cursor fantasma**; si no, no.
- Claude también salta random cada tanto. Para salir: `echo quit > /tmp/claude_cmd`.

> Cambia el nombre del falso: `PEER_NAME="Pepe" node tools/peer-claude.mjs`.

## 2) Dos máquinas reales (tu Mac + otra Mac/Windows) 🖥️🖥️

Contra el server de tu LAN (o directo contra prod, ver abajo):

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
El build **release** apunta solo a `wss://ws-pet.alilozano.com/ws` y cualquiera con el
instalador se conecta — sin configurar nada.

## 3) Test del protocolo (headless, sin GUI)

Valida el server/relay end-to-end con dos clientes sintéticos (world compartido,
leap→claim handoff, relay de cursor/bump con `from`, limpieza en desconexión):

```bash
cd ~/code/personal/bichito/app
nvm use 18
node tools/itest.mjs      # requiere el server corriendo en :8787 (o edita la URL)
# -> "13/13 passed"
```

> Ojo: si tu app real está conectada al mismo server, contamina los conteos del test
> (pets/cursores extra). Corre el `itest` contra un server aislado en otro puerto:
> `PORT=8799 ./target/debug/bichito-server` y apunta el test a `:8799`.

## Notas macOS
- Leer el cursor global (`cursor_position`) **no requiere permisos** (no inyecta input).
- El overlay es transparente + click-through; no roba clicks a lo que está debajo.
- Si el overlay no cubre bien la pantalla, revisa `arm_overlay` en `src-tauri/src/lib.rs`
  (usa el monitor primario).
- **Gotcha HMR**: el `Sim` es un singleton en `window.__bichitoSim`, así que editar
  `sim.ts` solo hace HMR y deja la instancia vieja corriendo. Recarga el overlay (o
  relanza `npm run tauri dev`) para tomar cambios de física.
