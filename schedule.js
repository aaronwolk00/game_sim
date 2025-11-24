// schedule.js
//
// Franchise GM – Season Schedule / Calendar
//
// Responsibilities:
// - Load the current FranchiseSave summary from localStorage.
// - Load or create a LeagueState object for this franchise.
// - Ensure an NFL-style schedule exists (per-team schedule, by season).
// - Render header + season subline.
// - Render left side: week-by-week list for the user's team.
// - Render right side: details for the selected week.
// - Scope toggle: My Team / League (league view is still a stub).
//
// This file assumes schedule.html includes it as a module:
//
//   <script type="module" src="schedule.js"></script>
//
// and that league_schedule.js lives in the same folder and exports:
//
//   getTeamDisplayName(teamCode)
//   ensureTeamSchedule(leagueState, teamCode, seasonYear)
//   ensureAllTeamSchedules(leagueState, seasonYear)

// ---------------------------------------------------------------------------
// Imports (from league_schedule.js)
// ---------------------------------------------------------------------------

import {
  getTeamDisplayName,
  ensureTeamSchedule,
  ensureAllTeamSchedules
} from "./league_schedule.js";

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
 * @property {number} weekIndex       // 0-based
 * @property {string} phase
 * @property {string} record          // "W-L"
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
 * @property {number} index
 * @property {number} seasonWeek
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
 * @property {LeagueSchedule} [schedule]
 * @property {Object} [timeline]
 * @property {Object} [alerts]
 * @property {Object} [statsSummary]
 * @property {Array<Object>} [ownerNotes]
 * @property {Object} [debug]
 */

// ---------------------------------------------------------------------------
// Storage keys & helpers
// ---------------------------------------------------------------------------

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

function buildLeagueWideSchedule(leagueState) {
  if (!leagueState.schedule || !leagueState.schedule.byTeam) return [];
  const allGames = [];
  const seenPairs = new Set();

  for (const [team, games] of Object.entries(leagueState.schedule.byTeam)) {
    for (const g of games) {
      if (g.opponentCode === "BYE") continue;
      const key = [team, g.opponentCode, g.kickoffIso].sort().join("-");
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      allGames.push({
        ...g,
        teamA: team,
        teamB: g.opponentCode,
      });
    }
  }

  allGames.sort((a, b) => new Date(a.kickoffIso) - new Date(b.kickoffIso));
  return allGames;
}

