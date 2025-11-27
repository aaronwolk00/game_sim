// schedule_grid.js
// -----------------------------------------------------------------------------
// Builds an 18-week × 32-team schedule grid table for the *same* leagueState
// your franchise uses (shared via localStorage).
// -----------------------------------------------------------------------------

import {
  ensureAllTeamSchedules,
  getAllTeamCodes,
  getTeamDisplayName
} from "./league_schedule.js";

// ---- Storage helpers (mirrors schedule.js) ----------------------------------

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
    console.warn("[Franchise GM] Failed to save league state (grid):", err);
  }
}

// ---- Core grid builder ------------------------------------------------------

function buildScheduleGrid() {
  const container = document.getElementById("gridContainer");
  if (!container) {
    console.warn("[schedule_grid] #gridContainer not found in DOM");
    return;
  }

  const save = loadLastFranchise();
  if (!save) {
    container.textContent = "No active franchise found. Start a franchise first.";
    return;
  }

  // Load the same leagueState that schedule.js uses
  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear
    };
  } else {
    leagueState.seasonYear = save.seasonYear;
  }

  // Build or reuse the league schedule (this will be identical to schedule.js)
  const schedule = ensureAllTeamSchedules(leagueState, save.seasonYear);
  // Persist in case we just generated it
  saveLeagueState(leagueState);

  const teamCodes = getAllTeamCodes();

  // Quick helper: given team + week → TeamGame
  function getWeekGame(team, week) {
    const games = schedule.byTeam[team] || [];
    return games.find((g) => g.seasonWeek === week);
  }

  // Clear container, build table
  container.innerHTML = "";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  // First column header
  const teamHeader = document.createElement("th");
  teamHeader.textContent = "TEAM";
  headerRow.appendChild(teamHeader);

  // Week headers 1–18
  for (let w = 1; w <= 18; w++) {
    const th = document.createElement("th");
    th.textContent = w;
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const team of teamCodes) {
    const tr = document.createElement("tr");

    // Team row header – show nice name or code
    const th = document.createElement("th");
    th.textContent = getTeamDisplayName(team); // e.g. "Buffalo Bills"
    tr.appendChild(th);

    for (let w = 1; w <= 18; w++) {
      const td = document.createElement("td");
      const g = getWeekGame(team, w);

      if (!g) {
        td.textContent = "";
      } else if (g.type === "bye" || g.opponentCode === "BYE") {
        td.textContent = "BYE";
        td.classList.add("bye");
      } else if (g.isHome) {
        // Last word of display name, e.g. "Bills", "49ers", "Rams"
        const oppName = getTeamDisplayName(g.opponentCode);
        td.textContent = oppName.split(" ").pop();
        td.classList.add("home");
      } else {
        const oppName = getTeamDisplayName(g.opponentCode);
        td.textContent = "@" + oppName.split(" ").pop();
        td.classList.add("away");
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);
}

// Run after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", buildScheduleGrid);
} else {
  buildScheduleGrid();
}
