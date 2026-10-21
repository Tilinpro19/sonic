import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { parseTrack } from './formats/track';
import { TRACKS, type TrackInfo } from './formats/tracks';
import { webSource, folderSource, pickedFiles, savedSource, saveCopy, forgetCopy, type GameSource } from './source';
import { cropRaw, makePageTexture, type Quality } from './engine/textures';
import { buildTrack, buildRings, toWorld, WATER_PAGE, WATER_TILE } from './engine/trackScene';
import { buildSky } from './engine/sky';
import { buildPlayfield } from './engine/playfield';
import { FlyControls } from './engine/flyControls';
import { analyzeSky, buildLights } from './engine/lighting';
import { parseModel, parseAnim } from './formats/model';
import { CHARACTERS, CHARACTER_PAGES, type CharacterInfo } from './formats/characters';
import { buildCharacter, type Character } from './engine/character';
import { WORLD_SCALE } from './engine/trackScene';
import { parseTerrain } from './formats/terrain';
import { Collision, segmentHit } from './engine/collision';
import { Runner, OriginalRunner, TICK } from './engine/runner';
import { FixedStep } from './engine/clock';
import { readInput, setDriving, registerTouchInput } from './engine/input';
import { createTouchControls, isTouchDevice } from './engine/touch';
import { Race } from './engine/race';
import { showHud, updateHud, ringFlash } from './hud';
import { GameAudio, stageTrack, PRE_RACE, WON, type MusicMode } from './engine/audio';
import { calculateGridSlot, createBot, updateBotInput, calculateStandings, type BotState, type StandingEntry } from './engine/ai';
import { applyWarp } from './engine/warps';
import { loopsOf } from './engine/loops';
import { ParticleManager } from './engine/particles';
import { registerServiceWorker } from './pwa';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const ui = {
  start: $('#start'), pick: $<HTMLInputElement>('#pick'), startMsg: $('#start-msg'),
  panel: $('#panel'), track: $<HTMLSelectElement>('#track'), quality: $<HTMLSelectElement>('#quality'),
  res: $<HTMLSelectElement>('#res'), bloom: $<HTMLInputElement>('#bloom'), rings: $<HTMLInputElement>('#rings'),
  shadows: $<HTMLInputElement>('#shadows'), fog: $<HTMLInputElement>('#fog'), rivals: $<HTMLInputElement>('#rivals'),
  music: $<HTMLSelectElement>('#music'), sfx: $<HTMLInputElement>('#sfx'),
  char: $<HTMLSelectElement>('#char'), anim: $<HTMLSelectElement>('#anim'), look: $<HTMLButtonElement>('#look'),
  tour: $<HTMLButtonElement>('#tour'), copy: $('#copy-status'), menu: $('#menu'), menuChars: $('#menu-chars'), menuTracks: $('#menu-tracks'), menuRivals: $<HTMLInputElement>('#menu-rivals'), menuGo: $<HTMLButtonElement>('#menu-go'), menuViewer: $<HTMLButtonElement>('#menu-viewer'), toMenu: $<HTMLButtonElement>('#to-menu'), forget: $<HTMLButtonElement>('#forget'), drive: $<HTMLButtonElement>('#drive'), hint: $('#hint'), stats: $('#stats'), loading: $('#loading'), loadingMsg: $('#loading-msg'),
};

// ---------- renderer & HD post chain ----------
const canvas = $<HTMLCanvasElement>('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// The track never moves: render the sun's shadow map once per load/toggle, not every frame.
renderer.shadowMap.autoUpdate = false;
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
const controls = new FlyControls(camera, canvas);
const particles = new ParticleManager({ camera });
scene.add(particles.group);

// HDR (half float) target with 4× MSAA; bloom + tone mapping run on top of it.
const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.5, 0.92);
{
  // Bloom is a soft glow: running it at half resolution looks the same and costs ~4× less.
  const setSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
}
composer.addPass(bloom);
composer.addPass(new OutputPass());

