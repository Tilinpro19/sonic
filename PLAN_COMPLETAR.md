# Plan para completar Sonic R web

Objetivo: carrera completa de 3 vueltas jugable en las 5 pistas con los 10 personajes, sin regresiones, desplegada como PWA en GitHub Pages.

## Estado verificado (21-10-2026)

- `npx vitest run`: 13 archivos, **122 tests pasan**. Esta es la línea base; no debe bajar.
- `OriginalRunner` ya está cableado en el juego (`src/main.ts:406`) cuando la pista tiene `origTerrain`.
- `src/engine/original.ts` ya contiene `jump`, `springs`, `updateWater` y `collide`. El plan y la memoria dicen que estas partes están pendientes: **hay que actualizar esos documentos**, pero el código aún no está validado contra la grabación de salto y muelles.
- Falta de verdad: spin dash y habilidades (switch de `0x485a85`), choques entre corredores (`0x4201a0`), semántica de `aistuff`, rescates de IA, Tails en Ruin, geometría de Emerald y Ruin, y la posición de salida.

## Reparto de archivos

Cada agente edita solo sus archivos. Si hace falta tocar otro, se avisa antes.

| Responsable | Archivos |
|---|---|
| Claude | `src/engine/**` (salvo `touch.ts`), `src/formats/**`, lógica de carrera y arranque en `src/main.ts`, integración de fuente en `src/source.ts` |
| Antigravity | `.github/**`, `vite.config.ts`, `public/**`, `src/pwa.ts`, `index.html`, `src/hud.ts`, `src/engine/touch.ts`, `README.md`, estado en `SONIC_R_REA_PLAN.md` |

- `src/main.ts` lo edita solo Claude. Antigravity no lo toca.
- Ramas: `antigravity/<tarea>` y `claude/<tarea>`. Merge solo si `npx vitest run` y `npx tsc --noEmit` pasan.

## Tareas de Claude (robustas, en orden)

**C1. Validar salto y muelles contra la grabación.** Añadir a `original.test.ts` un test que compare los ticks con salto y con muelles de la grabación golden. Criterio: 0 desviaciones en esos ticks. Si falla, corregir `jump` y `springs`.

**C2. Spin dash y habilidades.** Portar el spin dash y el switch de `0x485a85` en `original.ts`, y conectarlo a los eventos de `runner.ts`. Criterio: test de la mecánica (carga, liberación, velocidad resultante) y sin regresiones.

**C3. Choques entre corredores (`0x4201a0`).** Portar la colisión entre corredores. Criterio: eliminar los 51 ticks fallidos de la comparación con la grabación.

**C4. IA: `aistuff` y rescates.** Averiguar la semántica de `aistuff` y reducir los rescates. Criterio: bajar la puntuación de `ai.track.test.ts` (ahora 36 en 5 pistas × 10 personajes), medida con el mismo método de la memoria. Cada ajuste se mide; varios empeoraron antes.

**C5. Tails en Ruin (p21–52).** Investigar por qué Tails falla en ese tramo. Criterio: Tails completa las 3 vueltas en Ruin.

**C6. Geometría pendiente.** Arco de salto de Ruin (superficie 3D) y teletransportes de Emerald (localizar los objetos originales en lugar de deducirlos de la línea, `warps.ts`). Criterio: test por pista que compruebe que el corredor sigue la trayectoria esperada.

**C7. Posición de salida y escala 1/8.** Verificar la salida de carrera (la intro de P1 termina en el origen) y dónde se aplica la escala 1/8. Criterio: el corredor sale de la parrilla en la posición del juego original.

**C8. Retirar el `Runner` aproximado.** Cuando C1–C7 pasen, usar solo `OriginalRunner`. Criterio: tests verdes y ningún import del `Runner` antiguo en el juego.

**C9. Prueba de extremo a extremo.** Carrera completa de 3 vueltas en las 5 pistas, con piloto automático, en el navegador. Criterio: las 5 terminan sin errores en consola.

