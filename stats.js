// stats.js
// -----------------------------------------------------------------------------
// Franchise GM – League Stats & Leaders
//
// Displays player and team leaderboards based on leagueState.seasonStats.
// Supports week/range filtering, expandable leader cards, and an offense/defense
// team stats tab.
// -----------------------------------------------------------------------------

import {
  TEAM_META,
  getTeamDisplayName,
  recomputeRecordFromSchedule,
} from "./league_schedule.js";
import { rebuildSeasonStats } from "./league_stats.js";

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

function storageAvailable() {
  try {
    const testKey = "__storage_test__";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function loadLastFranchise() {
  if (!storageAvailable()) return null;
  const raw = localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadLeagueState(franchiseId) {
  if (!storageAvailable()) return null;
  const raw = localStorage.getItem(getLeagueStateKey(franchiseId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveLeagueState(franchiseId, state) {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(getLeagueStateKey(franchiseId), JSON.stringify(state));
  } catch (err) {
    console.warn("Failed to save LeagueState:", err);
  }
}

document.addEventListener("DOMContentLoaded", initStatsPage);

async function initStatsPage() {
  const save = loadLastFranchise();
  const root = document.getElementById("stats-page-root");
  const noFranchise = document.getElementById("stats-no-franchise");

  if (!save) {
    if (noFranchise) noFranchise.hidden = false;
    if (root && root.querySelector("main")) {
      root.querySelector("main").hidden = true;
    }
    const startBtn = document.getElementById("btn-no-franchise-start");
    const landingBtn = document.getElementById("btn-no-franchise-landing");
    if (startBtn) {
      startBtn.onclick = () => {
        window.location.href = "team_select.html";
      };
    }
    if (landingBtn) {
      landingBtn.onclick = () => {
        window.location.href = "index.html";
      };
    }
    return;
  }

  // Load state
  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear,
      gameStats: {},
      seasonStats: {
        updatedThroughWeekIndex0: null,
        teams: {},
        players: {},
      },
    };
  }

  // Ensure we have season stats built at least once and persisted
  rebuildSeasonStats(leagueState, { throughWeekIndex0: null });
  saveLeagueState(save.franchiseId, leagueState);

  populateHeader(save, leagueState);
  setupNavigation(save);
  setupScopeControls(save, leagueState); // triggers initial render
  setupTabs();
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

function populateHeader(save, leagueState) {
  const teamName = getTeamDisplayName(save.teamCode);
  const recordFromSchedule = recomputeRecordFromSchedule(
    leagueState,
    save.teamCode
  );
  const record = recordFromSchedule || save.record || "0–0";

  const nameEl = document.getElementById("stats-header-name");
  const sublineEl = document.getElementById("stats-header-subline");
  const recordEl = document.getElementById("stats-record-value");

  if (nameEl) nameEl.textContent = teamName;
  if (sublineEl) {
    sublineEl.textContent = `Season ${save.seasonYear} • League Stats & Leaders`;
  }
  if (recordEl) recordEl.textContent = record;
}

// -----------------------------------------------------------------------------
// Navigation & tabs
// -----------------------------------------------------------------------------

function setupNavigation(save) {
  const btnBack = document.getElementById("btn-stats-back");
  if (btnBack) {
    btnBack.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }

  const btnBackSchedule = document.getElementById("btn-stats-back-schedule");
  if (btnBackSchedule) {
    btnBackSchedule.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.href = "schedule.html";
    });
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll(".stats-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetPanelId = tab.dataset.panelId;
      if (!targetPanelId) return;

      tabs.forEach((t) => {
        t.dataset.active = "false";
        t.setAttribute("aria-selected", "false");
        const panelId = t.dataset.panelId;
        if (panelId) {
          const panel = document.getElementById(panelId);
          if (panel) panel.hidden = true;
        }
      });

      tab.dataset.active = "true";
      tab.setAttribute("aria-selected", "true");
      const activePanel = document.getElementById(targetPanelId);
      if (activePanel) activePanel.hidden = false;
    });
  });
}