let resScale = 1;
function resize() {
  const w = Math.max(innerWidth, 1), h = Math.max(innerHeight, 1);
  const pr = Math.min(devicePixelRatio, 2) * resScale;
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- track loading ----------
let source: GameSource;
const fileCache = new Map<string, Promise<Uint8Array>>();
// Not through fileCache: the MP3s are large and become blob URLs anyway.
const audio = new GameAudio((p) => source.get(p));
// Autoplay policy: audio starts on the first click/key.
for (const ev of ['pointerdown', 'keydown'] as const) addEventListener(ev, () => audio.unlock());
/** The stage's own music, looping (viewer mode and during the race). */
const stageMusic = () => {
  if (current) audio.music(stageTrack(current.info.id, audio.mode, racer?.info.key === 'ssonic'), { loop: true });
};
// Downloaded so far, shown under the spinner (the first visit to a hosted copy fetches ~10 MB per track).
let loadedBytes = 0;
const getFile = (p: string) => {
  let f = fileCache.get(p);
  if (!f) {
    fileCache.set(p, (f = source.get(p)));
    f.then((b) => {
      loadedBytes += b.length;
      ui.loadingMsg.textContent = `${ui.loadingMsg.dataset.base ?? ''} · ${(loadedBytes / 1048576).toFixed(1)} MB`;
    }, () => {});
  }
  return f;
};
const loadingText = (t: string) => {
  ui.loadingMsg.dataset.base = t;
  ui.loadingMsg.textContent = t;
};

interface Loaded {
  info: TrackInfo;
  objects: THREE.Object3D[];
  disposables: { dispose(): void }[];
  update: (t: number) => void;
  sun: THREE.DirectionalLight | null;
  fog: THREE.FogExp2 | null;
  rings: THREE.Object3D;
  tour: { eye: THREE.CatmullRomCurve3; target: THREE.CatmullRomCurve3 } | null;
  tris: number;
  drawCalls: number;
  col: Collision;
  /**
   * Track list P0: race line, one point per PVS cell. Raw file coords (Y up, Z not negated) →
   * `.ter` (x, −y, −z); sits ~80–190 units above the floor on all five tracks.
   */
  raceLine: [number, number, number][];
  /** Ring positions, loader space. */
  ringPos: [number, number, number][];
}
let current: Loaded | null = null;
let quality: Quality = 'remaster';

function applyQuality() {
  const hd = quality !== 'original';
  renderer.toneMapping = hd ? THREE.NeutralToneMapping : THREE.NoToneMapping;
  bloom.enabled = hd && ui.bloom.checked;
  ui.panel.classList.toggle('no-remaster', quality !== 'remaster');
  if (current?.sun) current.sun.castShadow = ui.shadows.checked;
  renderer.shadowMap.needsUpdate = true;
  scene.fog = ui.fog.checked ? current?.fog ?? null : null;
}

/** A 256² texture page; in HD/Remaster an AI-upscaled PNG from hd/ replaces the 4× filter when present. */
async function pageTexture(path: string, raw: Uint8Array) {
  const hd = quality === 'original' ? null : await source.hd(path).catch(() => null);
  return makePageTexture(raw, quality, maxAniso, { hd });
}

async function loadTrack(info: TrackInfo) {
  ui.loading.hidden = false;
  loadingText(`Cargando ${info.name}…`);
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint (rAF stalls in hidden tabs)
  try {
    const [bin, skyRaw, ter, ...pageRaw] = await Promise.all([getFile(info.bin), getFile(info.sky), getFile(info.ter), ...info.pages.map(getFile)]);
    const t0 = performance.now();
    const track = parseTrack(bin);
    // Texture upscaling (worker pool) and geometry tessellation (own worker) run in parallel.
    const pagesP = Promise.all(pageRaw.map((raw, i) => pageTexture(info.pages[i], raw)));
    if (import.meta.env.DEV) pagesP.then(() => Object.assign(window, { __pagesMs: performance.now() - t0 }));
    const waterPage = info.pages.indexOf(WATER_PAGE);
    const waterMap = quality === 'remaster' && waterPage >= 0
      ? makePageTexture(cropRaw(pageRaw[waterPage], WATER_TILE.x, WATER_TILE.y, WATER_TILE.w, WATER_TILE.h), quality, maxAniso,
        { w: WATER_TILE.w, h: WATER_TILE.h, colorKey: false, wrap: true })
      : Promise.resolve(null);
    const pfP = info.playfield
      ? Promise.all([getFile(info.playfield.ply), getFile(info.playfield.map)])
        .then(([ply, map]) => buildPlayfield(ply, map, info.playfield!.bounds, quality, maxAniso))
      : Promise.resolve(null);
    const built = await buildTrack(track, pagesP, { emerald: info.id === 5, quality, waterPage, waterMap });
    const pages = await pagesP;
    const pf = await pfP;
    const t1 = performance.now();
    const sky = buildSky(skyRaw, quality, maxAniso);

    // Environment for the PBR rings: a prefiltered cube map of this track's own sky.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.mesh.clone());
    const env = pmrem.fromScene(envScene, 0.02);
    pmrem.dispose();
    const rings = buildRings(track, env.texture);

    // Remaster: sun + sky light from the track's own panorama, shadows and aerial perspective.
    const remaster = quality === 'remaster';
    const skyInfo = analyzeSky(skyRaw);
    const lights = remaster ? buildLights(skyInfo, new THREE.Box3().setFromObject(built.group)) : null;
    const fog = remaster ? new THREE.FogExp2(skyInfo.sky.clone().lerp(new THREE.Color(1, 1, 1), 0.6), 0.0022) : null;
    rings.mesh.visible = ui.rings.checked;

    // P1 = intro camera: two zero-terminated runs of 179 points (eye, then look-at target), one
    // per 30 Hz tick. Unlike the rings, these are already in loader space (no Z negation).
    const p1 = track.lists.P1.map((p) => toWorld(p));
    const half = p1.length / 2;
    const tour = p1.length > 8
      ? {
          eye: new THREE.CatmullRomCurve3(p1.slice(0, half - 1), false, 'centripetal'),
          target: new THREE.CatmullRomCurve3(p1.slice(half, -1), false, 'centripetal'),
        }
      : null;

    if (current) {
      for (const o of current.objects) scene.remove(o);
      for (const d of current.disposables) d.dispose();
    }
    const objects: THREE.Object3D[] = [sky.mesh, built.group, rings.mesh];
    if (pf) objects.push(pf.mesh);
    if (lights) objects.push(...lights.objects);
    scene.add(...objects);
    scene.environment = env.texture;
    current = {
      info, objects, rings: rings.mesh, tour, sun: lights?.sun ?? null, fog,
      update: (t) => { rings.update(t, drive ? (i) => drive!.race.ringAge(i) : undefined); built.update(t); },
      tris: built.stats.triangles, drawCalls: built.stats.drawCalls, col: new Collision(parseTerrain(ter), info.playfield ? 0 : null), raceLine: track.lists.P0, ringPos: track.rings.map((r) => r.pos),
      disposables: [
        ...pages, sky.texture, env, ...(pf?.disposables ?? []), rings.mesh.geometry, rings.mesh.material as THREE.Material,
        ...built.materials, ...built.textures, ...built.group.children.map((c) => (c as THREE.Mesh).geometry),
        ...(lights ? [lights.sun] : []),
      ],
    };
    applyQuality();
    placeCamera(built.group);
    await loadCharacter();
    if (!drive) stageMusic();
    if (import.meta.env.DEV) {
      const msg = `[load] ${info.key}: textures + geometry ${(t1 - t0) | 0} ms, total ${(performance.now() - t0) | 0} ms`;
      console.info(msg);
      Object.assign(window, { __lastLoad: msg });
    }
    ui.startMsg.textContent = '';
  } catch (e) {
    console.error(e);
    alert(`No se pudo cargar ${info.name}: ${(e as Error).message}`);
  } finally {
    ui.loading.hidden = true;
  }
}

function placeCamera(group: THREE.Object3D) {
  tourT = -1;
  controls.enabled = true;
  if (current?.tour) {
    camera.position.copy(current.tour.eye.getPoint(0));
    controls.lookAt(current.tour.target.getPoint(0));
    return;
  }
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  camera.position.set(c.x, box.max.y + s.length() * 0.1, c.z + s.z * 0.4);
  controls.lookAt(c);
}

// ---------- racers (character renderer 0x469ae0: rigid parts, no hierarchy) ----------
let racer: { info: CharacterInfo; ch: Character; quality: Quality; idleAnim: number } | null = null;

/** Where to stand the racer: the end of the intro path (the start line), dropped onto the track. */
function racerSpot() {
  const ground = current?.objects.find((o) => o.name === 'track');
  const tour = current?.tour;
  // P1 runs end by easing into their (0,0,0) terminator: take the last real look-at point.
  const pts = tour?.target.points ?? [];
  const i = pts.findLastIndex((q) => q.length() > 1);
  const p = i >= 0 ? pts[i].clone() : new THREE.Vector3();
  const eye = tour?.eye.points[Math.min(i, tour.eye.points.length - 1)];
  const fwd = eye ? p.clone().sub(eye).setY(0).normalize() : new THREE.Vector3(0, 0, -1);
  if (ground) {
    const hit = new THREE.Raycaster(p.clone().setY(p.y + 50), new THREE.Vector3(0, -1, 0)).intersectObject(ground, true)[0];
    if (hit) p.y = hit.point.y;
  }
  return { p, fwd };
}

async function loadCharacter() {
  const info = CHARACTERS.find((c) => c.key === ui.char.value) ?? null;
  ui.panel.classList.toggle('no-char', !info);
  if (racer && (racer.info !== info || racer.quality !== quality)) {
    scene.remove(racer.ch.group);
    racer.ch.dispose();
    racer = null;
  }
  if (!info || !current) { stopDrive(); return; }
  if (!racer) {
    const [mesh, grd, ...rest] = await Promise.all([getFile(info.mesh), getFile(info.grd), ...[...CHARACTER_PAGES, ...info.anims].map(getFile)]);
    const pages = await Promise.all(rest.slice(0, CHARACTER_PAGES.length).map((raw, i) => pageTexture(CHARACTER_PAGES[i], raw)));
    const anims = rest.slice(CHARACTER_PAGES.length).map((a) => parseAnim(a).frames);
    const ch = buildCharacter(parseModel(mesh).parts, grd, anims, pages, quality);
    const prevDispose = ch.dispose;
    ch.dispose = () => { prevDispose(); pages.forEach((t) => t.dispose()); };
    const idleAnim = anims.reduce((best, f, i) => (f.length > anims[best].length ? i : best), 0);
    racer = { info, ch, quality, idleAnim };
    ui.anim.replaceChildren(...info.anims.map((a, i) => new Option(`${i + 1} · ${a.split('/').pop()}`, String(i))));
    scene.add(ch.group);
  }
  const { p, fwd } = racerSpot();
  placeRacer(p, fwd);
  racer.ch.setAnim(+ui.anim.value || 0);
  racer.ch.update(elapsed);
  renderer.shadowMap.needsUpdate = true;
  if (drive) startDrive();
}

/** Per character: its drawn "up", eased towards the runner's (floor normal, loop centre). */
const shownUp = new WeakMap<Character, THREE.Vector3>();
const Y_UP = new THREE.Vector3(0, 1, 0), tilt = new THREE.Quaternion();

/** Feet at world point p, facing fwd (horizontal), tilted so its head points along `up`. */
function placeCharacterGroup(ch: Character, p: THREE.Vector3, fwd: THREE.Vector3, up?: THREE.Vector3) {
  const g = ch.group;
  let u = shownUp.get(ch);
  if (!u) shownUp.set(ch, (u = Y_UP.clone()));
  u.lerp(up ?? Y_UP, 0.35).normalize();
  g.scale.setScalar(WORLD_SCALE * CHAR_SCALE);
  g.position.copy(p).addScaledVector(u, -ch.footY * WORLD_SCALE * CHAR_SCALE);
  // Model forward is −X: turn it to face fwd, then tilt onto the surface / round the loop.
  g.rotation.set(0, Math.atan2(fwd.z, -fwd.x), 0);
  ch.setHeading(Math.round((g.rotation.y / (2 * Math.PI)) * 4096));
  if (u.y < 0.9999) g.quaternion.premultiply(tilt.setFromUnitVectors(Y_UP, u));
}

function placeRacer(p: THREE.Vector3, fwd: THREE.Vector3, up?: THREE.Vector3) {
  if (!racer) return;
  placeCharacterGroup(racer.ch, p, fwd, up);
}
const dUp = new THREE.Vector3();

/**
 * Character units → track units. The per-racer cull radii LoadAllCharacters (0x475d58) stores at
 * 0x7130c4 + 0x50·id (Sonic 114, Tails 80, Robotnik 194…) are ≈ 1/8 of each mesh's bounding
 * radius for all ten models, so the meshes are authored at 8× and drawn at 1/8.
 */
const CHAR_SCALE = 1 / 8;

function lookAtRacer() {
  if (!racer) return;
  tourT = -1;
  controls.enabled = true;
  const box = new THREE.Box3().setFromObject(racer.ch.group);
  const c = box.getCenter(new THREE.Vector3()), h = box.getSize(new THREE.Vector3()).y;
  const side = new THREE.Vector3(-Math.cos(racer.ch.group.rotation.y), 0, Math.sin(racer.ch.group.rotation.y));
  camera.position.copy(c).addScaledVector(side, h * 1.6).add(new THREE.Vector3(0, h * 0.25, 0))
    .addScaledVector(new THREE.Vector3(side.z, 0, -side.x), h * 0.9);
  controls.lookAt(c);
}

// ---------- driving (30 Hz runner with CPU rivals on .ter collision mesh) ----------
/**
 * Standing / running animation (0-based <x>anN.bin). Measured on Sonic: san1 = 12-frame run cycle
 * with a bob, san5 = 36-frame idle, san2 = jump ball. The selector 0x421b3c is not decoded yet,
 * so other characters assume the same layout: run = anim 1, idle = their longest animation.
 */
const animsFor = (r: NonNullable<typeof racer>) => ({ run: 0, idle: r.idleAnim });
/** 3-2-1 before the start; the runner can't move and the clock waits. */
const COUNTDOWN = 3 * 30;

interface RivalRacer {
  bot: BotState;
  info: CharacterInfo;
  ch: Character;
  anim: number;
  idleAnim: number;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

let drive: {
  runner: Runner | OriginalRunner;
  race: Race;
  rivals: RivalRacer[];
  standings: StandingEntry[];
  countdown: number;
  clock: FixedStep;
  anim: number;
  cam: THREE.Vector3 | null;
  /** Ticks to the next footstep; brake held last tick (skid sound on press). */
  step: number;
  braking: boolean;
  leftFoot: boolean;
} | null = null;

const touchControls = createTouchControls();
touchControls.attach(document.body);
registerTouchInput(() => touchControls.sample());
let touchActive = isTouchDevice();
window.addEventListener('touchstart', () => {
  touchActive = true;
  if (drive) touchControls.setVisible(true);
}, { passive: true });

/** Pre-race jingle (CD track 3), then the stage track on loop, like 0x4d0bc4. */
const raceMusic = () => audio.music(PRE_RACE, { then: () => { if (drive) stageMusic(); } });
const dPos = new THREE.Vector3(), dDir = new THREE.Vector3(), camTarget = new THREE.Vector3(), lookPt = new THREE.Vector3();

async function loadRivalCharacter(info: CharacterInfo, q: Quality): Promise<{ ch: Character; idleAnim: number }> {
  const [mesh, grd, ...rest] = await Promise.all([
    getFile(info.mesh),
    getFile(info.grd),
    ...[...CHARACTER_PAGES, ...info.anims].map(getFile),
  ]);
  const pages = await Promise.all(rest.slice(0, CHARACTER_PAGES.length).map((raw, i) => pageTexture(CHARACTER_PAGES[i], raw)));
  const anims = rest.slice(CHARACTER_PAGES.length).map((a) => parseAnim(a).frames);
  const ch = buildCharacter(parseModel(mesh).parts, grd, anims, pages, q);
  const prevDispose = ch.dispose;
  ch.dispose = () => { prevDispose(); pages.forEach((t) => t.dispose()); };
  const idleAnim = anims.reduce((best, f, i) => (f.length > anims[best].length ? i : best), 0);
  return { ch, idleAnim };
}

async function startDrive() {
  if (!racer || !current) return;
  stopDrive();

  const runner = current.col.origTerrain
    ? new OriginalRunner(current.col, CHARACTERS.indexOf(racer.info))
    : new Runner(current.col, CHARACTERS.indexOf(racer.info));
  const race = new Race(current.raceLine, current.ringPos);
  current.col.loops = loopsOf(race.loop, current.col);

  // Position Player at grid slot 0
  const s0 = calculateGridSlot(race.loop, 0);
  runner.spawn(s0.x, s0.y, s0.z, s0.yaw);

  const rivals: RivalRacer[] = [];
  if (ui.rivals.checked) {
    const candidateKeys = ['tails', 'knuckles', 'amy', 'sonic', 'robotnik', 'msonic']
      .filter((k) => k !== racer!.info.key)
      .slice(0, 3);
    const candidateInfos = candidateKeys.map((k) => CHARACTERS.find((c) => c.key === k)!).filter(Boolean);

    const configs = [
      { lane: -18, skill: 0.98 },
      { lane: 18, skill: 0.94 },
      { lane: 0, skill: 0.90 },
    ];

    for (let i = 0; i < candidateInfos.length; i++) {
      const info = candidateInfos[i];
      const cfg = configs[i] ?? { lane: 0, skill: 0.92 };
      const { ch, idleAnim } = await loadRivalCharacter(info, quality);
      const charIndex = CHARACTERS.indexOf(info);
      const bot = createBot(current.col, charIndex, info.key, info.name, cfg.lane, cfg.skill, !!current.col.origTerrain);

      const slot = calculateGridSlot(race.loop, i + 1);
      bot.runner.spawn(slot.x, slot.y, slot.z, slot.yaw);

      const pos = new THREE.Vector3();
      const dir = new THREE.Vector3();
      bot.runner.pose(0, pos, dir);
      placeCharacterGroup(ch, pos, dir);
      ch.setAnim(idleAnim);
      ch.update(elapsed);
      scene.add(ch.group);

      rivals.push({ bot, info, ch, anim: idleAnim, idleAnim, pos, dir });
    }
  }

  const initialStandings = calculateStandings(
    { name: racer.info.name, lap: 1, progress: 0, finished: false, finishTime: 0 },
    rivals.map((r) => r.bot),
    race.loop.length,
  );

  drive = {
    runner,
    race,
    rivals,
    standings: initialStandings,
    countdown: COUNTDOWN,
    clock: new FixedStep(),
    anim: -1,
    cam: null,
    step: 0,
    braking: false,
    leftFoot: false,
  };

  raceMusic();
  document.body.classList.add('driving');
  showHud(true);
  tourT = -1;
  controls.enabled = false;
  setDriving(true);
  if (touchActive || isTouchDevice()) {
    touchControls.setVisible(true);
  }
  ui.drive.textContent = '⏹ Dejar de correr';
  ui.hint.textContent = (touchActive || isTouchDevice())
    ? 'Joystick táctil girar · A acelerar · B frenar · Saltar · Mando / Teclado'
    : '↑/W acelerar · ↓/S frenar · ←→ girar · Espacio saltar · R reiniciar · Esc salir · Mando: stick + A/RT';
}

function stopDrive() {
  if (!drive) return;
  if (drive.rivals) {
    for (const r of drive.rivals) {
      scene.remove(r.ch.group);
      r.ch.dispose();
    }
  }
  drive = null;
  touchControls.setVisible(false);
  setDriving(false);
  document.body.classList.remove('driving');
  showHud(false);
  stageMusic();
  controls.enabled = true;
  controls.lookAt(camera.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)));
  ui.drive.textContent = '🏁 Correr';
  ui.hint.textContent = HINT;
}
const HINT = ui.hint.textContent ?? '';

