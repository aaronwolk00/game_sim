// franchise_gameday.js
// -----------------------------------------------------------------------------
// Franchise GM – Game Day
//
// Wires the Franchise save + schedule to your existing Layer 3 engine:
//
//   import { simulateGame } from "./game_engine.js";
//   import { loadLeague }   from "./data_models.js";
//
// Flow:
//   1) Load FranchiseSave from localStorage ("franchiseGM_lastFranchise").
//   2) Read URL params ?week=&opp=&home= for opponent + home/away.
//   3) Load Layer 3 league via loadLeague(layer3_rosters.csv).
//   4) Map team codes -> engine Team objects.
//   5) Call simulateGame(homeTeam, awayTeam, { seed, mode: "full-game", context… }).
//   6) Render a postgame summary & update Franchise record + LeagueState schedule.
//
// Expected DOM ids (adapt as needed in your HTML):
//   Header:
//     #team-name-heading
//     #season-phase-line
//     #record-pill-value      (optional, record badge)
//   Scoreboard:
//     #gameday-home-name
//     #gameday-away-name
//     #gameday-home-score
//     #gameday-away-score
//     #gameday-score-meta     (e.g. "Final • Week 3")
//   Summary / log:
//     #gameday-summary-line
//     #gameday-play-log       (simple text log)
//   Buttons:
//     #btn-gameday-sim        ("Sim Game")
//     #btn-gameday-back       ("Back to hub")
//
// Link from schedule page like:
//   gameday.html?week=3&opp=BUF&home=1
// where `home=1` means the user's franchise is home; `home=0` → away.
// -----------------------------------------------------------------------------

import { loadLeague } from "./data_models.js";
import { simulateGame as engineSimulateGame } from "./game_engine.js";

// -----------------------------------------------------------------------------
// Storage keys (shared with franchise.js / schedule.js)
// -----------------------------------------------------------------------------
const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

// -----------------------------------------------------------------------------
// LocalStorage helpers
// -----------------------------------------------------------------------------
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
// Team meta (for nice labels if you want them)
// -----------------------------------------------------------------------------
const TEAM_META = [
  // AFC East
  { teamCode: "BUF", city: "Buffalo", name: "Bills" },
  { teamCode: "MIA", city: "Miami", name: "Dolphins" },
  { teamCode: "NE",  city: "New England", name: "Patriots" },
  { teamCode: "NYJ", city: "New York", name: "Jets" },
  // AFC North
  { teamCode: "BAL", city: "Baltimore", name: "Ravens" },
  { teamCode: "CIN", city: "Cincinnati", name: "Bengals" },
  { teamCode: "CLE", city: "Cleveland", name: "Browns" },
  { teamCode: "PIT", city: "Pittsburgh", name: "Steelers" },
  // AFC South
  { teamCode: "HOU", city: "Houston", name: "Texans" },
  { teamCode: "IND", city: "Indianapolis", name: "Colts" },
  { teamCode: "JAX", city: "Jacksonville", name: "Jaguars" },
  { teamCode: "TEN", city: "Tennessee", name: "Titans" },
  // AFC West
  { teamCode: "DEN", city: "Denver", name: "Broncos" },
  { teamCode: "KC",  city: "Kansas City", name: "Chiefs" },
  { teamCode: "LV",  city: "Las Vegas", name: "Raiders" },
  { teamCode: "LAC", city: "Los Angeles", name: "Chargers" },
  // NFC East
  { teamCode: "DAL", city: "Dallas", name: "Cowboys" },
  { teamCode: "NYG", city: "New York", name: "Giants" },
  { teamCode: "PHI", city: "Philadelphia", name: "Eagles" },
  { teamCode: "WAS", city: "Washington", name: "Commanders" },
  // NFC North
  { teamCode: "CHI", city: "Chicago", name: "Bears" },
  { teamCode: "DET", city: "Detroit", name: "Lions" },
  { teamCode: "GB",  city: "Green Bay", name: "Packers" },
  { teamCode: "MIN", city: "Minnesota", name: "Vikings" },
  // NFC South
  { teamCode: "ATL", city: "Atlanta", name: "Falcons" },
  { teamCode: "CAR", city: "Carolina", name: "Panthers" },
  { teamCode: "NO",  city: "New Orleans", name: "Saints" },
  { teamCode: "TB",  city: "Tampa Bay", name: "Buccaneers" },
  // NFC West
  { teamCode: "ARI", city: "Arizona", name: "Cardinals" },
  { teamCode: "LAR", city: "Los Angeles", name: "Rams" },
  { teamCode: "SF",  city: "San Francisco", name: "49ers" },
  { teamCode: "SEA", city: "Seattle", name: "Seahawks" }
];