function renderLeagueWeekList() {
  const listEl = getEl("week-list");
  const emptyEl = getEl("week-list-empty");
  if (!listEl || !emptyEl) return;

  listEl.innerHTML = "";
  const schedule = currentLeagueState?.schedule?.byWeek || {};
  if (!Object.keys(schedule).length) {
    emptyEl.hidden = false;
    listEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  listEl.hidden = false;

  for (let week = 1; week <= 18; week++) {
    const games = schedule[week] || [];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "week-row";
    row.textContent = `Week ${week} – ${games.length} games`;
    row.addEventListener("click", () => renderLeagueWeekDetail(week));
    listEl.appendChild(row);
  }
}

function renderLeagueWeekDetail(week) {
  const detailLines = getEl("league-context-lines");
  if (!detailLines) return;
  const games = currentLeagueState?.schedule?.byWeek?.[week] || [];
  detailLines.innerHTML = games
    .map(
      (g) =>
        `${g.awayTeam} @ ${g.homeTeam} • ${formatIsoToNice(g.kickoffIso)}`
    )
    .join("<br>");
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
// Rendering – header, record pill
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

  const recordPillValue = getEl("record-pill-value");
  if (recordPillValue) {
    recordPillValue.textContent = save.record || "0–0";
  }
}

function renderScopeToggle() {
  const myBtn = getEl("tab-my-team");
  const leagueBtn = getEl("tab-league");

  if (myBtn) {
    const isTeam = currentScope === "team";
    myBtn.dataset.active = isTeam ? "true" : "false";
    myBtn.setAttribute("aria-pressed", isTeam ? "true" : "false");
  }

  if (leagueBtn) {
    const isLeague = currentScope === "league";
    leagueBtn.dataset.active = isLeague ? "true" : "false";
    leagueBtn.setAttribute("aria-pressed", isLeague ? "true" : "false");
  }
}


// Treat any synthetic bye objects as bye weeks.
// Compatible with either type === "bye", isBye flag, or missing opponentCode.
function isByeGame(game) {
  if (!game) return true;
  if (game.type === "bye" || game.isBye) return true;
  if (!game.opponentCode) return true;
  return false;
}


// ---------------------------------------------------------------------------
// Rendering – week list
// ---------------------------------------------------------------------------

/**
 * Render left-hand week list based on currentScope.
 * For now, league scope is a stub: we keep showing the team schedule but indicate the mode.
 */
 function renderWeekList() {
  const listEl = getEl("week-list");
  const emptyEl = getEl("week-list-empty");
  if (!listEl || !emptyEl) return;

  listEl.innerHTML = "";

  const schedule = currentTeamSchedule || [];
  if (!schedule.length) {
    emptyEl.hidden = false;
    listEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  listEl.hidden = false;

  // Always render weeks in numeric order, regardless of internal indices.
  const weeks = [...schedule].sort(
    (a, b) => (a.seasonWeek || 0) - (b.seasonWeek || 0)
  );

  weeks.forEach((game) => {
    const bye = isByeGame(game);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "week-row";

    // Fallback: if index is missing, derive from seasonWeek.
    const rowIndex =
      typeof game.index === "number" ? game.index : (game.seasonWeek || 1) - 1;
    row.dataset.weekIndex = String(rowIndex);

    if (rowIndex === selectedWeekIndex) {
      row.dataset.selected = "true";
    }

    // Home / away / bye classes for coloring.
    if (bye) {
      row.classList.add("week-row--bye");
    } else if (game.isHome) {
      row.classList.add("week-row--home");
    } else {
      row.classList.add("week-row--away");
    }

    // Top line: "Week 7" • "@ New England Patriots" or "Bye week"
    const topLine = document.createElement("div");
    topLine.className = "week-row-topline";

    const weekLabel = document.createElement("span");
    weekLabel.textContent = `Week ${game.seasonWeek}`;

    const matchupLabel = document.createElement("span");
    if (bye) {
      matchupLabel.textContent = "Bye week";
    } else {
      const oppName = getTeamDisplayName(game.opponentCode);
      const marker = game.isHome ? "vs" : "@";
      matchupLabel.textContent = `${marker} ${oppName}`;
    }

    topLine.appendChild(weekLabel);
    topLine.appendChild(matchupLabel);

    // Meta line: date/time and (if final) W/L + score
    const metaLine = document.createElement("div");
    metaLine.className = "week-row-meta";

    if (bye) {
      metaLine.textContent = "—";
    } else {
      const timeText = formatIsoToNice(game.kickoffIso);

      let resultText = "";
      if (
        game.status === "final" &&
        game.teamScore != null &&
        game.opponentScore != null
      ) {
        const isWin = game.teamScore > game.opponentScore;
        const resLetter = isWin ? "W" : "L";
        resultText = `${resLetter} ${game.teamScore}–${game.opponentScore}`;
      }

      metaLine.textContent = resultText ? `${timeText} • ${resultText}` : timeText;
    }

    row.appendChild(topLine);
    row.appendChild(metaLine);

    // Keep rows clickable even for bye weeks so the detail pane can show "Bye week".
    row.addEventListener("click", () => {
      selectedWeekIndex = rowIndex;
      renderWeekList();
      renderWeekDetail();
    });

    listEl.appendChild(row);
  });
}


// ---------------------------------------------------------------------------
// Rendering – week detail (right panel)
// ---------------------------------------------------------------------------

function renderWeekDetail() {
  const titleEl = getEl("week-detail-title");
  const sublineEl = getEl("week-detail-subline");
  const matchupHeadlineEl = getEl("matchup-headline");
  const kickoffLineEl = getEl("matchup-kickoff-line");
  const recordLineEl = getEl("matchup-record-line");
  const noteEl = getEl("matchup-note");

  const gameplanBtn = getEl("btn-gameplan");
  const advanceBtn = getEl("btn-advance-week");
  const boxBtn = getEl("btn-view-box-score");

  const game = currentTeamSchedule.find((g) => g.index === selectedWeekIndex);

  if (!game) {
    if (titleEl) titleEl.textContent = "No week selected";
    if (sublineEl) sublineEl.textContent = "—";
    if (matchupHeadlineEl) matchupHeadlineEl.textContent = "No matchup";
    if (kickoffLineEl) kickoffLineEl.textContent = "Kickoff —";
    if (recordLineEl) recordLineEl.textContent = "Team record — • Opponent record —";
    if (noteEl) {
      noteEl.textContent =
        "Select a week on the left to view matchup details, then play or sim that game.";
    }
    if (advanceBtn) advanceBtn.disabled = true;
    if (boxBtn) boxBtn.disabled = true;
    if (gameplanBtn) gameplanBtn.disabled = true;
    return;
  }

  const ourTeamName = getTeamDisplayName(game.teamCode);
  const oppName = getTeamDisplayName(game.opponentCode);

  if (titleEl) {
    titleEl.textContent = `Week ${game.seasonWeek}`;
  }
  if (sublineEl) {
    sublineEl.textContent = game.isHome ? `Home vs ${oppName}` : `Road at ${oppName}`;
  }

  if (matchupHeadlineEl) {
    // Always show "Our Team vs Opponent" in scoreboard order
    const homeName = game.isHome ? ourTeamName : oppName;
    const awayName = game.isHome ? oppName : ourTeamName;
    matchupHeadlineEl.textContent = `${awayName} at ${homeName}`;
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

  if (kickoffLineEl) {
    kickoffLineEl.textContent = `Kickoff — ${kickoffText} • ${typeText}`;
  }

  // Record line – ours vs theirs (for now, opponent record unknown)
  if (recordLineEl && currentFranchiseSave) {
    const { wins, losses } = parseRecord(currentFranchiseSave.record || "0-0");
    recordLineEl.textContent = `Team record ${wins}-${losses} • Opponent record —`;
  }

  // Note / result
  const isFinal = game.status === "final" && game.teamScore != null && game.opponentScore != null;
  if (noteEl) {
    if (isFinal) {
      const isWin = game.teamScore > game.opponentScore;
      const resLetter = isWin ? "W" : "L";
      noteEl.textContent = `${resLetter} ${game.teamScore}–${game.opponentScore}. Box score view will eventually live on a dedicated results screen.`;
    } else {
      noteEl.textContent =
        "When this game is played, score and key notes will appear here.";
    }
  }

  // Buttons
  if (gameplanBtn) {
    gameplanBtn.disabled = false;
    gameplanBtn.onclick = () => {
      window.alert("Gameplan / prep flow is not implemented yet.");
    };
  }

  if (advanceBtn) {
    advanceBtn.disabled = false;
    advanceBtn.onclick = () => {
      const weekParam = game.index; // 0-based
      const oppParam = game.opponentCode;
      const homeFlag = game.isHome ? "1" : "0";

      window.location.href =
        `franchise_gameday.html?week=${weekParam}&opp=${encodeURIComponent(
          oppParam
        )}&home=${homeFlag}`;
    };
  }

  if (boxBtn) {
    boxBtn.disabled = !isFinal;
    boxBtn.onclick = () => {
      if (!isFinal) {
        window.alert("Box score will be available after this game is played.");
        return;
      }
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
      renderLeagueWeekList();
      renderLeagueWeekDetail(1);
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

function bindJumpToCurrentWeek() {
  const btn = getEl("btn-jump-current-week");
  if (!btn) return;

  btn.addEventListener("click", () => {
    if (!currentTeamSchedule.length) return;

    // Use save.weekIndex if it’s valid; otherwise first unplayed game; otherwise week 1.
    let targetIndex = selectedWeekIndex;

    if (
      currentFranchiseSave &&
      typeof currentFranchiseSave.weekIndex === "number" &&
      currentFranchiseSave.weekIndex >= 0 &&
      currentFranchiseSave.weekIndex < currentTeamSchedule.length
    ) {
      targetIndex = currentFranchiseSave.weekIndex;
    } else {
      const firstFuture = currentTeamSchedule.find(
        (g) => g.status !== "final"
      );
      if (firstFuture) targetIndex = firstFuture.index;
      else targetIndex = 0;
    }

    selectedWeekIndex = targetIndex;
    renderWeekList();
    renderWeekDetail();

    // Try to scroll the selected row into view.
    const listEl = getEl("week-list");
    if (listEl) {
      const selectedRow = listEl.querySelector('[data-selected="true"]');
      if (selectedRow && typeof selectedRow.scrollIntoView === "function") {
        selectedRow.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  });
}


// ---------------------------------------------------------------------------
// No-franchise fallback
// ---------------------------------------------------------------------------

function renderNoFranchiseScheduleState() {
  document.body.innerHTML = `
    <div class="no-franchise-state" style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#e5e7eb;font-family:system-ui,-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;">
      <div style="max-width:460px;padding:24px 24px 20px;border-radius:18px;border:1px solid #1f2937;background:radial-gradient(circle at 0% 0%,rgba(15,23,42,.9),rgba(15,23,42,.98));box-shadow:0 22px 45px rgba(0,0,0,.7);">
        <div style="font-size:1rem;font-weight:600;margin-bottom:6px;">No active franchise found</div>
        <div style="font-size:.86rem;color:#9ca3af;margin-bottom:14px;">
          There’s no active franchise in this slot. Return to the main menu to start a new franchise or continue an existing one.
        </div>
        <button type="button" id="btn-go-main-menu" style="border-radius:999px;border:1px solid rgba(148,163,184,.8);background:#0f172a;color:#e5e7eb;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;padding:7px 18px;cursor:pointer;">
          Back to main menu
        </button>
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
  bindJumpToCurrentWeek();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSchedulePage);
} else {
  initSchedulePage();
}