function stepDrive(dt: number) {
  if (!drive || !racer || !current) return;
  const { runner, race, rivals } = drive;
  for (let n = drive.clock.advance(dt); n > 0; n--) {
    if (drive.countdown > 0) {
      // "Ready… Set… Go!" on 3, 2 and the start (ready/set/go.wav).
      if (drive.countdown === COUNTDOWN) audio.play('ready');
      if (drive.countdown === 60) audio.play('set');
      if (--drive.countdown === 0) audio.play('go');
      runner.tick(IDLE);
      for (const r of rivals) r.bot.runner.tick(IDLE);
      continue;
    }
    const inp = readInput();
    const tickRes = runner.tick(inp);
    applyWarp(runner, race.loop);
    if (tickRes.ability === 'spring') {
      audio.play('spring');
      particles.emitRingSparkle(dPos, 20);
    } else if (tickRes.jumped) audio.play('jump');
    const sp = Math.abs(runner.speed);
    if (inp.brake && !drive.braking && runner.grounded && sp > 25) {
      audio.play('skid1', 0.6);
      particles.emitSkid(dPos, dDir);
    }
    drive.braking = inp.brake;
    // Footsteps, alternating feet, faster with speed.
    if (runner.grounded && sp > 3 && --drive.step <= 0) {
      drive.step = Math.max(4, Math.round(9 - sp / 10));
      drive.leftFoot = !drive.leftFoot;
      audio.play(drive.leftFoot ? 'runleft' : 'runright', 0.25 + Math.min(sp / 200, 0.2));
      particles.emitDust(dPos, dDir);
    }
    const ev = race.tick(runner);
    if (ev.rings) {
      ringFlash();
      audio.play('ring1', 0.8);
      particles.emitRingSparkle(dPos, 16);
    }
    if (ev.finished) audio.music(WON);

    if (sp > runner.vmax * 0.88) {
      const trailColor = racer.info.key === 'tails' ? 0xffaa00
        : racer.info.key === 'knuckles' ? 0xff2222
        : racer.info.key === 'amy' ? 0xff66cc
        : racer.info.key === 'ssonic' ? 0xffea00
        : 0x0077ff;
      particles.emitSpeedTrail(dPos, dDir, trailColor);
    }

    // Tick CPU Rivals
    for (const r of rivals) {
      const botInp = updateBotInput(r.bot, race.loop, race.time);
      r.bot.runner.tick(botInp);
    }

    // Update real-time standings
    drive.standings = calculateStandings(
      { name: racer.info.name, lap: race.lap, progress: race.progress, finished: race.finished, finishTime: race.time },
      rivals.map((r) => r.bot),
      race.loop.length,
    );
  }

  const playerRank = drive.standings.find((s) => s.isPlayer)?.rank ?? 1;
  updateHud(race, drive.countdown, Math.abs(runner.speed) * 30 * WORLD_SCALE * 3.6, playerRank, drive.standings);

  runner.pose(drive.clock.alpha, dPos, dDir);
  placeRacer(dPos, dDir, runner.up(dUp));
  const a = animsFor(racer);
  const want = Math.abs(runner.speed) > 3 ? a.run : a.idle;
  if (want !== drive.anim) { racer.ch.setAnim(want); drive.anim = want; ui.anim.value = String(want); }

  // Update rival visuals
  for (const r of rivals) {
    r.bot.runner.pose(drive.clock.alpha, r.pos, r.dir);
    placeCharacterGroup(r.ch, r.pos, r.dir, r.bot.runner.up(dUp));
    const rSp = Math.abs(r.bot.runner.speed);
    const rWant = rSp > 3 ? 0 : r.idleAnim;
    if (rWant !== r.anim) {
      r.ch.setAnim(rWant);
      r.anim = rWant;
    }
    r.ch.update(elapsed);
  }

  // Chase camera (0x423574): behind and above, exponential lag of 4 ticks.
  camTarget.copy(dPos).addScaledVector(dDir, -5.5).y += 2.4;
  const g = current.col.ground(camTarget.x / WORLD_SCALE, camTarget.z / WORLD_SCALE, 4000, 8000);
  if (g) camTarget.y = Math.max(camTarget.y, -g.y * WORLD_SCALE + 0.6);
  if (!drive.cam) drive.cam = camTarget.clone();
  else drive.cam.lerp(camTarget, 1 - Math.pow(1 - 1 / 4, dt / TICK));
  camera.position.copy(drive.cam);
  // Pull in towards the racer when the .ter mesh is between them (cliffs, tunnel walls).
  const head = [dPos.x / WORLD_SCALE, -(dPos.y + 1.2) / WORLD_SCALE, dPos.z / WORLD_SCALE] as [number, number, number];
  const hit = segmentHit(current.col, head, [camera.position.x / WORLD_SCALE, -camera.position.y / WORLD_SCALE, camera.position.z / WORLD_SCALE]);
  if (hit < 1) {
    lookPt.set(dPos.x, dPos.y + 1.2, dPos.z);
    camera.position.lerpVectors(lookPt, drive.cam, hit - 0.08);
    // Too close to see the racer: look down from above and behind instead.
    if (camera.position.distanceTo(lookPt) < 2) camera.position.copy(lookPt).addScaledVector(dDir, -1.2).y += 2.2;
  }
  lookPt.copy(dPos).addScaledVector(dDir, 2).y += 1.1;
  camera.lookAt(lookPt);
}