function getTeamMeta(teamCode) {
  return TEAM_META.find((t) => t.teamCode === teamCode) || null;
}

function getTeamDisplayNameFromCode(teamCode) {
  const meta = getTeamMeta(teamCode);
  if (!meta) return teamCode || "Unknown Team";
  return `${meta.city} ${meta.name}`;
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

function getScoreFromResult(result, homeTeamId, awayTeamId) {
  if (!result) {
    return { home: 0, away: 0, quarter: 4, clock: "0:00" };
  }

  const score = result.score || result.finalScore || {};
  const meta = result.meta || {};
  const endState = result.gameStateEnd || {};

  // Try home/away-style first, then teamId-indexed map
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
// Main sim bridge: use your engine for a franchise matchup
// -----------------------------------------------------------------------------
/**
 * Run a Layer 3 engine sim for the current franchise matchup.
 *
 * @param {Object} save FranchiseSave from localStorage
 * @param {string} opponentCode - e.g. "BUF"
 * @param {boolean} isFranchiseHome
 * @param {number} weekIndex0 - 0-based week index
 * @param {number|undefined} seedOverride
 * @returns {Promise<{result, homeTeam, awayTeam, homeCode, awayCode}>}
 */
async function runFranchiseEngineGame(
  save,
  opponentCode,
  isFranchiseHome,
  weekIndex0,
  seedOverride
) {
  await ensureLeagueLoaded();

  const userCode = save.teamCode;
  const homeCode = isFranchiseHome ? userCode : opponentCode;
  const awayCode = isFranchiseHome ? opponentCode : userCode;

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
      userTeamCode: userCode,
      opponentCode
    }
  };

  const result = await Promise.resolve(
    engineSimulateGame(homeTeam, awayTeam, options)
  );

  return { result, homeTeam, awayTeam, homeCode, awayCode };
}

// -----------------------------------------------------------------------------
// Franchise record + schedule update
// -----------------------------------------------------------------------------
function parseRecord(recordStr) {
  if (!recordStr || typeof recordStr !== "string") {
    return { wins: 0, losses: 0 };
  }
  const m = recordStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return { wins: 0, losses: 0 };
  return { wins: Number(m[1]) || 0, losses: Number(m[2]) || 0 };
}

function updateRecordAfterGame(save, isWin) {
  const { wins, losses } = parseRecord(save.record || "0-0");
  const newWins = wins + (isWin ? 1 : 0);
  const newLosses = losses + (isWin ? 0 : 1);
  save.record = `${newWins}-${newLosses}`;
  save.lastPlayedISO = new Date().toISOString();
  // Optional: advance weekIndex here, or leave that to a separate "advance week" flow
  return save.record;
}

/**
 * Try to mark this week as "final" in LeagueState.schedule if it exists.
 */
