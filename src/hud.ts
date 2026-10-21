/** Race HUD (DOM overlay): rings, lap, clock, lap times, countdown, position rank, and finish banner. */
import { LAPS, type Race } from './engine/race';

const $ = (id: string) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const el = {
  get hud() { return $('hud'); },
  get rings() { return $('hud-rings'); },
  get lap() { return $('hud-lap'); },
  get time() { return $('hud-time'); },
  get laps() { return $('hud-laps'); },
  get center() { return $('hud-center'); },
  get speed() { return $('hud-speed'); },
  get rank() { return $('hud-rank'); },
  get pos() { return $('hud-pos'); },
  get posSuffix() { return $('hud-pos-suffix'); },
  get results() { return $('results'); },
  get resultsPos() { return $('results-position'); },
  get resultsTime() { return $('results-time'); },
  get resultsLaps() { return $('results-laps')?.querySelector('tbody'); },
  get resultsRings() { return $('results-rings'); },
  get resultsRivals() { return $('results-rivals'); },
  get resultsRetry() { return $('results-retry'); },
  get resultsExit() { return $('results-exit'); },
};

/** Sonic R style clock: 1'23"45. */
export const fmt = (s: number) => {
  const cs = Math.floor(s * 100);
  return `${Math.floor(cs / 6000)}'${String(Math.floor(cs / 100) % 60).padStart(2, '0')}"${String(cs % 100).padStart(2, '0')}`;
};

let last = '';
export function showHud(on: boolean) {
  if (el.hud) el.hud.hidden = !on;
  if (el.results) el.results.hidden = true;
  last = '';
}

/** Ring pickup: the counter bumps. */
export function ringFlash() {
  const rings = el.rings;
  if (!rings) return;
  rings.classList.remove('bump');
  void rings.offsetWidth; // restart the CSS animation
  rings.classList.add('bump');
}

export interface StandingSummary {
  name: string;
  rank: number;
  finishTime: number;
  isPlayer?: boolean;
}

function setupResultsButtons() {
  const retryBtn = el.resultsRetry;
  const exitBtn = el.resultsExit;
  if (retryBtn && !retryBtn.dataset.bound) {
    retryBtn.dataset.bound = 'true';
    retryBtn.addEventListener('click', () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    });
  }
  if (exitBtn && !exitBtn.dataset.bound) {
    exitBtn.dataset.bound = 'true';
    exitBtn.addEventListener('click', () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    });
  }
}

export function updateHud(
  race: Race,
  countdownTicks: number,
  speedKmh: number,
  playerRank = 1,
  standings?: readonly StandingSummary[],
) {
  if (el.time) el.time.textContent = fmt(race.time);
  if (el.speed) el.speed.textContent = `${Math.round(speedKmh)} km/h`;

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

  if (el.rings) el.rings.textContent = String(race.ringCount);
  if (el.lap) el.lap.textContent = `${Math.min(race.lap, LAPS)}/${LAPS}`;
  const best = race.lapTimes.length ? Math.min(...race.lapTimes) : -1;
  if (el.laps) {
    el.laps.innerHTML = race.lapTimes
      .map((t, i) => `<li${t === best && race.lapTimes.length > 1 ? ' class="best"' : ''}>V${i + 1} ${fmt(t)}</li>`)
      .join('');
  }
  if (el.center) {
    el.center.textContent = center;
    el.center.className = race.finished ? 'finish' : center ? 'count' : '';
  }

  if (race.finished) {
    if (el.results) {
      el.results.hidden = false;
      setupResultsButtons();

      if (el.resultsPos) {
        el.resultsPos.textContent = rankWord;
        el.resultsPos.className = `pos-${Math.min(playerRank, 4)}`;
      }

      if (el.resultsTime) {
        el.resultsTime.textContent = fmt(race.time);
      }

      if (el.resultsLaps) {
        el.resultsLaps.innerHTML = race.lapTimes
          .map((t, i) => `<tr${t === best && race.lapTimes.length > 1 ? ' class="best"' : ''}><td>Vuelta ${i + 1}</td><td>${fmt(t)}</td></tr>`)
          .join('');
      }

      if (el.resultsRings) {
        el.resultsRings.textContent = `Anillos recogidos: ${race.ringCount}`;
      }

      if (el.resultsRivals && standings && standings.length > 1) {
        el.resultsRivals.innerHTML = standings
          .map((s) => `<div>${s.rank}º ${s.name}: ${s.finishTime > 0 ? fmt(s.finishTime) : 'En carrera'}</div>`)
          .join('');
      }
    }

    let summaryHtml = `<small>${fmt(race.time)} · ${race.ringCount} anillos · R para repetir</small>`;
    if (standings && standings.length > 1) {
      const rivalsText = standings
        .map((s) => `${s.rank}º ${s.name}${s.finishTime > 0 ? ` (${fmt(s.finishTime)})` : ''}`)
        .join(' · ');
      summaryHtml += `<small style="font-size: 15px; margin-top: 6px; color: var(--muted);">${rivalsText}</small>`;
    }
    el.center?.insertAdjacentHTML('beforeend', summaryHtml);
  } else {
    if (el.results) el.results.hidden = true;
  }
}