// -----------------------------------------------------------------------------
// Scope / filter controls
// -----------------------------------------------------------------------------

function setupScopeControls(save, leagueState) {
  const modeSelect = document.getElementById("scope-mode-select");
  const weekSelect = document.getElementById("scope-week-select");
  const fromSelect = document.getElementById("scope-range-from-select");
  const toSelect = document.getElementById("scope-range-to-select");
  const summary = document.getElementById("scope-summary-text");

  if (!modeSelect || !weekSelect || !fromSelect || !toSelect || !summary) {
    console.warn("[stats] Missing scope controls in DOM.");
    return;
  }

  const weekCount =
    (leagueState.schedule &&
      leagueState.schedule.byTeam &&
      leagueState.schedule.byTeam[save.teamCode]?.length) ||
    18;

  // Populate week selects
  [weekSelect, fromSelect, toSelect].forEach((sel) => {
    sel.innerHTML = "";
    for (let i = 0; i < weekCount; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Week ${i + 1}`;
      sel.appendChild(opt);
    }
  });

  const state = {
    throughWeekIndex0: null,
    rangeFrom: null,
    rangeTo: null,
  };

  function applyFilter() {
    const mode = modeSelect.value;

    if (mode === "season") {
      state.throughWeekIndex0 = null;
      state.rangeFrom = null;
      state.rangeTo = null;
      summary.textContent = "Season to date.";
      rebuildSeasonStats(leagueState, { throughWeekIndex0: null });
    } else if (mode === "week") {
      const w = parseInt(weekSelect.value, 10) || 0;
      state.throughWeekIndex0 = w;
      state.rangeFrom = w;
      state.rangeTo = w;
      summary.textContent = `Week ${w + 1} only.`;
      rebuildSeasonStats(leagueState, { throughWeekIndex0: w });
    } else if (mode === "range") {
      const from = parseInt(fromSelect.value, 10) || 0;
      const to = parseInt(toSelect.value, 10) || 0;
      state.rangeFrom = Math.min(from, to);
      state.rangeTo = Math.max(from, to);
      state.throughWeekIndex0 = state.rangeTo;
      summary.textContent = `Weeks ${state.rangeFrom + 1}–${
        state.rangeTo + 1
      }.`;
      rebuildSeasonStats(leagueState, { throughWeekIndex0: state.rangeTo });
    }

    renderAllLeaders(leagueState, save, state);
    renderTeamRankings(leagueState, save);
  }

  modeSelect.addEventListener("change", () => {
    const mode = modeSelect.value;
    const weekWrapper = document.getElementById("scope-week-wrapper");
    const fromWrapper = document.getElementById("scope-range-from-wrapper");
    const toWrapper = document.getElementById("scope-range-to-wrapper");

    if (weekWrapper) weekWrapper.hidden = mode !== "week";
    if (fromWrapper) fromWrapper.hidden = mode !== "range";
    if (toWrapper) toWrapper.hidden = mode !== "range";

    applyFilter();
  });

  weekSelect.addEventListener("change", applyFilter);
  fromSelect.addEventListener("change", applyFilter);
  toSelect.addEventListener("change", applyFilter);

  // Initial render using default mode ("season")
  applyFilter();
}

// -----------------------------------------------------------------------------
// Player leaders
// -----------------------------------------------------------------------------

function renderAllLeaders(leagueState, save /* scope not currently used */) {
  const stats = (leagueState.seasonStats && leagueState.seasonStats.players) || {};
  const players = Object.values(stats);

  renderCategory(players, save, "passing", "passYds", "passTD", "passInt");
  renderCategory(players, save, "rushing", "rushYds", "rushTD");
  renderCategory(players, save, "receiving", "recYds", "recTD");
  renderCategory(players, save, "kicking", "fgMade", "fgAtt", "xpMade", "xpAtt");
}

/**
 * Build placeholder "leader" rows if there are no real stats yet.
 * Uses TEAM_META (from league_schedule.js) which exposes `code`, `city`, etc.
 */
function buildFallbackPlayersForCategory(category) {
  const roleLabel =
    category === "passing"
      ? "QB"
      : category === "rushing"
      ? "RB"
      : category === "receiving"
      ? "WR"
      : category === "kicking"
      ? "K"
      : "Player";

  return TEAM_META.map((meta) => ({
    id: `fallback_${category}_${meta.code}`,
    name: `${meta.city} ${roleLabel}`,
    teamCode: meta.code,

    passAtt: 0,
    passYds: 0,
    passTD: 0,
    passInt: 0,

    rushAtt: 0,
    rushYds: 0,
    rushTD: 0,

    receptions: 0,
    targets: 0,
    recYds: 0,
    recTD: 0,

    fgMade: 0,
    fgAtt: 0,
    xpMade: 0,
    xpAtt: 0,
  }));
}

function renderCategory(players, save, category, ...fields) {
  const listEl = document.getElementById(`leader-list-${category}`);
  if (!listEl) return;

  listEl.innerHTML = "";

  let filtered = [];
  if (category === "passing") {
    filtered = players.filter((p) => (p.passAtt || 0) > 0);
  } else if (category === "rushing") {
    filtered = players.filter((p) => (p.rushAtt || 0) > 0);
  } else if (category === "receiving") {
    filtered = players.filter(
      (p) => (p.receptions || 0) > 0 || (p.targets || 0) > 0
    );
  } else if (category === "kicking") {
    filtered = players.filter(
      (p) => (p.fgAtt || 0) > 0 || (p.xpAtt || 0) > 0
    );
  }

  // If there are no real stats yet, fall back to placeholder rows (0 across the board).
  if (!filtered.length) {
    filtered = buildFallbackPlayersForCategory(category);
  }

  const showTop = 5;
  const topPlayers = filtered.slice(0, showTop);
  const mainField = fields[0];

  topPlayers.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "leader-row";
    if (p.teamCode === save.teamCode) {
      li.classList.add("leader-row--user-team");
    }

    const rank = document.createElement("div");
    rank.className = "leader-rank";
    rank.textContent = i + 1;

    const playerDiv = document.createElement("div");
    playerDiv.className = "leader-player";

    const name = document.createElement("span");
    name.className = "leader-name";
    name.textContent = p.name || "Unknown";

    const team = document.createElement("span");
    team.className = "leader-team";
    team.textContent = p.teamCode || "";

    playerDiv.append(name, team);

    const stat = document.createElement("div");
    stat.className = "leader-stat";
    const value = Number(p[mainField] || 0);
    stat.textContent = value.toLocaleString();

    li.append(rank, playerDiv, stat);
    listEl.appendChild(li);
  });

  // Expand button wiring
  const expandBtn = document.getElementById(`btn-expand-${category}`);
  if (expandBtn) {
    expandBtn.onclick = () => {
      const expanded = expandBtn.dataset.expanded === "true";
      expandBtn.dataset.expanded = expanded ? "false" : "true";
      expandBtn.textContent = expanded ? "Show top 25" : "Show top 5";

      listEl.innerHTML = "";
      const arr = expanded ? filtered.slice(0, 25) : filtered.slice(0, 5);
      const mainFieldInner = fields[0];

      arr.forEach((p, i) => {
        const li = document.createElement("li");
        li.className = "leader-row";
        if (p.teamCode === save.teamCode) {
          li.classList.add("leader-row--user-team");
        }

        const rank = document.createElement("div");
        rank.className = "leader-rank";
        rank.textContent = i + 1;

        const playerDiv = document.createElement("div");
        playerDiv.className = "leader-player";

        const name = document.createElement("span");
        name.className = "leader-name";
        name.textContent = p.name || "Unknown";

        const team = document.createElement("span");
        team.className = "leader-team";
        team.textContent = p.teamCode || "";

        playerDiv.append(name, team);

        const stat = document.createElement("div");
        stat.className = "leader-stat";
        const value = Number(p[mainFieldInner] || 0);
        stat.textContent = value.toLocaleString();

        li.append(rank, playerDiv, stat);
        listEl.appendChild(li);
      });
    };
  }
}

// -----------------------------------------------------------------------------
// Team Stats Tab
// -----------------------------------------------------------------------------

function renderTeamRankings(leagueState, save) {
  const tableBody = document.getElementById("team-rankings-tbody");
  if (!tableBody) return;

  // Base team stats from leagueState if present
  let teams = Object.values(
    (leagueState.seasonStats && leagueState.seasonStats.teams) || {}
  );

  // If there are no team stats yet, create a zeroed-out baseline using TEAM_META
  if (!teams.length) {
    teams = TEAM_META.map((meta) => ({
      teamCode: meta.code,
      gamesPlayed: 0,
      pointsFor: 0,
      yardsTotalFor: 0,
      passYdsFor: 0,
      rushYdsFor: 0,
      pointsAgainst: 0,
      yardsTotalAgainst: 0,
      passYdsAgainst: 0,
      rushYdsAgainst: 0,
    }));
  }

  const offensePill = document.getElementById("pill-team-offense");
  const defensePill = document.getElementById("pill-team-defense");

  if (!offensePill || !defensePill) {
    console.warn("[stats] Missing offense/defense pills in DOM.");
    return;
  }

  function update(view) {
    tableBody.innerHTML = "";

    let sorted = [];
    if (view === "offense") {
      sorted = teams
        .map((t) => ({
          ...t,
          ppg: (t.pointsFor || 0) / Math.max(1, t.gamesPlayed || 1),
          ypg: (t.yardsTotalFor || 0) / Math.max(1, t.gamesPlayed || 1),
        }))
        .sort((a, b) => b.ppg - a.ppg);
    } else {
      sorted = teams
        .map((t) => ({
          ...t,
          ppg: (t.pointsAgainst || 0) / Math.max(1, t.gamesPlayed || 1),
          ypg: (t.yardsTotalAgainst || 0) / Math.max(1, t.gamesPlayed || 1),
        }))
        .sort((a, b) => a.ppg - b.ppg);
    }

    for (const t of sorted) {
      const tr = document.createElement("tr");
      if (t.teamCode === save.teamCode) {
        tr.classList.add("team-row--user-team");
      }

      const nameCell = document.createElement("td");
      nameCell.textContent = getTeamDisplayName(t.teamCode);

      const gp = document.createElement("td");
      gp.textContent = String(t.gamesPlayed || 0);

      const pfpg = document.createElement("td");
      pfpg.textContent = (t.ppg || 0).toFixed(1);

      const ypg = document.createElement("td");
      ypg.textContent = (t.ypg || 0).toFixed(1);

      const pass = document.createElement("td");
      const rush = document.createElement("td");
      const games = Math.max(1, t.gamesPlayed || 1);

      if (view === "offense") {
        pass.textContent = ((t.passYdsFor || 0) / games).toFixed(1);
        rush.textContent = ((t.rushYdsFor || 0) / games).toFixed(1);
      } else {
        pass.textContent = ((t.passYdsAgainst || 0) / games).toFixed(1);
        rush.textContent = ((t.rushYdsAgainst || 0) / games).toFixed(1);
      }

      tr.append(nameCell, gp, pfpg, ypg, pass, rush);
      tableBody.appendChild(tr);
    }
  }

  offensePill.addEventListener("click", () => {
    offensePill.dataset.active = "true";
    offensePill.setAttribute("aria-selected", "true");
    defensePill.dataset.active = "false";
    defensePill.setAttribute("aria-selected", "false");
    update("offense");
  });

  defensePill.addEventListener("click", () => {
    offensePill.dataset.active = "false";
    offensePill.setAttribute("aria-selected", "false");
    defensePill.dataset.active = "true";
    defensePill.setAttribute("aria-selected", "true");
    update("defense");
  });

  // Initial view: offense
  update("offense");
}