function updateLeagueScheduleAfterGame(
  leagueState,
  save,
  opponentCode,
  isFranchiseHome,
  weekIndex0,
  scores
) {
  if (
    !leagueState ||
    !leagueState.schedule ||
    !leagueState.schedule.byTeam
  ) {
    return;
  }
  const teamCode = save.teamCode;
  const games = leagueState.schedule.byTeam[teamCode];
  if (!Array.isArray(games) || !games.length) return;

  const weekIdx = typeof weekIndex0 === "number" ? weekIndex0 : save.weekIndex || 0;
  let game =
    games.find((g) => g.index === weekIdx) ||
    games.find(
      (g) =>
        g.seasonWeek === weekIdx + 1 &&
        g.opponentCode === opponentCode
    );

  if (!game) {
    // fallback – nothing to update
    return;
  }

  const userScore = isFranchiseHome ? scores.home : scores.away;
  const oppScore = isFranchiseHome ? scores.away : scores.home;

  game.status = "final";
  game.teamScore = userScore;
  game.opponentScore = oppScore;
}

// -----------------------------------------------------------------------------
// Rendering for Game Day (minimal but engine-driven)
// -----------------------------------------------------------------------------
function renderPregameHeader(save, opponentCode, isFranchiseHome, weekIndex0) {
  const teamName =
    save.teamName || save.franchiseName || getTeamDisplayNameFromCode(save.teamCode);
  const oppName = getTeamDisplayNameFromCode(opponentCode);
  const year = save.seasonYear || "";
  const weekLabel = typeof weekIndex0 === "number" ? weekIndex0 + 1 : (save.weekIndex || 0) + 1;

  setText("team-name-heading", teamName);
  setText("season-phase-line", `${year} • Week ${weekLabel} • Game Day`);

  const matchupLabel = isFranchiseHome
    ? `${teamName} vs ${oppName}`
    : `${teamName} at ${oppName}`;

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
    summaryEl.textContent = "Ready to simulate your Game Day matchup.";
  }
}

