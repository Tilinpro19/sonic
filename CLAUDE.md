# Instrucciones para Claude Code (`sonic-r-web`)

## Objetivo Principal
Completar la remasterización web de Sonic R para que sea una **versión 100% full navegador (Zero-Install)**: cualquier usuario entra a la URL y juega inmediatamente con 3 vueltas completas en las 5 pistas con los 10 personajes, sin obligar a seleccionar carpetas locales ni instalar nada.

## Documentos Clave
- Lee y mantén actualizado: [`PLAN_COMPLETAR.md`](./PLAN_COMPLETAR.md)
- Hoja de ruta general: [`../SONIC_R_REA_PLAN.md`](../SONIC_R_REA_PLAN.md)

## Tareas de Claude (C1 - C10)
- **C1**: Validar salto y muelles contra la grabación golden.
- **C2**: Spin dash y habilidades (switch `0x485a85` en `src/engine/original.ts`).
- **C3**: Choques entre corredores (`0x4201a0`).
- **C4**: IA: resolver semántica de `aistuff` y reducir rescates.
- **C5**: Tails en Ruin (corregir tramo p21–52).
- **C6**: Geometría y arcos de Ruin / teletransportes de Emerald.
- **C7**: Posición de salida y escala 1/8.
- **C8**: Retirar `Runner` legado y dejar `OriginalRunner`.
- **C9**: E2E 5 pistas × 3 vueltas en navegador.
- **C10 (Full Navegador)**: Integrar y consolidar la carga automática de assets (código preparado en `source.ts` y `main.ts`) para que el juego arranque directo al menú/carrera sin mostrar la ventana de pedir carpeta local cuando los assets están servidos.

## Comprobaciones Obligatorias
Antes de dar por terminada cualquier tarea:
```bash
npx vitest run
npx tsc --noEmit
```
Debe mantener los tests verdes (mínimo 122 tests pasando).
