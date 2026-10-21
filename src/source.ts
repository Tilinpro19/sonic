/**
 * Where game files come from. The repository never ships SEGA's assets. In order of preference:
 * files served next to the page at `game/` (the dev server exposes the local install there; a
 * deploy may host them too), the copy saved in the browser (OPFS), or the user's folder pick.
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

/** A file every race needs; if the host serves it, it serves the game. */
const PROBE = 'general/player00.raw';

/** True when `r` is a real file, not a missing one or an SPA fallback page. */
const isFile = (r: Response | null): r is Response => !!r?.ok && r.status !== 204 && !r.headers.get('content-type')?.includes('text/html');

/**
 * The game served over HTTP next to the page (relative `game/`, so it works under any sub-path),
 * or null when the host has no copy.
 */
export async function webSource(): Promise<GameSource | null> {
  const probe = await fetch('game/' + PROBE, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  if (!isFile(probe)) return null;
  const dev = import.meta.env.DEV;
  const fetchFile = async (url: string) => {
    const r = await fetch(url).catch(() => null);
    return isFile(r) ? new Uint8Array(await r.arrayBuffer()) : null;
  };
  return {
    label: dev ? 'copia local (dev)' : 'archivos del servidor',
    async get(path) {
      // Dev-only overrides (work/overrides) win over the installed copy when present.
      const b = (dev ? await fetchFile('overrides/' + norm(path)) : null) ?? (await fetchFile('game/' + norm(path)));
      if (!b) throw new Error(`No se encuentra ${path}`);
      return b;
    },
    // Dev mounts work/hd at /hd/ (204 when missing); a hosted copy keeps them in game/hd/, like a picked folder.
    hd: (path) => fetchFile((dev ? 'hd/' : 'game/hd/') + hdName(path)),
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
