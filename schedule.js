// schedule.js
//
// Franchise GM – Season Schedule / Calendar
//
// Responsibilities:
// - Load the current FranchiseSave summary from localStorage.
// - Load or create a LeagueState object for this franchise.
// - Ensure an NFL-style schedule exists (per-team schedule, by season).
// - Render:
//   * Header (team name + season line).
//   * Left side: week-by-week list for the user's team.
//   * Right side: details for the selected week.
//   * Scope toggle: My Team / League (league view is stubbed for now).
//
// Notes:
// - Schedule generation uses an NFL-style 16-game rotation:
//     * 6 division games (home/away vs 3 rivals)
//     * 4 games vs one same-conference division (rotating 3-year cycle)
//     * 4 games vs one opposite-conference division (rotating 4-year cycle)
//     * 2 same-conference “extra” games vs teams from the remaining divisions
//   This mirrors the classic NFL structure; the modern 17th game is a TODO.
// - Weeks are treated as game index (Week 1..16) for now. Real bye logic
//   can be layered on later.
//
// Assumes schedule.html has (key IDs):
//   - Header:
//       #team-name-heading
//       #season-phase-line
//   - Scope toggle:
//       #tab-my-team
//       #tab-league
//   - Week list card:
//       #week-list
//   - Week detail card:
//       #week-detail-title
//       #week-detail-opponent
//       #week-detail-meta
//       #week-detail-result
//       #week-detail-record-line
//       #btn-advance-week
//       #btn-view-box
//   - View mode hint:
//       #schedule-view-mode-label
//   - Back to hub:
//       #btn-back-hub
//
// If something is missing, the code fails gracefully.

// ---------------------------------------------------------------------------
// Shared types (documentation only)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} [teamName]
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {number} weekIndex
 * @property {string} phase
 * @property {string} record
 * @property {string} lastPlayedISO
 *
 * @property {Object} accolades
 * @property {Object} gmJob
 * @property {Object} leagueSummary
 * @property {Object} realismOptions
 * @property {Object} ownerExpectation
 * @property {number} gmCredibility
 */

/**
 * @typedef {Object} TeamGame
 * @property {number} index           // 0-based index in schedule
 * @property {number} seasonWeek      // 1-based user facing week label
 * @property {string} teamCode        // our team
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
 * @property {Object} [alerts]
 * @property {Object} [statsSummary]
 * @property {Array<Object>} [ownerNotes]
 * @property {Object} [debug]
 * @property {LeagueSchedule} [schedule]
 */

// ---------------------------------------------------------------------------
// Storage keys & helpers
// ---------------------------------------------------------------------------

import {
  getTeamDisplayName,
  ensureTeamSchedule,
  ensureAllTeamSchedules
} from "./league_schedule.js";


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


// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

function formatIsoToNice(iso) {
  if (!iso) return "Date TBA";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date TBA";
  const dayPart = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  return `${dayPart} • ${timePart}`;
}

function parseRecord(recordStr) {
  if (!recordStr || typeof recordStr !== "string") {
    return { wins: 0, losses: 0 };
  }
  const m = recordStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return { wins: 0, losses: 0 };
  return { wins: Number(m[1]) || 0, losses: Number(m[2]) || 0 };
}

function getTeamNameFromSave(save) {
  if (save.teamName) return save.teamName;
  if (save.franchiseName) return save.franchiseName;
  return getTeamDisplayName(save.teamCode || "");
}

function formatSeasonSubline(save) {
  const year = save.seasonYear || "";
  const phase = save.phase || "Regular Season";
  return `${year} • ${phase} • Schedule`;
}

// ---------------------------------------------------------------------------
// Page state (for this view)
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;
/** @type {TeamGame[]} */
let currentTeamSchedule = [];
/** @type {"team"|"league"} */
let currentScope = "team";
/** @type {number} */
let selectedWeekIndex = 0;

// ---------------------------------------------------------------------------
// Rendering – header, week list, detail
// ---------------------------------------------------------------------------

function renderHeader(save) {
  const teamNameEl = getEl("team-name-heading");
  const sublineEl = getEl("season-phase-line");

  if (teamNameEl) {
    teamNameEl.textContent = getTeamNameFromSave(save);
  }
  if (sublineEl) {
    sublineEl.textContent = formatSeasonSubline(save);
  }
}

