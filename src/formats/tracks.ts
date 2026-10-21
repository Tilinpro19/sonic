/**
 * Per-track asset manifest. `pages[tpage]` = .raw file loaded into that texture page by
 * Init<Track> (calls to 0x42b044 with EAX = tpage, EDX = path; extracted from sonicr.exe).
 * Snow variants (`*\snow\*_s_NN.raw`) are not listed yet.
 */
export interface TrackInfo {
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
    playfield: { ply: 'city/city.ply', map: 'city/city.map', bounds: { x0: -476.8, z0: 543.49, x1: 631.41, z1: -564.72, s: 25 } },
    pages: [
      'city/city06.raw', 'city/city00.raw', 'city/city01.raw', 'city/city02.raw', 'island/island03.raw',
      G('player00.raw'), 'island/island05.raw', 'city/city03.raw', 'city/city06.raw', 'island/island02.raw',
      G('player01.raw'), G('misc00.raw'), G('misc01.raw'), G('icon00.raw'), G('icon01.raw'),
    ],
  },
  {
    id: 3, key: 'ruin', name: 'Regal Ruin', bin: 'ruin/ruin_d.bin', ter: 'bin/extras/ruin.ter',
    sky: 'ruin/parallax/_r.raw',
    playfield: { ply: 'ruin/ruin.ply', map: 'ruin/ruin.map', bounds: { x0: -450.81, z0: 424.09, x1: 445.75, z1: -472.47, s: 25 } },
    pages: [
      'ruin/ruin00.raw', 'ruin/ruin01.raw', 'ruin/ruin02.raw', 'ruin/ruin03.raw', 'ruin/ruin04.raw',
      G('player00.raw'), 'island/island05.raw', 'island/island02.raw', 'city/city03.raw', 'island/island03.raw',
      G('misc00.raw'), G('misc01.raw'), G('player01.raw'), G('icon00.raw'), G('icon01.raw'),
    ],
  },
  {
    id: 4, key: 'factory', name: 'Reactive Factory', bin: 'factory/factry_e.bin', ter: 'bin/extras/factory.ter',
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
    pages: [
      'emerald/cas00.raw', 'emerald/cas01.raw', 'island/island05.raw', 'emerald/cas02.raw', 'island/island02.raw',
      'city/city03.raw', 'island/island03.raw', G('misc00.raw'), G('misc01.raw'), G('player00.raw'),
      G('player01.raw'), G('icon00.raw'), G('icon01.raw'),
    ],
  },
];
