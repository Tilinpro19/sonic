/**
 * Character manifest: mesh, per-heading lighting table and animation files of the 10 racers
 * (order = character ID, as in the physics table 0x5016b4 and LoadAllCharacters 0x475d58).
 * Textures: face tpage 0 → general\player00.raw, 1 → general\player01.raw.
 */
export interface CharacterInfo {
  key: string;
  name: string;
  mesh: string;
  /** 32 headings × nVerts × RGB8, the lighting TintCharacterGouraudTables bakes per direction. */
  grd: string;
  anims: string[];
}

const O = (dir: string) => (f: string) => `bin/objects/${dir}/${f}`;
const anims = (dir: string, prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => O(dir)(`${prefix}${i + 1}.bin`));

export const CHARACTERS: CharacterInfo[] = [
  { key: 'sonic', name: 'Sonic', mesh: O('sonic')('sonic_h.bin'), grd: O('sonic')('sonic_h.grd'), anims: anims('sonic', 'san', 14) },
  { key: 'tails', name: 'Tails', mesh: O('tails')('tails_h.bin'), grd: O('tails')('tails_h.grd'), anims: anims('tails', 'tan', 15) },
  { key: 'knuckles', name: 'Knuckles', mesh: O('knuckles')('knuck_h.bin'), grd: O('knuckles')('knuck_h.grd'), anims: anims('knuckles', 'kan', 16) },
  { key: 'amy', name: 'Amy', mesh: O('amy')('amy_h3.bin'), grd: O('amy')('amy_h3.grd'), anims: anims('amy', 'aan', 11) },
  { key: 'robotnik', name: 'Dr. Robotnik', mesh: O('robotnik')('robotz.bin'), grd: O('robotnik')('robotnik.grd'), anims: anims('robotnik', 'ran', 9) },
  { key: 'msonic', name: 'Metal Sonic', mesh: O('msonic')('msonicz.bin'), grd: O('msonic')('msonic.grd'), anims: anims('msonic', 'msan', 13) },
  { key: 'dtails', name: 'Tails Doll', mesh: O('dtails')('dtailsz.bin'), grd: O('dtails')('dtails.grd'), anims: anims('dtails', 'dtan', 10) },
  { key: 'mknuck', name: 'Metal Knuckles', mesh: O('mknuck')('mknuckz.bin'), grd: O('mknuck')('mknuck.grd'), anims: anims('mknuck', 'mkan', 13) },
  { key: 'mrobot', name: 'Egg Robo', mesh: O('mrobot')('mrobotz.bin'), grd: O('mrobot')('mrobot.grd'), anims: anims('mrobot', 'mran', 14) },
  { key: 'ssonic', name: 'Super Sonic', mesh: O('ssonic')('ssonicz.bin'), grd: O('ssonic')('ssonic.grd'), anims: anims('ssonic', 'ssan', 14) },
];

export const CHARACTER_PAGES = ['general/player00.raw', 'general/player01.raw'];