**C10. Carga nativa inmediata en navegador (Zero-Install / Sin selector obligatorio de carpeta).**
- Configurar el arranque en `src/main.ts` y `src/source.ts` para que el juego intente cargar automáticamente los assets servidos por la web (`webSource` / `/game/` o almacenamiento local) sin obligar al usuario a seleccionar una carpeta local ni tener Sonic R instalado en su PC.
- Omitir o desbloquear la pantalla `#start` ("Elegir carpeta de Sonic R") si la fuente web o la caché del navegador responden positivamente, transitando de inmediato a `begin(source)` y al menú principal de carrera.
- Mostrar indicador de progreso/carga de assets transparente en caso de descarga inicial, en lugar de un bloqueo modal que sugiera instalar el juego.
- Mantener el selector manual únicamente como fallback secundario o modo offline si no hay conexión ni assets en el host.
- Criterio: Al abrir la URL del juego en el navegador (tanto en desarrollo como en producción/preview), el usuario accede directamente al menú y a la carrera sin ningún requerimiento de instalar nada en su sistema operativo.
- **Estado (21-10-2026):** hecho en la rama `claude/c10-carga-nativa` (worktree `../sonic-r-web-c10`), sin commitear. `webSource()` en `source.ts` busca `game/` relativo a la página en dev y en build (sonda `general/player00.raw`, ignora fallbacks HTML); luego la copia OPFS; el selector solo si no hay ninguna. Al arrancar se ve el spinner con MB descargados, no la pantalla de carpeta. Verificado: dev → menú directo; build sin `game/` → selector; build con `dist/game/` → menú y carrera, 0 errores de consola. 122 tests y `tsc` OK.
- **Ojo (AG6):** el código ya carga desde `game/` si el host lo sirve, pero los archivos son de SEGA: no deben ir en `public/` ni en el deploy público de GitHub Pages. Solo en hosts privados o locales.

## Tareas de Antigravity (sencillas, aisladas)

**AG1. Terminar M8.** `git init` solo dentro de `sonic-r-web/`, `.gitignore` (`node_modules`, `dist`, y cualquier carpeta de juego o assets que no deba subirse), primer commit, y workflow de GitHub Pages. Criterio: `npm run build` y `vite preview` funcionan.

**AG2. Probar la subruta de Pages.** Comprobar que `base: './'` y el service worker funcionan en `https://<usuario>.github.io/<repo>/`. Criterio: carga sin conexión tras una primera visita.

**AG3. Pantalla de resultados.** Mostrar posición final, tiempos por vuelta y botón de repetir, leyendo solo datos que ya expone `race.ts`. No cambia la lógica. Criterio: se ve en desktop y móvil sin scroll horizontal.

**AG4. Controles táctiles.** Revisar `touch.ts` en móvil y que el mapeo de botones coincide con el de teclado y mando. Criterio: las 4 acciones funcionan en móvil.

**AG5. Estado del plan.** Actualizar las filas M3, M4 y M6 de `SONIC_R_REA_PLAN.md` con el estado de la sección "Estado verificado". No cambiar otras secciones.

**AG6. Exposición de assets y soporte de servidor web.**
- Asegurar que `vite.config.ts` sirva los assets de `work/sonicr/app` (en `/game/`) tanto en `serve` como en `preview`, o preparar el script/enlace a `public/game/` para que el despliegue estático cuente con los archivos necesarios.
- Actualizar `index.html` para que el texto de la pantalla de bienvenida no induzca a error hablando de "instalar Sonic R" en la máquina local.

## Orden y paralelismo

1. Claude: C1 → C2 → C3 → C4 (secuencial, cada uno depende del anterior).
2. Antigravity: AG1 → AG2, y en paralelo AG3, AG4, AG5, AG6. No dependen de la física.
3. Claude: C5, C6, C7 (pueden ir en paralelo entre sí).
4. Claude: C8 → C9 → C10 (o C10 en paralelo con C9 para facilitar la prueba end-to-end en navegador).
5. Antigravity: revisar que el build final de Pages pasa con todo el juego y carga nativa.

## Definición de hecho

- Las 5 pistas se completan en 3 vueltas, con los 10 personajes, en el navegador.
- El juego arranca y corre 100% nativo en el navegador al abrir la web, sin obligar al usuario a instalar nada en Windows ni seleccionar carpetas manuales.
- `vitest run` y `tsc --noEmit` pasan, con al menos 122 tests.
- La grabación golden coincide en salto, muelles, agua y choques.
- El build de GitHub Pages se despliega desde `main` y funciona sin conexión.

## Riesgos

- **Conflictos en `main.ts`:** solo Claude lo edita.
- **Regresiones de física:** cada cambio en `original.ts` debe pasar la grabación golden antes de mergear.
- **Plan desactualizado:** AG5 corrige el estado antes de que se use como referencia.
- **Alcance:** modos como Grand Prix o contrarreloj no están en este plan. Si se quieren, se añaden como fase aparte.
