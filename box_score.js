// box_score.js
// -----------------------------------------------------------------------------
// Franchise GM – Box Score
//
// Reads game identity from the query string (?season=&week=&home=&away=),
// loads the current LeagueState from localStorage, and renders a scoreboard
// for that specific matchup.
//
// IMPORTANT CHANGE: instead of using schedule.byWeek (which doesn't get its
// scores updated), this version derives the matchup and final score from
// schedule.byTeam, which GameDay *does* update via teamScore/opponentScore.
// -----------------------------------------------------------------------------

import { getTeamDisplayName } from "./league_schedule.js";

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__box";
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
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadLeagueState(franchiseId) {
  if (!storageAvailable() || !franchiseId) return null;
  const raw = window.localStorage.getItem(getLeagueStateKey(franchiseId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function getEl(id) {
  return document.getElementById(id);
}

function formatIsoToNice(iso) {
  if (!iso) return "Date TBA";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date TBA";
  const options = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York"
  };
  return date.toLocaleString("en-US", options);
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Compute record through a given week using schedule.byTeam[*].teamScore/opponentScore
function computeRecordThroughWeek(leagueState, teamCode, weekNumber) {
  const schedule = leagueState?.schedule?.byTeam?.[teamCode] || [];
  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (const g of schedule) {
    if (!g) continue;
    if (typeof g.seasonWeek !== "number") continue;
    if (g.seasonWeek > weekNumber) continue;
    if (g.type === "bye" || g.isBye) continue;
    if (g.status !== "final") continue;

    const us = Number(g.teamScore);
    const them = Number(g.opponentScore);
    if (!Number.isFinite(us) || !Number.isFinite(them)) continue;

    if (us > them) wins++;
    else if (them > us) losses++;
    else ties++;
  }

  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

// ---------------------------------------------------------------------------
// Matchup lookup based on schedule.byTeam
// ---------------------------------------------------------------------------

/**
 * Build a scoreboard-style game object from a team-centric schedule entry.
 * @param {Object} g - TeamGame from schedule.byTeam[*]
 * @param {string} homeCode - uppercase home team code
 * @param {string} awayCode - uppercase away team code
 */
function buildGameFromTeamGame(g, homeCode, awayCode, leagueWeek) {
  const seasonWeek = typeof g.seasonWeek === "number" ? g.seasonWeek : leagueWeek;
  const status = g.status || "scheduled";

  // g.teamCode is "this" team; g.opponentCode is the other team.
  const teamCodeUpper = String(g.teamCode || "").toUpperCase();
  const oppCodeUpper = String(g.opponentCode || "").toUpperCase();

  const teamScore = safeNumber(g.teamScore);
  const oppScore = safeNumber(g.opponentScore);

  // We want scores in true home/away orientation, regardless of how the game
  // is stored in this particular team's schedule.
  let homeScore = null;
  let awayScore = null;

  if (teamCodeUpper === homeCode && oppCodeUpper === awayCode) {
    // This schedule row is from the home team perspective.
    homeScore = teamScore;
    awayScore = oppScore;
  } else if (teamCodeUpper === awayCode && oppCodeUpper === homeCode) {
    // This schedule row is from the away team perspective.
    homeScore = oppScore;
    awayScore = teamScore;
  } else {
    // Fallback: if it doesn't line up perfectly, leave as nulls.
    homeScore = null;
    awayScore = null;
  }

  return {
    week: seasonWeek,
    homeTeam: homeCode,
    awayTeam: awayCode,
    homeScore,
    awayScore,
    kickoffIso: g.kickoffIso || null,
    type: g.type || "regular",
    status,
    venue: g.venue || null
  };
}

/**
 * Find the matchup for (seasonWeek, homeCode, awayCode) using schedule.byTeam.
 * Falls back to the franchise team's schedule if needed.
 */
function findMatchupFromByTeam(leagueState, leagueWeek, homeCode, awayCode, franchiseCode) {
  const byTeam = leagueState?.schedule?.byTeam || {};
  const upperHome = (homeCode || "").toUpperCase();
  const upperAway = (awayCode || "").toUpperCase();
  const upperFranchise = (franchiseCode || "").toUpperCase();

  const weekIndex0 = leagueWeek > 0 ? leagueWeek - 1 : 0;

  const matchForTeam = (teamKey, oppKey) => {
    const games = byTeam[teamKey] || [];
    return (
      games.find((g) => {
        const idx =
          typeof g.index === "number"
            ? g.index
            : typeof g.seasonWeek === "number"
            ? g.seasonWeek - 1
            : null;
        if (idx !== weekIndex0) return false;
        return String(g.opponentCode || "").toUpperCase() === oppKey;
      }) || null
    );
  };

  // 1) Try from the home team's schedule (ideal)
  if (upperHome && upperAway && byTeam[upperHome]) {
    const g = matchForTeam(upperHome, upperAway);
    if (g) return buildGameFromTeamGame(g, upperHome, upperAway, leagueWeek);
  }

  // 2) Try from the away team's schedule
  if (upperHome && upperAway && byTeam[upperAway]) {
    const g = matchForTeam(upperAway, upperHome);
    if (g) return buildGameFromTeamGame(g, upperHome, upperAway, leagueWeek);
  }

  // 3) Fallback: franchise team schedule, infer home/away from isHome flag
  if (upperFranchise && byTeam[upperFranchise]) {
    const games = byTeam[upperFranchise];
    const g =
      games.find((gg) => {
        const idx =
          typeof gg.index === "number"
            ? gg.index
            : typeof gg.seasonWeek === "number"
            ? gg.seasonWeek - 1
            : null;
        return idx === weekIndex0;
      }) || null;

    if (g) {
      const opp = String(g.opponentCode || "").toUpperCase();
      const isHome = !!g.isHome;
      const inferredHome = isHome ? upperFranchise : opp;
      const inferredAway = isHome ? opp : upperFranchise;
      return buildGameFromTeamGame(g, inferredHome, inferredAway, leagueWeek);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", initBoxScorePage);

async function initBoxScorePage() {
  const save = loadLastFranchise();
  const noFranchiseSection = getEl("box-no-franchise");
  const mainRoot = getEl("box-main");
  const headerRoot = getEl("box-header");

  if (!save) {
    if (mainRoot) mainRoot.hidden = true;
    if (headerRoot) headerRoot.hidden = true;
    if (noFranchiseSection) noFranchiseSection.hidden = false;

    const btn = getEl("box-btn-main-menu");
    if (btn) {
      btn.addEventListener("click", () => {
        window.location.href = "index.html";
      });
    }
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const seasonParam = Number(params.get("season") || save.seasonYear || 0);

  const rawWeek = Number(params.get("week") || 0);
  const weekParam =
    Number.isFinite(rawWeek) && rawWeek > 0 ? rawWeek : 1; // league week label (1–18)

  const homeCodeParam = (params.get("home") || "").toUpperCase();
  const awayCodeParam = (params.get("away") || "").toUpperCase();

  const ctx = {
    seasonYear: seasonParam,
    week: weekParam,
    homeCode: homeCodeParam,
    awayCode: awayCodeParam
  };

  const leagueState = loadLeagueState(save.franchiseId);

  if (!leagueState || !leagueState.schedule || !leagueState.schedule.byTeam) {
    // No schedule available – render "unavailable" state
    renderPage(save, leagueState, null, ctx);
    return;
  }

  // Find the actual matchup (and its final scores) from schedule.byTeam
  const game = findMatchupFromByTeam(
    leagueState,
    weekParam,
    homeCodeParam,
    awayCodeParam,
    save.teamCode
  );

  renderPage(save, leagueState, game, ctx);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPage(save, leagueState, game, ctx) {
  const headerTitle = getEl("box-header-title");
  const headerSubline = getEl("box-header-subline");
  const headerLine = getEl("score-header-line");
  const metaLeft = getEl("score-meta-left");
  const tagType = getEl("score-tag-type");

  const awayNameEl = getEl("away-team-name");
  const awayScoreEl = getEl("away-team-score");
  const awayRecordEl = getEl("away-team-record");

  const homeNameEl = getEl("home-team-name");
  const homeScoreEl = getEl("home-team-score");
  const homeRecordEl = getEl("home-team-record");

  const awayCard = getEl("score-team-away");
  const homeCard = getEl("score-team-home");

  const summaryResult = getEl("summary-result");
  const summaryScoreline = getEl("summary-scoreline");
  const summaryLocation = getEl("summary-location");
  const summaryNote = getEl("summary-note");

  // If we couldn't find the matchup from schedule.byTeam, show a simple error
  if (!game) {
    const homeName =
      ctx.homeCode && getTeamDisplayName(ctx.homeCode)
        ? getTeamDisplayName(ctx.homeCode)
        : "Home team";
    const awayName =
      ctx.awayCode && getTeamDisplayName(ctx.awayCode)
        ? getTeamDisplayName(ctx.awayCode)
        : "Away team";

    if (headerTitle) headerTitle.textContent = `${awayName} at ${homeName}`;
    if (headerSubline) {
      headerSubline.textContent = `Season ${ctx.seasonYear} • Week ${ctx.week} • Game not found`;
    }
    if (headerLine) headerLine.textContent = "Unable to locate this matchup in the league schedule.";
    if (metaLeft) metaLeft.textContent = "No data";

    if (awayNameEl) awayNameEl.textContent = awayName;
    if (homeNameEl) homeNameEl.textContent = homeName;
    if (awayScoreEl) awayScoreEl.textContent = "—";
    if (homeScoreEl) homeScoreEl.textContent = "—";
    if (awayRecordEl) awayRecordEl.textContent = "Record —";
    if (homeRecordEl) homeRecordEl.textContent = "Record —";

    if (summaryResult) summaryResult.textContent = "—";
    if (summaryScoreline) summaryScoreline.textContent = "—";
    if (summaryLocation) summaryLocation.textContent = "—";
    if (summaryNote) {
      summaryNote.textContent =
        "Once games are simulated and saved into LeagueState.schedule, box scores will appear here.";
    }
    return;
  }

  const homeCode = String(game.homeTeam || ctx.homeCode || "").toUpperCase();
  const awayCode = String(game.awayTeam || ctx.awayCode || "").toUpperCase();

  const homeName = getTeamDisplayName(homeCode);
  const awayName = getTeamDisplayName(awayCode);

  const homeScore = safeNumber(game.homeScore);
  const awayScore = safeNumber(game.awayScore);

  const isFinal =
    game.status === "final" &&
    homeScore != null &&
    awayScore != null;

  const weekLabel =
    typeof game.week === "number" ? game.week : ctx.week;

  // Header
  if (headerTitle) {
    headerTitle.textContent = `${awayName} at ${homeName}`;
  }

  if (headerSubline) {
    const statusLabel = isFinal ? "Final" : "Scheduled";
    headerSubline.textContent = `Season ${ctx.seasonYear} • Week ${weekLabel} • ${statusLabel}`;
  }

  if (headerLine) {
    headerLine.textContent = formatIsoToNice(game.kickoffIso);
  }

  if (metaLeft) {
    const venue = game.venue || (homeName ? `${homeName} home` : "Home stadium");
    metaLeft.textContent = venue;
  }

  if (tagType) {
    const t = game.type || "regular";
    let label = "Regular Season";
    if (t === "division") label = "Division game";
    else if (t === "conference") label = "Conference game";
    else if (t === "nonconference") label = "Interconference game";
    tagType.textContent = label;
  }

  // Records through this week
  let homeRecord = "0-0";
  let awayRecord = "0-0";

  if (leagueState && leagueState.schedule && leagueState.schedule.byTeam) {
    homeRecord = computeRecordThroughWeek(leagueState, homeCode, weekLabel);
    awayRecord = computeRecordThroughWeek(leagueState, awayCode, weekLabel);
  }

  if (awayNameEl) awayNameEl.textContent = awayName;
  if (homeNameEl) homeNameEl.textContent = homeName;

  if (awayScoreEl) awayScoreEl.textContent = awayScore != null ? String(awayScore) : "—";
  if (homeScoreEl) homeScoreEl.textContent = homeScore != null ? String(homeScore) : "—";

  if (awayRecordEl) awayRecordEl.textContent = `Record ${awayRecord}`;
  if (homeRecordEl) homeRecordEl.textContent = `Record ${homeRecord}`;

  // Winner highlight
  if (awayCard) awayCard.classList.remove("score-team--winner");
  if (homeCard) homeCard.classList.remove("score-team--winner");

  if (isFinal) {
    if (homeScore > awayScore && homeCard) homeCard.classList.add("score-team--winner");
    if (awayScore > homeScore && awayCard) awayCard.classList.add("score-team--winner");
  }

  // Summary card
  if (summaryScoreline) {
    if (homeScore != null && awayScore != null) {
      summaryScoreline.textContent = `${awayName} ${awayScore} – ${homeName} ${homeScore}`;
    } else {
      summaryScoreline.textContent = "Score not yet available.";
    }
  }

  if (summaryLocation) {
    const loc = game.venue || `${homeName} home stadium`;
    summaryLocation.textContent = loc;
  }

  if (summaryResult) {
    if (!isFinal) {
      summaryResult.textContent = "Not played yet";
    } else if (homeScore === awayScore) {
      summaryResult.textContent = "Final – tied";
    } else {
      const winnerName = homeScore > awayScore ? homeName : awayName;
      const loserName = homeScore > awayScore ? awayName : homeName;
      summaryResult.textContent = `${winnerName} defeat ${loserName}`;
    }
  }

  if (summaryNote) {
    if (!isFinal) {
      summaryNote.textContent =
        "Game is on the schedule but has not been simulated yet. Once it is played, the final score appears above.";
    } else {
      summaryNote.textContent =
        "Detailed per-player box score can be wired in once gameStats are persisted; for now, this view shows the final result and basic context.";
    }
  }
}