const IDLE = { accel: false, brake: false, steer: 0, jump: false };

function restartRace() {
  if (!drive || !current) return;
  const s0 = calculateGridSlot(drive.race.loop, 0);
  drive.runner.spawn(s0.x, s0.y, s0.z, s0.yaw);
  drive.race.reset();
  drive.countdown = COUNTDOWN;
  drive.cam = null;

  for (let i = 0; i < drive.rivals.length; i++) {
    const r = drive.rivals[i];
    const s = calculateGridSlot(drive.race.loop, i + 1);
    r.bot.runner.spawn(s.x, s.y, s.z, s.yaw);
    r.bot.lap = 1;
    r.bot.progress = 0;
    r.bot.quarter = 0;
    r.bot.finished = false;
    r.bot.finishTime = 0;
    r.bot.stuckTicks = 0;
    r.bot.reverseTicks = 0;
    r.ch.setAnim(r.idleAnim);
    r.anim = r.idleAnim;
  }
  raceMusic();
}

ui.drive.onclick = () => (drive ? stopDrive() : startDrive());
addEventListener('keydown', (e) => {
  if (!drive) return;
  if (e.code === 'Escape') leaveRace();
  if (e.code === 'KeyR') restartRace();
});
const leaveRace = () => (gameMode ? showMenu() : stopDrive());
$('#hud-menu').onclick = leaveRace;
// Gamepad Start (standard mapping button 9) leaves the race too; edge-triggered.
let startHeld = false;
function pollPadStart() {
  const down = [...navigator.getGamepads()].some((g) => g?.buttons[9]?.pressed);
  if (down && !startHeld && drive) leaveRace();
  startHeld = down;
}