function renderScopeToggle() {
  const myBtn = getEl("tab-my-team");
  const leagueBtn = getEl("tab-league");
  const labelEl = getEl("schedule-view-mode-label");

  if (myBtn) {
    myBtn.setAttribute("aria-pressed", currentScope === "team" ? "true" : "false");
  }
  if (leagueBtn) {
    leagueBtn.setAttribute("aria-pressed", currentScope === "league" ? "true" : "false");
  }
  if (labelEl) {
    labelEl.textContent =
      currentScope === "team" ? "Viewing: Your team schedule" : "Viewing: League (stubbed)";
  }
}

/**
 * Render left-hand week list based on currentScope.
 * For now, league scope is a stub: we keep showing the team schedule but indicate the mode.
 */
function renderWeekList() {
  const listEl = getEl("week-list");
  if (!listEl) return;

  listEl.innerHTML = "";

  if (currentScope === "league") {
    // Stub: reuse team schedule but label as league view.
    const infoRow = document.createElement("div");
    infoRow.className = "week-list-info-row";
    infoRow.textContent = "League-wide schedule view is not implemented yet. Showing your team instead.";
    listEl.appendChild(infoRow);
  }

  currentTeamSchedule.forEach((game) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "week-row";
    row.dataset.weekIndex = String(game.index);

    if (game.index === selectedWeekIndex) {
      row.classList.add("week-row--selected");
    }

    const topLine = document.createElement("div");
    topLine.className = "week-row-top";
    topLine.textContent = `Week ${game.seasonWeek} • ${
      game.isHome ? "vs" : "at"
    } ${getTeamDisplayName(game.opponentCode)}`;

    const bottomLine = document.createElement("div");
    bottomLine.className = "week-row-bottom";

    const timeText = formatIsoToNice(game.kickoffIso);
    const typeText =
      game.type === "division"
        ? "Division"
        : game.type === "conference"
        ? "Conference"
        : game.type === "nonconference"
        ? "Interconference"
        : "Conference (extra)";

    if (game.status === "final" && game.teamScore != null && game.opponentScore != null) {
      const isWin = game.teamScore > game.opponentScore;
      const resLetter = isWin ? "W" : "L";
      bottomLine.textContent = `${timeText} • ${resLetter} ${game.teamScore}–${game.opponentScore} • ${typeText}`;
    } else {
      bottomLine.textContent = `${timeText} • Scheduled • ${typeText}`;
    }

    row.appendChild(topLine);
    row.appendChild(bottomLine);

    row.addEventListener("click", () => {
      selectedWeekIndex = game.index;
      renderWeekList();
      renderWeekDetail();
    });

    listEl.appendChild(row);
  });
}

