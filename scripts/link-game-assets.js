import { existsSync, symlinkSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';

const src = resolve('../work/sonicr/app');
const dest = resolve('public/game');

if (!existsSync(src)) {
  console.log(`Directorio de assets del juego no encontrado en: ${src}`);
  process.exit(0);
}

if (existsSync(dest)) {
  console.log(`public/game ya existe en: ${dest}`);
  process.exit(0);
}

try {
  symlinkSync(src, dest, 'junction');
  console.log(`Enlace de directorio creado (NTFS junction): ${dest} -> ${src}`);
} catch (e) {
  console.log(`Creando copia local de assets: ${e.message}`);
  cpSync(src, dest, { recursive: true });
  console.log(`Assets copiados a ${dest}`);
}