// ---------- intro tour along the original intro-camera path (track list P1) ----------
let tourT = -1;
const TOUR_SECONDS = 178 / 30; // original plays it at the 30 Hz tick rate
ui.tour.onclick = () => {
  if (!current?.tour) return;
  stopDrive();
  tourT = 0;
  controls.enabled = false;
};

// ---------- UI ----------
for (const t of TRACKS) ui.track.add(new Option(t.name, t.key));
ui.track.onchange = () => loadTrack(TRACKS.find((t) => t.key === ui.track.value)!);
ui.quality.onchange = () => {
  quality = ui.quality.value as Quality;
  if (current) loadTrack(current.info);
};
ui.res.onchange = () => { resScale = +ui.res.value; resize(); };
ui.bloom.onchange = ui.shadows.onchange = ui.fog.onchange = applyQuality;
for (const c of CHARACTERS) ui.char.add(new Option(c.name, c.key));
ui.char.onchange = async () => { await loadCharacter(); lookAtRacer(); };
ui.anim.onchange = () => racer?.ch.setAnim(+ui.anim.value);
ui.look.onclick = lookAtRacer;
ui.rings.onchange = () => { if (current) current.rings.visible = ui.rings.checked; };
ui.music.onchange = () => {
  audio.mode = ui.music.value as MusicMode;
  if (audio.mode === 'off') audio.stopMusic();
  else stageMusic();
};
ui.sfx.onchange = () => { audio.sfxOn = ui.sfx.checked; };