function renderPostgameResult(
  result,
  homeTeam,
  awayTeam,
  homeCode,
  awayCode,
  save,
  opponentCode,
  isFranchiseHome,
  weekIndex0
) {
  const userCode = save.teamCode;
  const homeId = homeTeam.teamId || homeTeam.id;
  const awayId = awayTeam.teamId || awayTeam.id;

  const { home, away, quarter, clock } = getScoreFromResult(
    result,
    homeId,
    awayId
  );

  const userScore = isFranchiseHome ? home : away;
  const oppScore = isFranchiseHome ? away : home;

  // Scoreboard numbers
  setText("gameday-home-score", String(home));
  setText("gameday-away-score", String(away));

  const teamName =
    save.teamName || save.franchiseName || getTeamDisplayNameFromCode(userCode);
  const oppName = getTeamDisplayNameFromCode(opponentCode);
  const weekLabel = typeof weekIndex0 === "number" ? weekIndex0 + 1 : (save.weekIndex || 0) + 1;

  const isFinal = quarter === "Final" || quarter === 4 || quarter === "4";
  const statusLabel = isFinal ? "Final" : `Q${quarter} ${clock || ""}`.trim();

  const metaEl = getEl("gameday-score-meta");
  if (metaEl) {
    metaEl.textContent = `${statusLabel} • Week ${weekLabel}`;
  }

  const isWin = userScore > oppScore;
  const summaryEl = getEl("gameday-summary-line");
  if (summaryEl) {
    const resWord = isWin ? "win" : "loss";
    const scoreLine = isFranchiseHome
      ? `${teamName} ${userScore} – ${oppName} ${oppScore}`
      : `${oppName} ${oppScore} – ${teamName} ${userScore}`;

    summaryEl.textContent = `${statusLabel}: ${scoreLine} (${resWord}).`;
  }

  // Basic play log: show scoring / key plays only
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
        const div = document.createElement("div");
        div.className = "gameday-log-line";
        const q = p.quarter ?? p.qtr ?? "";
        const clock =
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
        if (clock) prefixParts.push(clock);
        if (p.downAndDistance) prefixParts.push(p.downAndDistance);
        const prefix = prefixParts.join(" • ");

        div.textContent = `${prefix ? prefix + " – " : ""}${
          p.text || p.description || p.desc || "[play]"
        }`;

        if (isScoring) {
          div.style.fontWeight = "600";
        }

        // Keep it from getting insane; truncate if necessary
        if (idx > 199) return;
        logEl.appendChild(div);
      });
    }
  }

  // Update record + schedule in localStorage
  const recordAfter = updateRecordAfterGame(save, userScore > oppScore);
  setText("record-pill-value", recordAfter);

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear
    };
  }

  updateLeagueScheduleAfterGame(
    leagueState,
    save,
    opponentCode,
    isFranchiseHome,
    weekIndex0,
    { home, away }
  );

  saveLastFranchise(save);
  saveLeagueState(leagueState);
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------
async function initGameDay() {
  const save = loadLastFranchise();
  if (!save) {
    // If you have a no-franchise state in HTML, show that instead.
    console.warn("[GameDay] No active franchise found.");
    setText(
      "gameday-summary-line",
      "No active franchise found. Return to main menu."
    );
    return;
  }

  const weekIndex0 = PARAMS.has("week")
    ? safeNumber(PARAMS.get("week"), save.weekIndex || 0)
    : save.weekIndex || 0;
  const opponentCode = PARAMS.get("opp") || save.nextOpponentCode || null;

  if (!opponentCode) {
    console.warn(
      "[GameDay] No opponent specified. Expected ?opp=TEAMCODE from schedule link."
    );
  }

  const homeParam = PARAMS.get("home");
  const isFranchiseHome =
    homeParam === "1" ||
    homeParam === "true" ||
    (homeParam === null && true); // default: home if not specified

  // Header / pre-game setup
  if (opponentCode) {
    renderPregameHeader(save, opponentCode, isFranchiseHome, weekIndex0);
  } else {
    const teamName =
      save.teamName ||
      save.franchiseName ||
      getTeamDisplayNameFromCode(save.teamCode);
    setText("team-name-heading", teamName);
    setText(
      "season-phase-line",
      `${save.seasonYear || ""} • Week ${weekIndex0 + 1} • Game Day`
    );
    setText(
      "gameday-summary-line",
      "Opponent missing. Launch Game Day from the schedule so ?opp=TEAMCODE is provided."
    );
  }

  // Wire buttons
  const simBtn = getEl("btn-gameday-sim");
  const backBtn = getEl("btn-gameday-back");

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }

  if (!simBtn || !opponentCode) {
    return;
  }

  simBtn.disabled = true;
  simBtn.textContent = "Loading engine…";

  try {
    await ensureLeagueLoaded();
    simBtn.disabled = false;
    simBtn.textContent = "Simulate Game";
  } catch (err) {
    console.error("[GameDay] Engine/league load error:", err);
    simBtn.disabled = true;
    simBtn.textContent = "Engine unavailable";
    setText(
      "gameday-summary-line",
      "Failed to load game engine. Check network / console."
    );
    return;
  }

  simBtn.addEventListener("click", async () => {
    simBtn.disabled = true;
    simBtn.textContent = "Simulating…";

    try {
      const { result, homeTeam, awayTeam, homeCode, awayCode } =
        await runFranchiseEngineGame(
          save,
          opponentCode,
          isFranchiseHome,
          weekIndex0,
          /* seedOverride: */ undefined
        );

      renderPostgameResult(
        result,
        homeTeam,
        awayTeam,
        homeCode,
        awayCode,
        save,
        opponentCode,
        isFranchiseHome,
        weekIndex0
      );

      simBtn.textContent = "Re-simulate";
      simBtn.disabled = false; // you can lock it if you want one-and-done
    } catch (err) {
      console.error("[GameDay] Simulation failed:", err);
      setText(
        "gameday-summary-line",
        `Simulation failed: ${err?.message || err}`
      );
      simBtn.textContent = "Simulation failed";
      simBtn.disabled = false;
    }
  });
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGameDay);
} else {
  initGameDay();
}
