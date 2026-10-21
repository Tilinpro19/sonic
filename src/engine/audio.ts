/**
 * Music and sound effects from the user's own copy.
 *
 * Music is CD audio in the original (PlayCD @ 0x4d01ac, MCI "cdaudio"); this repack ships it as
 * music/TrackNN.mp3. Race music (state machine 0x4d0bc4): track 3 (pre-race jingle) once, then
 * the stage track, restarted whenever it stops. Stage track = table 0x4fbed8[stageId] + offset:
 *   Island 6, City 7, Factory 9, Ruin 8, Emerald 10 (11 when Super Sonic races, 0x4fbef0);
 *   offset 0 with vocals, +6 for the instrumental versions (flag [0x8fb8e4]).
 * After the finish: 0x13 + (P1 position == winner) → 20 won / 19 lost [P]. Menus: 5.
 * Effects: sound/sfx/*.wav, the same files the exe names.
 */
export type MusicMode = 'vocal' | 'instrumental' | 'off';

const STAGE_TRACK: Record<number, number> = { 1: 6, 2: 7, 3: 9, 4: 8, 5: 10 };
export const PRE_RACE = 3, WON = 20, LOST = 19;

export function stageTrack(stageId: number, mode: MusicMode, superSonic = false) {
  const base = superSonic && stageId === 5 ? 11 : STAGE_TRACK[stageId] ?? 6;
  return base + (mode === 'instrumental' ? 6 : 0);
}

export const SFX = ['ring1', 'jump', 'ready', 'set', 'go', 'skid1', 'runleft', 'runright', 'spring', 'splash'] as const;
export type Sfx = (typeof SFX)[number];

type Get = (path: string) => Promise<Uint8Array>;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private buffers = new Map<Sfx, AudioBuffer>();
  private el = new window.Audio();
  private urls = new Map<number, Promise<string | null>>();
  private playing = -1;
  private then: (() => void) | null = null;
  mode: MusicMode = 'vocal';
  sfxOn = true;

  constructor(private get: Get) {
    this.el.addEventListener('ended', () => {
      const next = this.then;
      this.then = null;
      if (next) next();
    });
  }

  /** Browsers only allow audio after a user gesture: call from a click/key handler. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.7;
      this.sfxGain.connect(this.ctx.destination);
      for (const s of SFX) this.load(s);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.el.paused && this.playing >= 0 && this.el.src) this.el.play().catch(() => {});
  }

  private async load(s: Sfx) {
    try {
      const bytes = await this.get(`sound/sfx/${s}.wav`);
      this.buffers.set(s, await this.ctx!.decodeAudioData(bytes.slice().buffer));
    } catch { /* copy without that file: stay silent */ }
  }

  play(s: Sfx, volume = 1, rate = 1) {
    const b = this.buffers.get(s);
    if (!this.ctx || !b || !this.sfxOn || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.sfxGain!);
    src.start();
  }

  private url(track: number) {
    let u = this.urls.get(track);
    if (!u) {
      u = this.get(`music/Track${String(track).padStart(2, '0')}.mp3`)
        .then((b) => URL.createObjectURL(new Blob([b as BlobPart], { type: 'audio/mpeg' })))
        .catch(() => null);
      this.urls.set(track, u);
    }
    return u;
  }

  /** Plays CD track `n`; `loop` restarts it like the original, `then` runs when a one-shot ends. */
  async music(n: number, opts: { loop?: boolean; then?: () => void } = {}) {
    if (this.mode === 'off') return this.stopMusic();
    this.playing = n;
    this.then = opts.then ?? null;
    const url = await this.url(n);
    if (this.playing !== n) return; // superseded while loading
    if (!url) { this.then = null; opts.then?.(); return; }
    this.el.loop = !!opts.loop;
    if (this.el.src !== url) this.el.src = url;
    this.el.currentTime = 0;
    this.el.volume = 0.6;
    this.el.play().catch(() => { /* waits for unlock() */ });
  }

  stopMusic() {
    this.playing = -1;
    this.then = null;
    this.el.pause();
  }
}
