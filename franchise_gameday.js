// franchise_gameday.js
// -----------------------------------------------------------------------------
// Franchise GM – Game Day
//
// Bridges your Franchise save + LeagueState.schedule to the Layer 3 engine:
//
//   import { loadLeague }   from "./data_models.js";
//   import { simulateGame } from "./game_engine.js";
//
// High-level flow:
//
//   1) Load FranchiseSave from localStorage ("franchiseGM_lastFranchise").
//   2) Read URL params ?week=&opp=&home= for opponent + home/away.
//   3) Load Layer 3 league via loadLeague(layer3_rosters.csv).
//   4) Map team codes -> engine Team objects.
//   5) If a LeagueState.schedule exists:
//        • Simulate your game for that week.
//        • Simulate all other still-scheduled games in that same week.
//        • Update both sides of each matchup in schedule.byTeam.
//        • Recompute your record + schedule-based stats + nextEvent.
//      If no schedule exists:
//        • Simulate just your game (one-off fallback).
//        • Update record incrementally.
//   6) Render a Game Day view (scoreboard + quick summary + simple play log).
//
// Expected DOM ids (adapt if your HTML differs):
//
//   Header:
//     #team-name-heading
//     #season-phase-line
//     #record-pill-value      (optional, record badge)
//
//   Scoreboard:
//     #gameday-home-name
//     #gameday-away-name
//     #gameday-home-score
//     #gameday-away-score
//     #gameday-score-meta     (e.g. "Final • Week 3")
//
//   Summary / log:
//     #gameday-summary-line
//     #gameday-play-log       (simple text log)
//     #gameday-other-results  (optional; league-wide week results)
//
//   Buttons:
//     #btn-gameday-sim        ("Sim Game" / "Simulate Week")
//     #btn-gameday-back       ("Back to hub")
//
// Typical link from schedule page:
//
//   franchise_gameday.html?week=3&opp=BUF&home=1
//
// where `home=1` means the user's team is home; `home=0` → away.
// -----------------------------------------------------------------------------

import { loadLeague } from "./data_models.js";
import { simulateGame as engineSimulateGame } from "./game_engine.js";
import {
    getTeamDisplayName as scheduleGetTeamDisplayName,
    recomputeRecordFromSchedule as scheduleRecomputeRecord
  } from "./league_schedule.js";

// -----------------------------------------------------------------------------
// Types (JSDoc – documentation only)
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} [teamName]
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {number} weekIndex          // 0-based "next game" index
 * @property {string} phase              // e.g. "Regular Season"
 * @property {string} record             // "W-L" or "W-L-T"
 * @property {string} lastPlayedISO
 *
 * @property {Object} [accolades]
 * @property {Object} [gmJob]
 * @property {Object} [leagueSummary]
 * @property {Object} [realismOptions]
 * @property {Object} [ownerExpectation]
 * @property {number} [gmCredibility]
 */

/**
 * @typedef {Object} TeamGame
 * @property {number} index              // 0-based index in schedule
 * @property {number} seasonWeek         // 1-based label
 * @property {string} teamCode
 * @property {string} opponentCode
 * @property {boolean} isHome
 * @property {"division"|"conference"|"nonconference"|"extra"} type
 * @property {string|null} kickoffIso
 * @property {"scheduled"|"final"} status
 * @property {number|null} teamScore
 * @property {number|null} opponentScore
 */

/**
 * @typedef {Object} LeagueSchedule
 * @property {number} seasonYear
 * @property {Object.<string, TeamGame[]>} byTeam
 */

/**
 * @typedef {Object} LeagueState
 * @property {string} franchiseId
 * @property {number} seasonYear
 * @property {Object} [timeline]
 * @property {Object} [timeline.nextEvent]
 * @property {string} [timeline.nextEvent.type]
 * @property {string} [timeline.nextEvent.label]
 * @property {string} [timeline.nextEvent.phase]
 * @property {number|null} [timeline.nextEvent.weekIndex]
 * @property {boolean|null} [timeline.nextEvent.isHome]
 * @property {string|null} [timeline.nextEvent.opponentName]
 * @property {string|null} [timeline.nextEvent.kickoffIso]
 *
 * @property {Object} [alerts]
 * @property {Object} [statsSummary]
 * @property {string} [statsSummary.record]
 * @property {number} [statsSummary.pointsFor]
 * @property {number} [statsSummary.pointsAgainst]
 * @property {string[]} [statsSummary.lastFive]
 * @property {number|null} [statsSummary.offenseRankPointsPerGame]
 * @property {number|null} [statsSummary.defenseRankPointsPerGame]
 * @property {number} [statsSummary.currentWeekIndex]
 *
 * @property {Array<Object>} [ownerNotes]
 * @property {Object} [debug]
 * @property {LeagueSchedule} [schedule]
 */

/**
 * @typedef {Object} EngineGamePayload
 * @property {Object} result
 * @property {Object} homeTeam
 * @property {Object} awayTeam
 * @property {string} homeCode
 * @property {string} awayCode
 */

// -----------------------------------------------------------------------------
// Storage keys & helpers
// -----------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function loadLastFranchise() {
  if (!storageAvailable()) return null;
  const raw = window.localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveLastFranchise(save) {
  if (!storageAvailable() || !save) return;
  try {
    window.localStorage.setItem(SAVE_KEY_LAST_FRANCHISE, JSON.stringify(save));
  } catch (err) {
    console.warn("[GameDay] Failed to save franchise:", err);
  }
}

