# Sonic R Web

Motor y remasterizado web para **Sonic R** (PC 1997/1998) desarrollado con TypeScript, Three.js y estándares web modernos (PWA, Web Workers y OPFS).

> **Aviso legal**: Este repositorio no contiene ningún asset, audio, textura o binario propietario de SEGA o Traveller's Tales. El motor carga y parsea en el navegador la copia legal proporcionada por el usuario en su propio equipo (mediante File System Access API / OPFS).

## Características

- **PWA offline**: Service Worker generado en el build (`vite.config.ts`) que precachea la aplicación completa para uso sin conexión.
- **Parsers limpios en TypeScript**:
  - Pistas (`*_?.bin`): mallas, texturas 8-bit paletizadas, UVs, spline P0, chunks PVS.
  - Colisión (`*.ter`): malla de altura y banderas de superficie (agua, loops, lanzadores).
  - Modelos (`*.bin`): corredores jerárquicos animados y objetos de pista.
- **Física y simulación**: tick determinista a 30 Hz con interpolación de poses a la tasa de refresco nativa (60 / 120 / 144 / 240 Hz).
- **Audio original**: soporte para efectos de sonido e hilo musical.
- **CI/CD**: GitHub Actions con verificación de tipos (`tsc`), tests unitarios (`vitest`) y despliegue continuo a GitHub Pages en cada push a `main`.

## Instalación y desarrollo

```bash
# Instalar dependencias
npm install

# Servidor de desarrollo
npm run dev

# Verificación de tipos
npm run typecheck

# Pruebas unitarias
npm test

# Build de producción
npm run build

# Previsualizar build localmente
npm run preview
```
