// box_score.js
// -----------------------------------------------------------------------------
// Franchise GM – Box Score
//
// Reads game identity from the query string (?season=&week=&home=&away=),
// loads the current LeagueState from localStorage, and renders a scoreboard
// for that specific matchup.
// -----------------------------------------------------------------------------

import { getTeamDisplayName, ensureAllTeamSchedules } from "./league_schedule.js";

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------

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

function saveLeagueState(state) {
  if (!storageAvailable() || !state || !state.franchiseId) return;
  try {
    window.localStorage.setItem(
      getLeagueStateKey(state.franchiseId),
      JSON.stringify(state)
    );
  } catch (err) {
    console.warn("[Franchise GM] Failed to save league state:", err);
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

// -----------------------------------------------------------------------------
// Main init
// -----------------------------------------------------------------------------

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
  const weekParam = Number(params.get("week") || 0);
  const homeCode = (params.get("home") || "").toUpperCase();
  const awayCode = (params.get("away") || "").toUpperCase();

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: seasonParam
    };
  } else {
    leagueState.seasonYear = seasonParam;
  }

  // Ensure schedules exist so we have schedule.byWeek populated
  await ensureAllTeamSchedules(leagueState, seasonParam);
  saveLeagueState(leagueState);

  const byWeek = leagueState.schedule?.byWeek || {};
  const weekGames = byWeek[weekParam] || [];

  let game = null;
  if (homeCode && awayCode) {
    game =
      weekGames.find(
        (g) =>
          g &&
          String(g.homeTeam || "").toUpperCase() === homeCode &&
          String(g.awayTeam || "").toUpperCase() === awayCode
      ) || null;
  }

  if (!game && weekGames.length) {
    // Fallback: first game of that week
    game = weekGames[0];
  }

  renderPage(save, leagueState, game, {
    seasonYear: seasonParam,
    week: weekParam,
    homeCode,
    awayCode
  });
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

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

  if (!game) {
    if (headerTitle) headerTitle.textContent = "Box score unavailable";
    if (headerSubline) {
      headerSubline.textContent = `Season ${ctx.seasonYear} • Week ${ctx.week} • Game not found`;
    }
    if (headerLine) headerLine.textContent = "Unable to locate this matchup in the league schedule.";
    if (metaLeft) metaLeft.textContent = "No data";

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

  const homeScore = Number.isFinite(Number(game.homeScore))
    ? Number(game.homeScore)
    : null;
  const awayScore = Number.isFinite(Number(game.awayScore))
    ? Number(game.awayScore)
    : null;

  const isFinal =
    game.status === "final" &&
    homeScore != null &&
    awayScore != null;

  const weekLabel =
    typeof game.week === "number" ? game.week : ctx.week;

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
  const recordWeek = typeof weekLabel === "number" ? weekLabel : ctx.week;
  const homeRecord = computeRecordThroughWeek(leagueState, homeCode, recordWeek);
  const awayRecord = computeRecordThroughWeek(leagueState, awayCode, recordWeek);

  if (awayNameEl) awayNameEl.textContent = awayName;
  if (homeNameEl) homeNameEl.textContent = homeName;

  if (awayScoreEl) awayScoreEl.textContent = awayScore != null ? String(awayScore) : "—";
  if (homeScoreEl) homeScoreEl.textContent = homeScore != null ? String(homeScore) : "—";

  if (awayRecordEl) awayRecordEl.textContent = `Record ${awayRecord}`;
  if (homeRecordEl) homeRecordEl.textContent = `Record ${homeRecord}`;

  // Winner highlight
  if (isFinal) {
    if (homeCard) homeCard.classList.remove("score-team--winner");
    if (awayCard) awayCard.classList.remove("score-team--winner");
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
