/**
 * Per-track asset manifest. `pages[tpage]` = .raw file loaded into that texture page by
 * Init<Track> (calls to 0x42b044 with EAX = tpage, EDX = path; extracted from sonicr.exe).
 * Snow variants (`*\snow\*_s_NN.raw`) are not listed yet.
 */
export interface TrackInfo {
  /** The exe's stage id [0x8fb8ec] (loader switch 0x47573f): Factory is 3 and Ruin 4. */
  id: number;
  key: string;
  name: string;
  bin: string;
  ter: string;
  pages: string[];
  /** Parallax panorama, 832×256 RGB24. */
  sky: string;
  /** Tiled ground; bounds are the floats Init<Track> stores at 0x6d75cc/d0/d4/d8 and 0x6d75c0. */
  playfield?: { ply: string; map: string; bounds: { x0: number; z0: number; x1: number; z1: number; s: number } };
  /** Race loop as runs of P0 indices [from, to] (inclusive, either direction) when P0[0..k] is not one (see mainLoop). */
  route?: readonly (readonly [number, number])[];
  /** Original AI path (ai/aistuff?.bin) used to resolve track detours and bypass doors/walls. */
  ai?: string;
}

const G = (f: string) => `general/${f}`;
const COMMON_TAIL = [G('misc00.raw'), G('misc01.raw'), G('player01.raw'), G('icon00.raw'), G('icon01.raw')];

export const TRACKS: TrackInfo[] = [
  {
    id: 1, key: 'island', name: 'Resort Island', bin: 'island/island_e.bin', ter: 'bin/extras/island.ter',
    sky: 'island/parallax/_i.raw',
    playfield: { ply: 'island/island.ply', map: 'island/island.map', bounds: { x0: -476.8, z0: 543.59, x1: 631.41, z1: -564.62, s: 25 } },
    pages: [
      'island/island04.raw', 'island/island01.raw', 'island/island02.raw', 'island/island00.raw',
      G('player00.raw'), 'island/island03.raw', 'island/island05.raw', ...COMMON_TAIL, 'island/island06.raw',
    ],
  },
  {
    id: 2, key: 'city', name: 'Radical City', bin: 'city/city_b.bin', ter: 'bin/extras/city.ter',
    sky: 'city/parallax/_c.raw',
    ai: 'ai/aistuffc.bin',
    playfield: { ply: 'city/city.ply', map: 'city/city.map', bounds: { x0: -476.8, z0: 543.49, x1: 631.41, z1: -564.72, s: 25 } },
    pages: [
      'city/city06.raw', 'city/city00.raw', 'city/city01.raw', 'city/city02.raw', 'island/island03.raw',
      G('player00.raw'), 'island/island05.raw', 'city/city03.raw', 'city/city06.raw', 'island/island02.raw',
      G('player01.raw'), G('misc00.raw'), G('misc01.raw'), G('icon00.raw'), G('icon01.raw'),
    ],
  },
  {
    id: 4, key: 'ruin', name: 'Regal Ruin', bin: 'ruin/ruin_d.bin', ter: 'bin/extras/ruin.ter',
    sky: 'ruin/parallax/_r.raw',
    playfield: { ply: 'ruin/ruin.ply', map: 'ruin/ruin.map', bounds: { x0: -450.81, z0: 424.09, x1: 445.75, z1: -472.47, s: 25 } },
    pages: [
      'ruin/ruin00.raw', 'ruin/ruin01.raw', 'ruin/ruin02.raw', 'ruin/ruin03.raw', 'ruin/ruin04.raw',
      G('player00.raw'), 'island/island05.raw', 'island/island02.raw', 'city/city03.raw', 'island/island03.raw',
      G('misc00.raw'), G('misc01.raw'), G('player01.raw'), G('icon00.raw'), G('icon01.raw'),
    ],
  },
  {
    id: 3, key: 'factory', name: 'Reactive Factory', bin: 'factory/factry_e.bin', ter: 'bin/extras/factory.ter',
    sky: 'factory/parallax/_f.raw',
    playfield: { ply: 'factory/factory.ply', map: 'factory/factory.map', bounds: { x0: -366.75, z0: 279.84, x1: 192.39, z1: -279.3, s: 30 } },
    pages: [
      'factory/fact00.raw', 'factory/fact01.raw', 'factory/fact02.raw', 'factory/fact03.raw', G('player00.raw'),
      'island/island02.raw', 'city/city03.raw', 'island/island03.raw', 'island/island05.raw',
      G('misc00.raw'), G('misc01.raw'), G('player01.raw'), G('icon00.raw'), G('icon01.raw'), 'factory/fact04.raw',
    ],
  },
  {
    id: 5, key: 'emerald', name: 'Radical Emerald', bin: 'emerald/emrald_b.bin', ter: 'bin/extras/emerald.ter',
    sky: 'emerald/parallax/_e.raw',
    // P0 lists its cells branch by branch: A1 p0–99 and B1 p180–265 leave the start side by side
    // and meet at p265; B2 p303–358 and A2 p100–179 (listed backwards, with a dead-end spur
    // p145–149) both run from p303/p179 back to the start. A1 and B2 are the shortcuts behind the
    // ring gates: a closed bar across the road in the `.ter` walls (#111 at p32, #105 at p96, #108
    // at p305, between the two door leaves 829/891, 828/890, 827/889). The lap without rings, from
    // the grid at P0[0] (p180 is its neighbour on B1):
    route: [[0, 0], [181, 303], [179, 150], [144, 101], [358, 358]],
    pages: [
      'emerald/cas00.raw', 'emerald/cas01.raw', 'island/island05.raw', 'emerald/cas02.raw', 'island/island02.raw',
      'city/city03.raw', 'island/island03.raw', G('misc00.raw'), G('misc01.raw'), G('player00.raw'),
      G('player01.raw'), G('icon00.raw'), G('icon01.raw'),
    ],
  },
];