async function begin(src: GameSource) {
  source = src;
  fileCache.clear();
  ui.start.hidden = true;
  await loadTrack(TRACKS[0]);
  showMenu();
}

// ---------- race menu: pick character and track, Esc from the race comes back here ----------
let gameMode = false;
const pick = { char: CHARACTERS[0].key, track: TRACKS[0].key };
function choices(box: HTMLElement, items: { key: string; name: string }[], get: () => string, set: (k: string) => void) {
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.name;
    b.dataset.key = it.key;
    b.onclick = () => {
      set(it.key);
      for (const o of box.children) o.classList.toggle('on', (o as HTMLElement).dataset.key === get());
    };
    box.append(b);
  }
  box.querySelector(`[data-key="${get()}"]`)?.classList.add('on');
}
choices(ui.menuChars, CHARACTERS, () => pick.char, (k) => { pick.char = k; });
choices(ui.menuTracks, TRACKS, () => pick.track, (k) => { pick.track = k; });

function showMenu() {
  gameMode = true;
  stopDrive();
  ui.panel.hidden = true;
  ui.menu.hidden = false;
  ui.menuGo.focus();
}
ui.menuGo.onclick = async () => {
  ui.menu.hidden = true;
  const track = TRACKS.find((t) => t.key === pick.track)!;
  if (current?.info !== track) {
    ui.track.value = track.key;
    await loadTrack(track);
  }
  ui.char.value = pick.char;
  ui.rivals.checked = ui.menuRivals.checked;
  await loadCharacter();
  await startDrive();
};
ui.menuViewer.onclick = () => {
  gameMode = false;
  ui.menu.hidden = true;
  ui.panel.hidden = false;
};
ui.toMenu.onclick = showMenu;