function loadLeagueState(franchiseId) {
  if (!storageAvailable() || !franchiseId) return null;
  const raw = window.localStorage.getItem(getLeagueStateKey(franchiseId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveLeagueState(state) {
  if (!storageAvailable() || !state || !state.franchiseId) return;
  try {
    window.localStorage.setItem(
      getLeagueStateKey(state.franchiseId),
      JSON.stringify(state)
    );
  } catch (err) {
    console.warn("[GameDay] Failed to save league state:", err);
  }
}

// -----------------------------------------------------------------------------
// Team meta (for nice labels) – use shared league_schedule metadata
// -----------------------------------------------------------------------------

function getTeamDisplayNameFromCode(teamCode) {
    return scheduleGetTeamDisplayName(teamCode);
  }
  
  function getTeamNameFromSave(save) {
    if (save.teamName) return save.teamName;
    if (save.franchiseName) return save.franchiseName;
    return getTeamDisplayNameFromCode(save.teamCode || "");
  }
  

// -----------------------------------------------------------------------------
// League / engine wiring (Layer 3 rosters)
// -----------------------------------------------------------------------------

const PARAMS = new URLSearchParams(window.location.search);

// Allow overriding the CSV like simulation.html with ?players=<url>
const RAW_PLAYERS_PARAM = (PARAMS.get("players") || "").replace(
  "/refs/heads/",
  "/"
);

const DEFAULT_CSV_URL =
  "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/layer3_rosters.csv";

const CSV_URL = RAW_PLAYERS_PARAM || DEFAULT_CSV_URL;

let league = null;
let leagueLoadPromise = null;
/** @type {LeagueState|null} */
let gLeagueState = null;

function ensureLeagueLoaded() {
  if (!leagueLoadPromise) {
    leagueLoadPromise = (async () => {
      const lg = await loadLeague(CSV_URL);
      if (!lg || !Array.isArray(lg.teams) || !lg.teams.length) {
        throw new Error("League has no teams");
      }
      league = lg;
      return lg;
    })();
  }
  return leagueLoadPromise;
}

function findLeagueTeamByCode(code) {
  if (!league || !Array.isArray(league.teams)) return null;
  const target = (code || "").toLowerCase();

  return (
    league.teams.find(
      (t) => (t.teamId || t.id || "").toString().toLowerCase() === target
    ) ||
    league.teams.find(
      (t) => (t.abbr || "").toString().toLowerCase() === target
    ) ||
    league.teams.find((t) =>
      (t.team_name || t.teamName || t.displayName || "")
        .toString()
        .toLowerCase()
        .includes(target)
    ) ||
    null
  );
}

// -----------------------------------------------------------------------------
// Simple helpers
// -----------------------------------------------------------------------------

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function formatClockFromSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function parseRecord(recordStr) {
  if (!recordStr || typeof recordStr !== "string") {
    return { wins: 0, losses: 0, ties: 0 };
  }
  const m = recordStr.trim().match(/^(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return { wins: 0, losses: 0, ties: 0 };
  return {
    wins: Number(m[1]) || 0,
    losses: Number(m[2]) || 0,
    ties: Number(m[3]) || 0
  };
}

function getScoreFromResult(result, homeTeamId, awayTeamId) {
  if (!result) {
    return { home: 0, away: 0, quarter: 4, clock: "0:00" };
  }

  const score = result.score || result.finalScore || {};
  const meta = result.meta || {};
  const endState = result.gameStateEnd || {};

  let home =
    score.home ??
    score.homeScore ??
    result.homeScore ??
    (homeTeamId && typeof score[homeTeamId] === "number"
      ? score[homeTeamId]
      : 0);
  let away =
    score.away ??
    score.awayScore ??
    result.awayScore ??
    (awayTeamId && typeof score[awayTeamId] === "number"
      ? score[awayTeamId]
      : 0);

  home = safeNumber(home, 0);
  away = safeNumber(away, 0);

  const quarter =
    endState.quarter ??
    endState.qtr ??
    meta.quarter ??
    meta.qtr ??
    "Final";
  const clock =
    endState.clock ??
    endState.gameClock ??
    meta.clock ??
    "0:00";

  return { home, away, quarter, clock };
}

function getPlayLogFromResult(result) {
  if (!result) return [];
  if (Array.isArray(result.playLog)) return result.playLog;
  if (Array.isArray(result.plays)) return result.plays;
  return [];
}

// -----------------------------------------------------------------------------
// LeagueState schedule / stats / timeline helpers
// -----------------------------------------------------------------------------

/**
 * Recompute record purely from leagueState.schedule.byTeam.
 * Delegates to the shared helper in league_schedule.js.
 */
 function recomputeFranchiseRecordFromSchedule(leagueState, teamCode) {
    return scheduleRecomputeRecord(leagueState, teamCode);
  }
  

/**
 * Update both sides of a matchup in leagueState.schedule.byTeam for
 * the given week index.
 */
function updateWeekScheduleForMatchup(
  leagueState,
  weekIndex0,
  homeCode,
  awayCode,
  scores // { home, away }
) {
  if (
    !leagueState ||
    !leagueState.schedule ||
    !leagueState.schedule.byTeam
  ) {
    return;
  }

  const byTeam = leagueState.schedule.byTeam;

  const applyForTeam = (teamCode, oppCode, isHome) => {
    const games = byTeam[teamCode];
    if (!Array.isArray(games)) return;

    const game = games.find((g) => {
      const idx =
        typeof g.index === "number"
          ? g.index
          : typeof g.seasonWeek === "number"
          ? g.seasonWeek - 1
          : null;
      if (idx !== weekIndex0) return false;
      return g.opponentCode === oppCode;
    });

    if (!game) return;

    game.status = "final";
    game.teamScore = isHome ? scores.home : scores.away;
    game.opponentScore = isHome ? scores.away : scores.home;
  };

  applyForTeam(homeCode, awayCode, true);
  applyForTeam(awayCode, homeCode, false);
}

/**
 * Collect all *other* still-scheduled matchups for the given week.
 * Returns array of { homeCode, awayCode }.
 */
function collectOtherWeekMatchups(leagueState, userTeamCode, weekIndex0) {
  if (
    !leagueState ||
    !leagueState.schedule ||
    !leagueState.schedule.byTeam
  ) {
    return [];
  }

  const byTeam = leagueState.schedule.byTeam;
  const seen = new Set();
  const matchups = [];

  for (const [teamCode, games] of Object.entries(byTeam)) {
    if (!Array.isArray(games)) continue;

    for (const game of games) {
      const idx =
        typeof game.index === "number"
          ? game.index
          : typeof game.seasonWeek === "number"
          ? game.seasonWeek - 1
          : null;

      if (idx !== weekIndex0) continue;
      if (game.status && game.status !== "scheduled") continue;

      const oppCode = game.opponentCode;
      if (!oppCode) continue;

      // skip franchise game – handled separately
      if (teamCode === userTeamCode || oppCode === userTeamCode) {
        continue;
      }

      const pair = [teamCode, oppCode].sort();
      const key = `${pair[0]}-${pair[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let homeCode;
      let awayCode;

      if (game.isHome === true) {
        homeCode = teamCode;
        awayCode = oppCode;
      } else if (game.isHome === false) {
        homeCode = oppCode;
        awayCode = teamCode;
      } else {
        homeCode = pair[0];
        awayCode = pair[1];
      }

      matchups.push({ homeCode, awayCode });
    }
  }

  return matchups;
}

/**
 * Rebuild statsSummary from schedule for a single team:
 *   - record
 *   - pointsFor / pointsAgainst
 *   - lastFive (W/L/T)
 */
function updateStatsSummaryFromSchedule(leagueState, teamCode) {
  leagueState.statsSummary = leagueState.statsSummary || {};
  const stats = leagueState.statsSummary;

  const schedule = leagueState.schedule;
  if (!schedule || !schedule.byTeam || !schedule.byTeam[teamCode]) {
    // keep whatever was there; just ensure defaults
    stats.record = stats.record || "0-0";
    stats.pointsFor = stats.pointsFor || 0;
    stats.pointsAgainst = stats.pointsAgainst || 0;
    stats.lastFive = Array.isArray(stats.lastFive) ? stats.lastFive : [];
    return stats;
  }

  const games = schedule.byTeam[teamCode];
  let pf = 0;
  let pa = 0;
  const results = [];

  for (const g of games) {
    if (g.status !== "final") continue;
    const us = safeNumber(g.teamScore, NaN);
    const them = safeNumber(g.opponentScore, NaN);
    if (!Number.isFinite(us) || !Number.isFinite(them)) continue;

    pf += us;
    pa += them;

    if (us > them) results.push("W");
    else if (them > us) results.push("L");
    else results.push("T");
  }

  const record = recomputeFranchiseRecordFromSchedule(leagueState, teamCode);
  stats.record = record;
  stats.pointsFor = pf;
  stats.pointsAgainst = pa;
  stats.lastFive = results.slice(-5);

  return stats;
}

/**
 * Update leagueState.timeline.nextEvent from schedule for the franchise team.
 * Chooses the first non-final game as "next game"; if none, sets a simple
 * offseason placeholder event.
 */
function updateNextEventFromSchedule(leagueState, save) {
  if (!leagueState) return;
  const teamCode = save.teamCode;
  const seasonYear =
    save.seasonYear || leagueState.seasonYear || new Date().getFullYear();

  leagueState.timeline = leagueState.timeline || {};

  const schedule = leagueState.schedule;
  if (!schedule || !schedule.byTeam || !schedule.byTeam[teamCode]) {
    // no schedule – keep whatever default the hub created
    return;
  }

  const games = schedule.byTeam[teamCode];
  if (!Array.isArray(games) || !games.length) return;

  let upcoming = null;
  for (const g of games) {
    if (g.status === "final") continue;
    upcoming = g;
    break;
  }

  if (!upcoming) {
    // season complete – set generic offseason event
    const date = new Date(seasonYear + 1, 2, 15, 20, 0, 0, 0);
    leagueState.timeline.nextEvent = {
      type: "offseason",
      label: `${seasonYear + 1} Offseason – Free agency opens`,
      phase: "Offseason",
      weekIndex: null,
      isHome: null,
      opponentName: null,
      kickoffIso: date.toISOString()
    };
    return;
  }

  const idx =
    typeof upcoming.index === "number"
      ? upcoming.index
      : typeof upcoming.seasonWeek === "number"
      ? upcoming.seasonWeek - 1
      : null;

  const weekLabel =
    typeof upcoming.seasonWeek === "number"
      ? upcoming.seasonWeek
      : idx != null
      ? idx + 1
      : null;

  const oppName = getTeamDisplayNameFromCode(upcoming.opponentCode);
  const isHome = !!upcoming.isHome;

  leagueState.timeline.nextEvent = {
    type: "game",
    label:
      weekLabel != null
        ? `Week ${weekLabel} ${isHome ? "vs" : "at"} ${oppName}`
        : `Next game ${isHome ? "vs" : "at"} ${oppName}`,
    phase: save.phase || "Regular Season",
    weekIndex: idx,
    isHome,
    opponentName: oppName,
    kickoffIso: upcoming.kickoffIso || null
  };

  // keep save.weekIndex aligned with this "next game" index if available
  if (typeof idx === "number") {
    save.weekIndex = idx;
  }
}

// -----------------------------------------------------------------------------
// Engine bridge helpers
// -----------------------------------------------------------------------------

/**
 * Run a generic engine game for arbitrary home/away team codes.
 *
 * @param {string} homeCode
 * @param {string} awayCode
 * @param {FranchiseSave} save
 * @param {number|null} weekIndex0
 * @param {number|undefined} seedOverride
 * @param {Object} extraContext
 * @returns {Promise<EngineGamePayload>}
 */
async function runEngineGameGeneric(
  homeCode,
  awayCode,
  save,
  weekIndex0,
  seedOverride,
  extraContext = {}
) {
  await ensureLeagueLoaded();

  const homeTeam = findLeagueTeamByCode(homeCode);
  const awayTeam = findLeagueTeamByCode(awayCode);

  if (!homeTeam || !awayTeam) {
    throw new Error(
      `Could not find engine teams for home=${homeCode}, away=${awayCode}`
    );
  }

  const seed =
    seedOverride === undefined || seedOverride === null
      ? undefined
      : safeNumber(seedOverride, undefined);

  const options = {
    seed,
    mode: "full-game",
    context: {
      fromFranchise: true,
      franchiseId: save.franchiseId || null,
      seasonYear: save.seasonYear || null,
      weekIndex: typeof weekIndex0 === "number" ? weekIndex0 : null,
      homeTeamCode: homeCode,
      awayTeamCode: awayCode,
      ...extraContext
    }
  };

  const result = await Promise.resolve(
    engineSimulateGame(homeTeam, awayTeam, options)
  );

  return { result, homeTeam, awayTeam, homeCode, awayCode };
}

/**
 * Run a Layer 3 engine sim for the franchise matchup.
 *
 * @param {FranchiseSave} save
 * @param {string} opponentCode
 * @param {boolean} isFranchiseHome
 * @param {number|null} weekIndex0
 * @param {number|undefined} seedOverride
 * @returns {Promise<EngineGamePayload>}
 */
function runFranchiseEngineGame(
  save,
  opponentCode,
  isFranchiseHome,
  weekIndex0,
  seedOverride
) {
  const userCode = save.teamCode;
  const homeCode = isFranchiseHome ? userCode : opponentCode;
  const awayCode = isFranchiseHome ? opponentCode : userCode;

  return runEngineGameGeneric(homeCode, awayCode, save, weekIndex0, seedOverride, {
    userTeamCode: userCode,
    opponentCode
  });
}

// -----------------------------------------------------------------------------
// Play-by-play mode controls
// -----------------------------------------------------------------------------
let simMode = "instant"; // "instant" | "playbyplay"
let simSpeed = 1000; // delay between plays in ms

function setSimSpeedFromControl(value) {
  switch (value) {
    case "slow": simSpeed = 1800; break;
    case "fast": simSpeed = 400; break;
    default: simSpeed = 1000; break;
  }
}

async function runPlayByPlayGame(save, opponentCode, isHome, weekIndex0) {
    await ensureLeagueLoaded();
  
    const payload = await runFranchiseEngineGame(
      save,
      opponentCode,
      isHome,
      weekIndex0,
      Date.now()
    );
  
    const plays = getPlayLogFromResult(payload.result);
    const logEl = getEl("gameday-play-log");
    const summaryEl = getEl("gameday-summary-line");
    const pauseBtn = getEl("btn-gameday-pause");
    const skipBtn = getEl("btn-gameday-skip");
  
    if (!plays.length) {
      if (summaryEl) summaryEl.textContent = "No play-by-play log available.";
      return payload;
    }
  
    logEl.innerHTML = "";
    if (summaryEl) summaryEl.textContent = `Playing live simulation (${plays.length} plays)…`;
  
    // Initialize controls
    playByPlayControl.isPlaying = true;
    playByPlayControl.isPaused = false;
    playByPlayControl.shouldSkip = false;
  
    pauseBtn.disabled = false;
    skipBtn.disabled = false;
  
    const speedSel = getEl("sim-speed-select");
    const speed = speedSel?.value || "normal";
    const speedMap = { slow: 800, normal: 400, fast: 150 };
    const delayMs = speedMap[speed] || 400;
  
    for (let i = 0; i < plays.length; i++) {
      if (playByPlayControl.shouldSkip) {
        for (let j = i; j < plays.length; j++) {
          const div = document.createElement("div");
          div.className = "gameday-log-line";
          div.textContent = plays[j].text || plays[j].description || "[play]";
          logEl.appendChild(div);
        }
        break;
      }
  
      while (playByPlayControl.isPaused && !playByPlayControl.shouldSkip) {
        await new Promise((r) => setTimeout(r, 100));
      }
  
      const p = plays[i];
      const div = document.createElement("div");
      div.className = "gameday-log-line new-play";
  
      const q = p.quarter ?? p.qtr ?? "";
      const clock = p.clock ?? p.gameClock ?? "";
      const prefix = [q ? `Q${q}` : "", clock].filter(Boolean).join(" • ");
  
      div.textContent = prefix ? `${prefix} — ${p.text || p.description}` : p.text || p.description || "[play]";
  
      const tags = (p.tags || []).map((t) => t.toUpperCase());
      if (p.isScoring || tags.includes("TD") || tags.includes("FG")) {
        div.classList.add("scoring");
      }
  
      logEl.appendChild(div);
      logEl.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" });
  
      await new Promise((r) => setTimeout(r, delayMs));
    }
  
    playByPlayControl.isPlaying = false;
    playByPlayControl.isPaused = false;
    playByPlayControl.shouldSkip = false;
  
    pauseBtn.disabled = true;
    skipBtn.disabled = true;
  
    if (summaryEl) summaryEl.textContent = "Play-by-play complete.";
    return payload;
  }
  

  // -----------------------------------------------------------------------------
  // Play-by-play control state
  // -----------------------------------------------------------------------------

  const playByPlayControl = {
    isPlaying: false,
    isPaused: false,
    shouldSkip: false
  };
  
  


// -----------------------------------------------------------------------------
// Sim flows
// -----------------------------------------------------------------------------

/**
 * Option 1 behavior:
 *   • Simulate the franchise game for this week.
 *   • Simulate all other still-scheduled games in the same week.
 *   • Update schedule for both sides for each matchup.
 *   • Recompute record + statsSummary + nextEvent.
 *
 * Returns an object with:
 *   {
 *     userGame: { ...EngineGamePayload, scores, recordAfter },
 *     otherResults: [
 *       { homeCode, awayCode, homeTeam, awayTeam, result, scores }
 *     ]
 *   }
 */
async function simulateFullWeekWithFranchiseGame(
  save,
  leagueState,
  opponentCode,
  isFranchiseHome,
  weekIndex0
) {
  const baseSeed = Date.now() & 0xffffffff;

  // 1) Franchise game
  const userGamePayload = await runFranchiseEngineGame(
    save,
    opponentCode,
    isFranchiseHome,
    weekIndex0,
    baseSeed
  );

  const homeId = userGamePayload.homeTeam.teamId || userGamePayload.homeTeam.id;
  const awayId = userGamePayload.awayTeam.teamId || userGamePayload.awayTeam.id;

  const userScores = getScoreFromResult(
    userGamePayload.result,
    homeId,
    awayId
  );

  updateWeekScheduleForMatchup(
    leagueState,
    weekIndex0,
    userGamePayload.homeCode,
    userGamePayload.awayCode,
    { home: userScores.home, away: userScores.away }
  );

  // 2) Other games in same week
  const otherMatchups = collectOtherWeekMatchups(
    leagueState,
    save.teamCode,
    weekIndex0
  );
  const otherResults = [];

  for (let i = 0; i < otherMatchups.length; i++) {
    const m = otherMatchups[i];

    const {
      result,
      homeTeam,
      awayTeam,
      homeCode,
      awayCode
    } = await runEngineGameGeneric(
      m.homeCode,
      m.awayCode,
      save,
      weekIndex0,
      baseSeed + i + 1,
      { autoSim: true }
    );

    const hId = homeTeam.teamId || homeTeam.id;
    const aId = awayTeam.teamId || awayTeam.id;
    const scores = getScoreFromResult(result, hId, aId);

    updateWeekScheduleForMatchup(
      leagueState,
      weekIndex0,
      homeCode,
      awayCode,
      { home: scores.home, away: scores.away }
    );

    otherResults.push({
      homeCode,
      awayCode,
      homeTeam,
      awayTeam,
      result,
      scores
    });
  }

  // 3) Recompute record and stats from schedule, advance week, update timeline
  const newRecord = recomputeFranchiseRecordFromSchedule(
    leagueState,
    save.teamCode
  );

  save.record = newRecord;
  save.lastPlayedISO = new Date().toISOString();

  // temporary next index – refine via updateNextEventFromSchedule
  const currentWeekIndex =
    typeof save.weekIndex === "number" ? save.weekIndex : 0;
  if (currentWeekIndex <= weekIndex0) {
    save.weekIndex = weekIndex0 + 1;
  }

  updateStatsSummaryFromSchedule(leagueState, save.teamCode);

  leagueState.statsSummary.currentWeekIndex = save.weekIndex;

  updateNextEventFromSchedule(leagueState, save);

  saveLastFranchise(save);
  saveLeagueState(leagueState);

  return {
    userGame: {
      ...userGamePayload,
      scores: userScores,
      recordAfter: save.record
    },
    otherResults
  };
}

/**
 * Fallback behavior when no schedule is present:
 *   • Simulate just the franchise game.
 *   • Incrementally update record (W/L).
 */
async function simulateSingleFranchiseGameWithoutSchedule(
  save,
  opponentCode,
  isFranchiseHome,
  weekIndex0
) {
  const payload = await runFranchiseEngineGame(
    save,
    opponentCode,
    isFranchiseHome,
    weekIndex0,
    undefined
  );

  const homeId = payload.homeTeam.teamId || payload.homeTeam.id;
  const awayId = payload.awayTeam.teamId || payload.awayTeam.id;
  const scores = getScoreFromResult(payload.result, homeId, awayId);

  const userIsHome = isFranchiseHome;
  const userScore = userIsHome ? scores.home : scores.away;
  const oppScore = userIsHome ? scores.away : scores.home;

  const { wins, losses, ties } = parseRecord(save.record || "0-0");
  let newWins = wins;
  let newLosses = losses;
  let newTies = ties;

  if (userScore > oppScore) newWins++;
  else if (oppScore > userScore) newLosses++;
  else newTies++;

  save.record =
    newTies > 0 ? `${newWins}-${newLosses}-${newTies}` : `${newWins}-${newLosses}`;
  save.lastPlayedISO = new Date().toISOString();

  // Advance weekIndex optimistically
  const wIdx = typeof save.weekIndex === "number" ? save.weekIndex : 0;
  if (wIdx <= (weekIndex0 ?? wIdx)) {
    save.weekIndex = (weekIndex0 ?? wIdx) + 1;
  }

  saveLastFranchise(save);

  return {
    userGame: {
      ...payload,
      scores,
      recordAfter: save.record
    },
    otherResults: []
  };
}

// -----------------------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = getEl(id);
  if (el) el.textContent = text;
}

// -----------------------------------------------------------------------------
// Rendering – pregame & postgame
// -----------------------------------------------------------------------------

function renderPregameHeader(save, opponentCode, isFranchiseHome, weekIndex0) {
  const teamName = getTeamNameFromSave(save);
  const oppName = opponentCode
    ? getTeamDisplayNameFromCode(opponentCode)
    : "TBD";
  const year = save.seasonYear || "";
  const weekLabel =
    typeof weekIndex0 === "number" ? weekIndex0 + 1 : (save.weekIndex || 0) + 1;

  setText("team-name-heading", teamName);
  setText("season-phase-line", `${year} • Week ${weekLabel} • Game Day`);

  const matchupLabel = opponentCode
    ? isFranchiseHome
      ? `${teamName} vs ${oppName}`
      : `${teamName} at ${oppName}`
    : "Matchup TBD";

  setText("gameday-home-name", isFranchiseHome ? teamName : oppName);
  setText("gameday-away-name", isFranchiseHome ? oppName : teamName);

  const recordText = save.record || "0-0";
  setText("record-pill-value", recordText);

  const metaEl = getEl("gameday-score-meta");
  if (metaEl) {
    metaEl.textContent = `Week ${weekLabel} • Pre-game – ${matchupLabel}`;
  }

  const summaryEl = getEl("gameday-summary-line");
  if (summaryEl) {
    summaryEl.textContent = opponentCode
      ? "Ready to simulate your Game Day matchup."
      : "No opponent set. Launch Game Day from the schedule so ?opp=TEAMCODE is provided.";
  }
}

/**
 * Render other week results in a compact list if #gameday-other-results exists.
 */
function renderOtherWeekResults(otherResults, seasonWeekLabel) {
  const container = getEl("gameday-other-results");
  if (!container) return;

  container.innerHTML = "";

  if (!otherResults || !otherResults.length) {
    const p = document.createElement("div");
    p.textContent = "No other league games were simulated this week.";
    container.appendChild(p);
    return;
  }

  const header = document.createElement("div");
  header.className = "gameday-other-header";
  header.textContent = `Week ${seasonWeekLabel} – other finals`;
  container.appendChild(header);

  otherResults.forEach((g) => {
    const row = document.createElement("div");
    row.className = "gameday-other-row";

    const homeName = getTeamDisplayNameFromCode(g.homeCode);
    const awayName = getTeamDisplayNameFromCode(g.awayCode);

    const homeScore = safeNumber(g.scores.home, 0);
    const awayScore = safeNumber(g.scores.away, 0);

    row.textContent = `${awayName} ${awayScore} @ ${homeName} ${homeScore}`;
    container.appendChild(row);
  });
}

/**
 * Render postgame result + play log for the franchise game.
 */
function renderPostgameResult(
  result,
  homeTeam,
  awayTeam,
  homeCode,
  awayCode,
  save,
  opponentCode,
  isFranchiseHome,
  weekIndex0,
) {
  const homeId = homeTeam.teamId || homeTeam.id;
  const awayId = awayTeam.teamId || awayTeam.id;

  const { home, away, quarter, clock } = getScoreFromResult(
    result,
    homeId,
    awayId
  );

  const userCode = save.teamCode;
  const userIsHome = isFranchiseHome;
  const userScore = userIsHome ? home : away;
  const oppScore = userIsHome ? away : home;

  // Scoreboard numbers
  setText("gameday-home-score", String(home));
  setText("gameday-away-score", String(away));

  const teamName = getTeamNameFromSave(save);
  const oppName = getTeamDisplayNameFromCode(opponentCode);
  const weekLabel =
    typeof weekIndex0 === "number" ? weekIndex0 + 1 : (save.weekIndex || 0);

  const isFinal =
    quarter === "Final" || quarter === 4 || quarter === "4";
  const statusLabel = isFinal ? "Final" : `Q${quarter} ${clock || ""}`.trim();

  const metaEl = getEl("gameday-score-meta");
  if (metaEl) {
    metaEl.textContent = `${statusLabel} • Week ${weekLabel}`;
  }

  const isWin = userScore > oppScore;
  const summaryEl = getEl("gameday-summary-line");
  if (summaryEl) {
    const resWord = isWin ? "win" : userScore === oppScore ? "tie" : "loss";
    const scoreLine = userIsHome
      ? `${teamName} ${userScore} – ${oppName} ${oppScore}`
      : `${oppName} ${oppScore} – ${teamName} ${userScore}`;

    const recordText = save.record || "0-0";
    summaryEl.textContent = `${statusLabel}: ${scoreLine} (${resWord}). Record: ${recordText}.`;
  }

  // Play log – scoring / key plays bolded
  const logEl = getEl("gameday-play-log");
  if (logEl) {
    logEl.innerHTML = "";
    const plays = getPlayLogFromResult(result);
    if (!plays.length) {
      const p = document.createElement("div");
      p.textContent = "No play-by-play log available from engine.";
      logEl.appendChild(p);
    } else {
      plays.forEach((p, idx) => {
        if (idx > 199) return; // keep from getting huge
        const div = document.createElement("div");
        div.className = "gameday-log-line";

        const q = p.quarter ?? p.qtr ?? "";
        const clockStr =
          p.clock ??
          p.gameClock ??
          (Number.isFinite(p.clockSec)
            ? formatClockFromSeconds(p.clockSec)
            : "");

        const tags = (p.tags || []).map((t) => String(t).toUpperCase());
        const isScoring =
          p.isScoring || tags.includes("TD") || tags.includes("FG");

        const prefixParts = [];
        if (q) prefixParts.push(`Q${q}`);
        if (clockStr) prefixParts.push(clockStr);
        if (p.downAndDistance) prefixParts.push(p.downAndDistance);
        const prefix = prefixParts.join(" • ");

        div.textContent = `${prefix ? prefix + " – " : ""}${
          p.text || p.description || p.desc || "[play]"
        }`;

        if (isScoring) {
          div.style.fontWeight = "600";
        }

        logEl.appendChild(div);
      });
    }
  }

  if (result) {
    renderDriveSummary(result);
    renderTeamStats(result);
    renderPlayerBox(result);
  }
}

// -----------------------------------------------------------------------------
// Rendering – drive summary, team stats, player box
// -----------------------------------------------------------------------------
function renderDriveSummary(result) {
    const table = document.querySelector("#drive-summary-table tbody");
    if (!table) return;
    table.innerHTML = "";
  
    const drives = result.drives || [];
    if (!drives.length) {
      table.innerHTML = `<tr><td colspan="6">No drives recorded.</td></tr>`;
      return;
    }
  
    drives.forEach((d, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${d.offense === "home" ? result.homeTeamName : result.awayTeamName}</td>
        <td>${d.result}</td>
        <td>${d.playCount}</td>
        <td>${d.yards}</td>
        <td>${Math.round(d.durationSec / 60)}:${String(Math.round(d.durationSec % 60)).padStart(2,"0")}</td>
      `;
      table.appendChild(tr);
    });
  }
  
  function renderTeamStats(result) {
    const table = document.querySelector("#team-stats-table tbody");
    if (!table) return;
    table.innerHTML = "";
  
    const stats = result.teamStats || {};
    const home = stats.home || {};
    const away = stats.away || {};
  
    const row = (teamName, s) => `
      <tr>
        <td>${teamName}</td>
        <td>${s.yardsTotal ?? 0}</td>
        <td>${(s.yardsPerPlay ?? 0).toFixed(1)}</td>
        <td>${s.rushYards ?? 0}</td>
        <td>${s.passYards ?? 0}</td>
        <td>${s.turnovers ?? 0}</td>
        <td>${((s.yardsTotal ?? 0) / 10).toFixed(2)}</td>
      </tr>
    `;
  
    table.innerHTML = row(result.awayTeamName, away) + row(result.homeTeamName, home);
  }
  
  function renderPlayerBox(result) {
    const table = document.querySelector("#player-stats-table tbody");
    if (!table) return;
    table.innerHTML = "";
  
    const players = Object.values(result.playerStats || {});
    if (!players.length) {
      table.innerHTML = `<tr><td colspan="17">No player stats recorded.</td></tr>`;
      return;
    }
  
    players.slice(0, 100).forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${p.name}</td>
        <td>${p.teamName || ""}</td>
        <td>${p.position || ""}</td>
        <td>${p.passCmp}/${p.passAtt}</td>
        <td>${p.passYds}</td>
        <td>${p.passTD}</td>
        <td>${p.passInt}</td>
        <td>${p.rushAtt}</td>
        <td>${p.rushYds}</td>
        <td>${p.rushTD}</td>
        <td>${p.targets}</td>
        <td>${p.receptions}</td>
        <td>${p.recYds}</td>
        <td>${p.recTD}</td>
        <td>${p.fgMade}/${p.fgAtt}</td>
        <td>${p.xpMade}/${p.xpAtt}</td>
        <td>${p.puntAtt}</td>
      `;
      table.appendChild(tr);
    });
  }
  

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

async function initGameDay() {
  const save = loadLastFranchise();
  if (!save) {
    console.warn("[GameDay] No active franchise found.");
    setText(
      "gameday-summary-line",
      "No active franchise found. Return to the main menu."
    );
    const back = getEl("btn-gameday-back");
    if (back) {
      back.addEventListener("click", () => {
        window.location.href = "main_page.html";
      });
    }
    return;
  }

  // Load LeagueState if available (for schedule / stats / nextEvent)
  gLeagueState = loadLeagueState(save.franchiseId);

  const defaultWeekIndex =
    typeof save.weekIndex === "number" ? save.weekIndex : 0;

  let weekIndex0 = PARAMS.has("week")
    ? safeNumber(PARAMS.get("week"), defaultWeekIndex)
    : defaultWeekIndex;

  let opponentCode = PARAMS.get("opp") || null;

  // Home/away from URL param first
  const homeParam = PARAMS.get("home");
  let isFranchiseHome;
  if (homeParam === "1" || homeParam === "true") {
    isFranchiseHome = true;
  } else if (homeParam === "0" || homeParam === "false") {
    isFranchiseHome = false;
  } else {
    isFranchiseHome = true; // default if not provided
  }

  // If we have a schedule, align week/opponent/home with it
  if (
    gLeagueState &&
    gLeagueState.schedule &&
    gLeagueState.schedule.byTeam &&
    gLeagueState.schedule.byTeam[save.teamCode]
  ) {
    const games = gLeagueState.schedule.byTeam[save.teamCode];
    if (Array.isArray(games) && games.length) {
      let scheduledGame =
        games.find((g) => typeof g.index === "number" && g.index === weekIndex0) ||
        games.find(
          (g) =>
            typeof g.seasonWeek === "number" &&
            g.seasonWeek === weekIndex0 + 1
        );

      if (!scheduledGame && typeof save.weekIndex === "number") {
        scheduledGame =
          games.find(
            (g) => typeof g.index === "number" && g.index === save.weekIndex
          ) ||
          games.find(
            (g) =>
              typeof g.seasonWeek === "number" &&
              g.seasonWeek === save.weekIndex + 1
          );
      }

      if (scheduledGame) {
        if (!opponentCode || opponentCode !== scheduledGame.opponentCode) {
          opponentCode = scheduledGame.opponentCode;
        }
        if (typeof scheduledGame.index === "number") {
          weekIndex0 = scheduledGame.index;
        } else if (typeof scheduledGame.seasonWeek === "number") {
          weekIndex0 = scheduledGame.seasonWeek - 1;
        }
        if (homeParam == null && typeof scheduledGame.isHome === "boolean") {
          isFranchiseHome = scheduledGame.isHome;
        }
      }
    }
  }

  // Pre-game header
  renderPregameHeader(save, opponentCode, isFranchiseHome, weekIndex0);

  const simBtn = getEl("btn-gameday-sim");
  const backBtn = getEl("btn-gameday-back");
  const pauseBtn = getEl("btn-gameday-pause");
  const skipBtn = getEl("btn-gameday-skip");

  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      if (!playByPlayControl.isPlaying) return;
      playByPlayControl.isPaused = !playByPlayControl.isPaused;
      pauseBtn.textContent = playByPlayControl.isPaused ? "Resume" : "Pause";
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      if (!playByPlayControl.isPlaying) return;
      playByPlayControl.shouldSkip = true;
    });
  }


  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }

  if (!simBtn || !opponentCode) {
    if (simBtn) {
      simBtn.disabled = true;
      simBtn.textContent = "Opponent not set";
    }
    return;
  }

  simBtn.disabled = true;
  simBtn.textContent = "Loading engine…";

  try {
    await ensureLeagueLoaded();

    const hasSchedule =
      gLeagueState &&
      gLeagueState.schedule &&
      gLeagueState.schedule.byTeam &&
      gLeagueState.schedule.byTeam[save.teamCode];

    simBtn.textContent = hasSchedule ? "Week Simulated" : "Game Simulated";
    simBtn.disabled = true;      

    simBtn.addEventListener("click", async () => {
        if (simBtn.disabled) return;
        simBtn.disabled = true;
      
        const modeSelect = document.getElementById("sim-mode-select");
        const speedSelect = document.getElementById("sim-speed-select");
        simMode = modeSelect ? modeSelect.value : "instant";
        setSimSpeedFromControl(speedSelect ? speedSelect.value : "normal");
      
        simBtn.textContent = simMode === "playbyplay" ? "Playing…" : "Simulating…";
      
        try {
          let payload;
          if (simMode === "playbyplay") {
            payload = await runPlayByPlayGame(save, opponentCode, isFranchiseHome, weekIndex0);
          } else if (hasSchedule) {
            payload = await simulateFullWeekWithFranchiseGame(save, gLeagueState, opponentCode, isFranchiseHome, weekIndex0);
          } else {
            payload = await simulateSingleFranchiseGameWithoutSchedule(save, opponentCode, isFranchiseHome, weekIndex0);
          }
      
          const { userGame, otherResults } = payload;
      
          if (userGame && userGame.result) {
            renderPostgameResult(
              userGame.result,
              userGame.homeTeam,
              userGame.awayTeam,
              userGame.homeCode,
              userGame.awayCode,
              save,
              opponentCode,
              isFranchiseHome,
              weekIndex0
            );
          }
      
          simBtn.textContent = "Week Simulated";
          simBtn.disabled = true;
      
        } catch (err) {
          console.error("[GameDay] Simulation failed:", err);
          setText("gameday-summary-line", `Simulation failed: ${err.message}`);
          simBtn.textContent = "Simulation failed";
          simBtn.disabled = false;
        }
      });      
  } catch (err) {
    console.error("[GameDay] Engine/league load error:", err);
    simBtn.disabled = true;
    simBtn.textContent = "Engine unavailable";
    setText(
      "gameday-summary-line",
      "Failed to load game engine. Check network / console."
    );
  }
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGameDay);
} else {
  initGameDay();
}
