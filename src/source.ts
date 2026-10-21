/**
 * Where game files come from. The remaster never ships SEGA's assets: the user points it at their
 * own installed copy (folder picker), or in dev the Vite server exposes the local install at /game/.
 */
export interface GameSource {
  label: string;
  get(path: string): Promise<Uint8Array>;
  /** AI-upscaled PNG for a texture page (see work/tools/hd_textures.py), or null. */
  hd(path: string): Promise<Uint8Array | null>;
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
/** `city/city00.raw` → `city__city00.png` (flat, so Real-ESRGAN can batch one folder). */
export const hdName = (p: string) => norm(p).replace(/\.raw$/, '').split('/').join('__') + '.png';

export async function devSource(): Promise<GameSource | null> {
  if (!import.meta.env.DEV) return null; // the build never looks for a copy on the server
  try {
    const r = await fetch('/game/sonicr.exe', { method: 'HEAD' });
    if (!r.ok) return null;
  } catch {
    return null;
  }
  return {
    label: 'copia local (dev)',
    async get(path) {
      // Dev-only overrides (work/overrides) win over the installed copy when present.
      const o = await fetch('/overrides/' + norm(path)).catch(() => null);
      if (o?.status === 200) return new Uint8Array(await o.arrayBuffer());
      const r = await fetch('/game/' + norm(path));
      if (!r.ok) throw new Error(`No se encuentra ${path}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async hd(path) {
      const r = await fetch('/hd/' + hdName(path)).catch(() => null);
      return r?.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null;
    },
  };
}

/** The folders the remaster reads (no exe, DLLs or Localise): ~115 MB of a 139 MB install. */
const WANTED = /^(bin|general|island|city|ruin|factory|emerald|sound|music|ai|hd)\//;

/** Game-relative path → File, from an <input webkitdirectory> pick (the game folder or a parent). */
export function pickedFiles(files: FileList): Map<string, File> {
  const all = [...files];
  const exe = all.find((f) => /(^|\/)sonicr\.exe$/i.test(f.webkitRelativePath));
  if (!exe) throw new Error('No encuentro sonicr.exe en esa carpeta. Elige la carpeta donde está instalado Sonic R.');
  const root = norm(exe.webkitRelativePath).slice(0, -'sonicr.exe'.length);
  const map = new Map<string, File>();
  for (const f of all) {
    const p = norm(f.webkitRelativePath);
    if (p.startsWith(root) && WANTED.test(p.slice(root.length))) map.set(p.slice(root.length), f);
  }
  return map;
}

export function folderSource(map: Map<string, File>): GameSource {
  return {
    label: 'tu copia de Sonic R',
    async get(path) {
      const f = map.get(norm(path));
      if (!f) throw new Error(`No se encuentra ${path}`);
      return new Uint8Array(await f.arrayBuffer());
    },
    async hd(path) {
      const f = map.get('hd/' + hdName(path));
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    },
  };
}

// ---------- OPFS: remember the user's copy so later visits start straight away ----------
// Files are stored flat (`city__city00.raw`) in one private directory; `done` marks a full copy.
const OPFS_DIR = 'sonicr-copy';
const flat = (p: string) => norm(p).split('/').join('__');

async function opfsDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create });
  } catch {
    return null; // no OPFS (old browser, private mode): the folder pick still works for this visit
  }
}

async function opfsRead(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch {
    return null;
  }
}

/** The copy saved on a previous visit, or null. */
export async function savedSource(): Promise<GameSource | null> {
  const dir = await opfsDir(false);
  if (!dir || !(await opfsRead(dir, 'done'))) return null;
  return {
    label: 'copia guardada en el navegador',
    async get(path) {
      const b = await opfsRead(dir, flat(path));
      if (!b) throw new Error(`No se encuentra ${path}`);
      return b;
    },
    hd: (path) => opfsRead(dir, 'hd__' + hdName(path)),
  };
}

/** Copies the picked files into OPFS. Returns false when the browser can't store them. */
export async function saveCopy(map: Map<string, File>, progress: (done: number, total: number) => void): Promise<boolean> {
  const dir = await opfsDir(true);
  if (!dir) return false;
  try {
    await navigator.storage.persist?.().catch(() => false);
    let i = 0;
    for (const [path, file] of map) {
      const h = await dir.getFileHandle(flat(path), { create: true });
      const w = await h.createWritable();
      await w.write(file);
      await w.close();
      progress(++i, map.size);
    }
    const w = await (await dir.getFileHandle('done', { create: true })).createWritable();
    await w.write('1');
    await w.close();
    return true;
  } catch (e) {
    console.warn('No se pudo guardar la copia:', e);
    await forgetCopy();
    return false;
  }
}

export async function forgetCopy() {
  try {
    await (await navigator.storage.getDirectory()).removeEntry(OPFS_DIR, { recursive: true });
  } catch { /* nothing saved */ }
}