// Menu with arrows / d-pad / left stick: up-down between rows, left-right within a row
// (characters and tracks are picked as the focus lands on them); A or Enter activates.
function menuRows(): HTMLElement[][] {
  return [[...ui.menuChars.children], [...ui.menuTracks.children], [ui.menuRivals], [ui.menuGo, ui.menuViewer]] as HTMLElement[][];
}
function menuMove(dx: number, dy: number) {
  const rows = menuRows();
  let r = rows.findIndex((row) => row.includes(document.activeElement as HTMLElement));
  if (r < 0) { ui.menuGo.focus({ focusVisible: true } as FocusOptions); return; }
  let el: HTMLElement;
  if (dy) {
    r = Math.max(0, Math.min(rows.length - 1, r + dy));
    el = rows[r].find((b) => b.classList.contains('on')) ?? rows[r][0];
  } else {
    const row = rows[r], i = row.indexOf(document.activeElement as HTMLElement);
    el = row[(i + dx + row.length) % row.length];
  }
  el.focus({ focusVisible: true } as FocusOptions);
  if (r < 2) el.click();
}
addEventListener('keydown', (e) => {
  if (ui.menu.hidden) return;
  const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code];
  if (!d) return;
  e.preventDefault();
  menuMove(d[0], d[1]);
});
// Gamepad: edge-triggered with auto-repeat while held (standard mapping: 12-15 d-pad, 0 = A).
let padMenu = { dir: '', next: 0, a: false };
function pollPadMenu(now: number) {
  const g = [...navigator.getGamepads()].find((p) => p);
  if (!g || ui.menu.hidden) { padMenu = { dir: '', next: 0, a: !!g?.buttons[0]?.pressed }; return; }
  const ax = g.axes[0] ?? 0, ay = g.axes[1] ?? 0, btn = (i: number) => !!g.buttons[i]?.pressed;
  const dx = btn(15) || ax > 0.5 ? 1 : btn(14) || ax < -0.5 ? -1 : 0;
  const dy = btn(13) || ay > 0.5 ? 1 : btn(12) || ay < -0.5 ? -1 : 0;
  const dir = dy ? `0,${dy}` : dx ? `${dx},0` : '';
  if (dir && (dir !== padMenu.dir || now >= padMenu.next)) {
    menuMove(dy ? 0 : dx, dy);
    padMenu.next = now + (dir !== padMenu.dir ? 400 : 150);
  }
  padMenu.dir = dir;
  const a = btn(0);
  if (a && !padMenu.a) (document.activeElement instanceof HTMLElement && ui.menu.contains(document.activeElement) ? document.activeElement : ui.menuGo).click();
  padMenu.a = a;
}

