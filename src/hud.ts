/** Race HUD (DOM overlay): rings, lap, clock, lap times, countdown, position rank, and finish banner. */
import { LAPS, type Race } from './engine/race';

const $ = (id: string) => document.getElementById(id)!;
const el = {
  hud: $('hud'),
  rings: $('hud-rings'),
  lap: $('hud-lap'),
  time: $('hud-time'),
  laps: $('hud-laps'),
  center: $('hud-center'),
  speed: $('hud-speed'),
  rank: $('hud-rank'),
  pos: $('hud-pos'),
  posSuffix: $('hud-pos-suffix'),
};

/** Sonic R style clock: 1'23"45. */
export const fmt = (s: number) => {
  const cs = Math.floor(s * 100);
  return `${Math.floor(cs / 6000)}'${String(Math.floor(cs / 100) % 60).padStart(2, '0')}"${String(cs % 100).padStart(2, '0')}`;
};

let last = '';
export function showHud(on: boolean) {
  el.hud.hidden = !on;
  last = '';
}

/** Ring pickup: the counter bumps. */
export function ringFlash() {
  el.rings.classList.remove('bump');
  void el.rings.offsetWidth; // restart the CSS animation
  el.rings.classList.add('bump');
}

export interface StandingSummary {
  name: string;
  rank: number;
  finishTime: number;
  isPlayer?: boolean;
}

export function updateHud(
  race: Race,
  countdownTicks: number,
  speedKmh: number,
  playerRank = 1,
  standings?: readonly StandingSummary[],
) {
  el.time.textContent = fmt(race.time);
  el.speed.textContent = `${Math.round(speedKmh)} km/h`;

  // Update live rank badge
  if (el.pos) {
    el.pos.textContent = String(playerRank);
    if (el.rank) {
      el.rank.className = `hud-rank pos-${Math.min(playerRank, 4)}`;
    }
  }

  // The rest only changes on events: skip the DOM writes otherwise.
  const rankWord = playerRank === 1 ? '¡1º PUESTO!' : `¡${playerRank}º PUESTO!`;
  const center = countdownTicks > 0
    ? String(Math.ceil(countdownTicks / 30))
    : race.finished
      ? rankWord
      : race.ticks < 30
        ? '¡YA!'
        : '';

  const key = `${race.ringCount}|${race.lap}|${race.lapTimes.length}|${center}|${race.finished}|${playerRank}`;
  if (key === last) return;
  last = key;

  el.rings.textContent = String(race.ringCount);
  el.lap.textContent = `${Math.min(race.lap, LAPS)}/${LAPS}`;
  const best = race.lapTimes.length ? Math.min(...race.lapTimes) : -1;
  el.laps.innerHTML = race.lapTimes
    .map((t, i) => `<li${t === best && race.lapTimes.length > 1 ? ' class="best"' : ''}>V${i + 1} ${fmt(t)}</li>`)
    .join('');
  el.center.textContent = center;
  el.center.className = race.finished ? 'finish' : center ? 'count' : '';

  if (race.finished) {
    let summaryHtml = `<small>${fmt(race.time)} · ${race.ringCount} anillos · R para repetir</small>`;
    if (standings && standings.length > 1) {
      const rivalsText = standings
        .map((s) => `${s.rank}º ${s.name}${s.finishTime > 0 ? ` (${fmt(s.finishTime)})` : ''}`)
        .join(' · ');
      summaryHtml += `<small style="font-size: 15px; margin-top: 6px; color: var(--muted);">${rivalsText}</small>`;
    }
    el.center.insertAdjacentHTML('beforeend', summaryHtml);
  }
}