function renderWeekDetail() {
  const titleEl = getEl("week-detail-title");
  const oppEl = getEl("week-detail-opponent");
  const metaEl = getEl("week-detail-meta");
  const resultEl = getEl("week-detail-result");
  const recordLineEl = getEl("week-detail-record-line");
  const gameDayBtn = getEl("btn-advance-week");
  const boxBtn = getEl("btn-view-box");

  const game = currentTeamSchedule.find((g) => g.index === selectedWeekIndex);
  if (!game) {
    if (titleEl) titleEl.textContent = "No week selected";
    if (oppEl) oppEl.textContent = "";
    if (metaEl) metaEl.textContent = "";
    if (resultEl) resultEl.textContent = "";
    if (recordLineEl) recordLineEl.textContent = "";
    if (gameDayBtn) gameDayBtn.disabled = true;
    if (boxBtn) boxBtn.disabled = true;
    return;
  }

  const oppName = getTeamDisplayName(game.opponentCode);
  if (titleEl) {
    titleEl.textContent = `Week ${game.seasonWeek}`;
  }
  if (oppEl) {
    oppEl.textContent = game.isHome ? `Home vs ${oppName}` : `Road at ${oppName}`;
  }

  const kickoffText = formatIsoToNice(game.kickoffIso);
  const typeText =
    game.type === "division"
      ? "Division matchup"
      : game.type === "conference"
      ? "Conference game"
      : game.type === "nonconference"
      ? "Interconference game"
      : "Conference matchup";
  if (metaEl) {
    metaEl.textContent = `${kickoffText} • ${typeText}`;
  }

  // Result line
  if (resultEl) {
    if (game.status === "final" && game.teamScore != null && game.opponentScore != null) {
      const isWin = game.teamScore > game.opponentScore;
      const resLetter = isWin ? "W" : "L";
      resultEl.textContent = `${resLetter} ${game.teamScore}–${game.opponentScore}`;
    } else {
      resultEl.textContent = "Game not yet played.";
    }
  }

  // Record line – uses current franchise record from save.
  if (recordLineEl && currentFranchiseSave) {
    const { wins, losses } = parseRecord(currentFranchiseSave.record || "0-0");
    recordLineEl.textContent = `Current record: ${wins}-${losses}`;
  }

  if (gameDayBtn) {
    gameDayBtn.disabled = false;
    gameDayBtn.onclick = function () {
      const weekParam = game.index; // 0-based
      const oppParam = game.opponentCode; // e.g. "BUF"
      const homeFlag = game.isHome ? "1" : "0";
  
      window.location.href =
        `gameday.html?week=${weekParam}&opp=${encodeURIComponent(
          oppParam
        )}&home=${homeFlag}`;
    };
  }
  

  if (boxBtn) {
    const isFinal = game.status === "final";
    boxBtn.disabled = !isFinal;
    boxBtn.onclick = function () {
      if (!isFinal) {
        window.alert("Box score will be available after this game is played.");
        return;
      }
      // Future: navigate to a dedicated game results / box score page,
      // e.g. `game_result.html?season=YEAR&week=X&team=...`
      window.alert("Box score view not implemented yet.");
    };
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindScopeToggle() {
  const myBtn = getEl("tab-my-team");
  const leagueBtn = getEl("tab-league");

  if (myBtn) {
    myBtn.addEventListener("click", () => {
      if (currentScope === "team") return;
      currentScope = "team";
      renderScopeToggle();
      renderWeekList();
      renderWeekDetail();
    });
  }

  if (leagueBtn) {
    leagueBtn.addEventListener("click", () => {
      if (currentScope === "league") return;
      currentScope = "league";
      renderScopeToggle();
      renderWeekList();
      renderWeekDetail();
    });
  }
}

function bindBackButton() {
  const backBtn = getEl("btn-back-hub");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }
}

// ---------------------------------------------------------------------------
// No-franchise fallback
// ---------------------------------------------------------------------------

function renderNoFranchiseScheduleState() {
  // If schedule.html already has a no-franchise section we could toggle it.
  // For now, we hard-replace the body with a simple message.
  document.body.innerHTML = `
    <div class="no-franchise-state">
      <div class="no-franchise-title">No active franchise found</div>
      <div class="no-franchise-text">
        There’s no active franchise in this slot. Return to the main menu to start a new franchise or continue an existing one.
      </div>
      <div class="no-franchise-actions">
        <button type="button" class="btn-primary" id="btn-go-main-menu">Back to main menu</button>
      </div>
    </div>
  `;

  const mainBtn = document.getElementById("btn-go-main-menu");
  if (mainBtn) {
    mainBtn.addEventListener("click", () => {
      window.location.href = "index.html";
    });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initSchedulePage() {
  const save = loadLastFranchise();
  if (!save) {
    renderNoFranchiseScheduleState();
    return;
  }

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear
    };
  } else {
    // keep leagueState season year in sync with the save
    leagueState.seasonYear = save.seasonYear;
  }

  // Make sure the league has schedules for all teams this season,
  // then grab this franchise's schedule.
  ensureAllTeamSchedules(leagueState, save.seasonYear);
  const teamSchedule = ensureTeamSchedule(
    leagueState,
    save.teamCode,
    save.seasonYear
  );

  // Persist any newly generated schedules
  saveLeagueState(leagueState);

  currentFranchiseSave = save;
  currentLeagueState = leagueState;
  currentTeamSchedule = teamSchedule.slice(); // shallow copy

  // Select current week if within range; otherwise week 1.
  const rawWeekIndex = typeof save.weekIndex === "number" ? save.weekIndex : 0;
  if (rawWeekIndex >= 0 && rawWeekIndex < currentTeamSchedule.length) {
    selectedWeekIndex = rawWeekIndex;
  } else {
    selectedWeekIndex = 0;
  }

  renderHeader(save);
  renderScopeToggle();
  renderWeekList();
  renderWeekDetail();
  bindScopeToggle();
  bindBackButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSchedulePage);
} else {
  initSchedulePage();
}