ui.pick.onchange = () => {
  if (!ui.pick.files?.length) return;
  let files: Map<string, File>;
  try {
    files = pickedFiles(ui.pick.files);
  } catch (e) {
    ui.startMsg.textContent = (e as Error).message;
    return;
  }
  begin(folderSource(files));
  // Meanwhile, keep a copy in the browser so the next visit needs no folder pick.
  ui.copy.textContent = 'Guardando tu copia en el navegador…';
  saveCopy(files, (i, n) => { ui.copy.textContent = `Guardando tu copia en el navegador… ${Math.floor((i / n) * 100)}%`; })
    .then((ok) => {
      ui.copy.textContent = ok ? 'Copia guardada: la próxima vez arranca sola.' : 'Este navegador no puede guardar la copia; tendrás que elegir la carpeta cada vez.';
      ui.forget.hidden = !ok;
    });
};
ui.forget.onclick = async () => {
  await forgetCopy();
  location.reload();
};

// Start straight away when the game files are reachable (served with the page, or saved by an
// earlier visit); the folder pick is only the fallback, so no flash of it while we look.
ui.start.hidden = true;
ui.loading.hidden = false;
loadingText('Buscando los archivos del juego…');
(async () => {
  const s = (await webSource()) ?? (await savedSource());
  if (!s) {
    ui.loading.hidden = true;
    ui.start.hidden = false;
    return;
  }
  if (s.label.startsWith('copia guardada')) {
    ui.copy.textContent = 'Usando la copia guardada en el navegador.';
    ui.forget.hidden = false;
  }
  begin(s);
})();
registerServiceWorker();

// ---------- main loop ----------
const timer = new THREE.Timer();
let fps = 60, elapsed = 0;
renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  elapsed += dt;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (tourT >= 0 && current?.tour) {
    tourT += dt / TOUR_SECONDS;
    if (tourT >= 1) {
      tourT = -1;
      controls.enabled = true;
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      controls.lookAt(camera.position.clone().add(d));
    } else {
      // getPoint (not getPointAt): samples are evenly spaced in time, keep the original easing.
      camera.position.copy(current.tour.eye.getPoint(tourT));
      camera.lookAt(current.tour.target.getPoint(tourT));
    }
  }
  pollPadStart();
  pollPadMenu(now);
  if (drive) stepDrive(dt);
  else controls.update(dt);
  current?.update(elapsed);
  if (racer) {
    racer.ch.update(elapsed);
    if (racer.quality === 'remaster' && ui.shadows.checked) renderer.shadowMap.needsUpdate = true;
  }
  particles.update(dt, camera);
  composer.render(dt);

  if (current) {
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    ui.stats.textContent =
      `${fps.toFixed(0).padStart(3)} FPS   ${db.x}×${db.y}\n` +
      `${(current.tris / 1000).toFixed(1)}k triángulos · ${current.drawCalls} páginas de textura`;
  }
});

if (import.meta.env.DEV) Object.assign(window, { __viewer: { THREE, scene, camera, controls, renderer, composer, bloom, get current() { return current; }, get racer() { return racer; }, get drive() { return drive; }, audio, stepDrive } });
