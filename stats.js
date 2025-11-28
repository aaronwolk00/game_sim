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
  recomputeRecordFromSchedule
} from "./league_schedule.js";
import { rebuildSeasonStats } from "./league_stats.js";

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
    localStorage.setItem(
      getLeagueStateKey(franchiseId),
      JSON.stringify(state)
    );
  } catch (err) {
    console.warn("Failed to save LeagueState:", err);
  }
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", initStatsPage);

async function initStatsPage() {
  const save = loadLastFranchise();
  const root = document.getElementById("stats-page-root");
  const noFranchise = document.getElementById("stats-no-franchise");

  if (!save) {
    if (noFranchise && root) {
      noFranchise.hidden = false;
      const main = root.querySelector("main");
      if (main) main.hidden = true;
      const btnStart = document.getElementById("btn-no-franchise-start");
      const btnLanding = document.getElementById("btn-no-franchise-landing");
      if (btnStart) {
        btnStart.onclick = () => {
          window.location.href = "team_select.html";
        };
      }
      if (btnLanding) {
        btnLanding.onclick = () => {
          window.location.href = "index.html";
        };
      }
    }
    return;
  }

  // Load or bootstrap LeagueState
  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear,
      gameStats: {},
      seasonStats: {
        updatedThroughWeekIndex0: null,
        teams: {},
        players: {}
      }
    };
  }

  // Rebuild season stats for "season to date"
  rebuildSeasonStats(leagueState, { throughWeekIndex0: null });
  saveLeagueState(save.franchiseId, leagueState);

  populateHeader(save, leagueState);
  setupNavigation();
  setupTabs();

  const initialScope = { throughWeekIndex0: null, rangeFrom: null, rangeTo: null };
  setupScopeControls(save, leagueState, initialScope);

  renderAllLeaders(leagueState, save, initialScope);
  renderTeamRankings(leagueState, save, initialScope);
}

// -----------------------------------------------------------------------------
// Header / navigation
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

function setupNavigation() {
  const btnBack = document.getElementById("btn-stats-back");
  if (btnBack) {
    btnBack.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.href = "franchise.html";
    });
  }
}

// -----------------------------------------------------------------------------
// Tabs
// -----------------------------------------------------------------------------

function setupTabs() {
  const tabs = document.querySelectorAll(".stats-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const panelId = tab.getAttribute("data-panel-id");
      if (!panelId) return;

      tabs.forEach((t) => {
        const otherPanelId = t.getAttribute("data-panel-id");
        t.dataset.active = "false";
        t.setAttribute("aria-selected", "false");
        if (otherPanelId) {
          const panel = document.getElementById(otherPanelId);
          if (panel) panel.hidden = true;
        }
      });

      tab.dataset.active = "true";
      tab.setAttribute("aria-selected", "true");
      const panel = document.getElementById(panelId);
      if (panel) panel.hidden = false;
    });
  });
}

// -----------------------------------------------------------------------------
// Scope controls
// -----------------------------------------------------------------------------

function setupScopeControls(save, leagueState, scopeState) {
  const modeSelect = document.getElementById("scope-mode-select");
  const weekSelect = document.getElementById("scope-week-select");
  const fromSelect = document.getElementById("scope-range-from-select");
  const toSelect = document.getElementById("scope-range-to-select");
  const summary = document.getElementById("scope-summary-text");

  const weekWrapper = document.getElementById("scope-week-wrapper");
  const fromWrapper = document.getElementById("scope-range-from-wrapper");
  const toWrapper = document.getElementById("scope-range-to-wrapper");

  // Derive week count from schedule if present, else default 18
  let weekCount = 18;
  if (
    leagueState.schedule &&
    leagueState.schedule.byTeam &&
    leagueState.schedule.byTeam[save.teamCode]
  ) {
    weekCount = leagueState.schedule.byTeam[save.teamCode].length || 18;
  }

  // Populate week selects
  [weekSelect, fromSelect, toSelect].forEach((sel) => {
    if (!sel) return;
    sel.innerHTML = "";
    for (let i = 0; i < weekCount; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Week ${i + 1}`;
      sel.appendChild(opt);
    }
  });

  function applyFilter() {
    if (!modeSelect || !summary) return;
    const mode = modeSelect.value;

    if (mode === "season") {
      scopeState.throughWeekIndex0 = null;
      scopeState.rangeFrom = null;
      scopeState.rangeTo = null;
      summary.textContent = "Season to date.";
      rebuildSeasonStats(leagueState, { throughWeekIndex0: null });
    } else if (mode === "week") {
      const w = weekSelect ? parseInt(weekSelect.value, 10) : 0;
      scopeState.throughWeekIndex0 = w;
      scopeState.rangeFrom = w;
      scopeState.rangeTo = w;
      summary.textContent = `Week ${w + 1} only.`;
      rebuildSeasonStats(leagueState, { throughWeekIndex0: w });
    } else if (mode === "range") {
      const from = fromSelect ? parseInt(fromSelect.value, 10) : 0;
      const to = toSelect ? parseInt(toSelect.value, 10) : 0;
      scopeState.rangeFrom = Math.min(from, to);
      scopeState.rangeTo = Math.max(from, to);
      scopeState.throughWeekIndex0 = scopeState.rangeTo;
      summary.textContent = `Weeks ${scopeState.rangeFrom + 1}–${
        scopeState.rangeTo + 1
      }.`;
      rebuildSeasonStats(leagueState, {
        throughWeekIndex0: scopeState.rangeTo
      });
    }

    renderAllLeaders(leagueState, save, scopeState);
    renderTeamRankings(leagueState, save, scopeState);
  }

  if (modeSelect) {
    modeSelect.addEventListener("change", () => {
      const mode = modeSelect.value;
      if (weekWrapper) weekWrapper.hidden = mode !== "week";
      if (fromWrapper) fromWrapper.hidden = mode !== "range";
      if (toWrapper) toWrapper.hidden = mode !== "range";
      applyFilter();
    });
  }
  if (weekSelect) weekSelect.addEventListener("change", applyFilter);
  if (fromSelect) fromSelect.addEventListener("change", applyFilter);
  if (toSelect) toSelect.addEventListener("change", applyFilter);

  // initial summary text already matches default "season" view
}

// -----------------------------------------------------------------------------
// Player leaders
// -----------------------------------------------------------------------------

// Build placeholder players for a category if there is no real data yet.
function buildFallbackPlayersForCategory(category) {
  const players = [];
  for (const meta of TEAM_META) {
    const base = {
      id: `fallback_${category}_${meta.code}`,
      name: `${meta.city} ${meta.name} ${category === "kicking" ? "K" : "Player"}`,
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
      xpAtt: 0
    };

    if (category === "passing") base.passAtt = 1;
    if (category === "rushing") base.rushAtt = 1;
    if (category === "receiving") {
      base.targets = 1;
      base.receptions = 1;
    }
    if (category === "kicking") {
      base.fgAtt = 1;
      base.xpAtt = 1;
    }

    players.push(base);
  }
  return players;
}

function renderAllLeaders(leagueState, save, scope) {
  const stats = (leagueState.seasonStats && leagueState.seasonStats.players) || {};
  const players = Object.values(stats);

  renderCategory(players, save, "passing", "passYds", "passTD", "passInt");
  renderCategory(players, save, "rushing", "rushYds", "rushTD");
  renderCategory(players, save, "receiving", "recYds", "recTD");
  renderCategory(players, save, "kicking", "fgMade", "fgAtt", "xpMade", "xpAtt");
}

function renderCategory(players, save, category, ...fields) {
  const listEl = document.getElementById(`leader-list-${category}`);
  const expandBtn = document.getElementById(`btn-expand-${category}`);
  if (!listEl || !expandBtn) return;

  const mainField = fields[0];

  // Filter by category, but if nothing qualifies, use fallback players
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

  if (!filtered.length) {
    filtered = buildFallbackPlayersForCategory(category);
  }

  // Sort strictly greatest -> fewest on the main stat
  filtered.sort((a, b) => {
    const av = Number(a[mainField]) || 0;
    const bv = Number(b[mainField]) || 0;
    return bv - av;
  });

  const expanded = expandBtn.dataset.expanded === "true";
  const limit = expanded ? 25 : 5;
  const topPlayers = filtered.slice(0, limit);

  listEl.innerHTML = "";
  topPlayers.forEach((p, index) => {
    const li = document.createElement("li");
    li.className = "leader-row";
    if (p.teamCode === save.teamCode) {
      li.classList.add("leader-row--user-team");
    }

    const rank = document.createElement("div");
    rank.className = "leader-rank";
    rank.textContent = String(index + 1);

    const playerDiv = document.createElement("div");
    playerDiv.className = "leader-player";

    const nameSpan = document.createElement("span");
    nameSpan.className = "leader-name";
    nameSpan.textContent = p.name || "Unknown";

    const teamSpan = document.createElement("span");
    teamSpan.className = "leader-team";
    teamSpan.textContent = p.teamCode || "";

    playerDiv.appendChild(nameSpan);
    playerDiv.appendChild(teamSpan);

    const statDiv = document.createElement("div");
    statDiv.className = "leader-stat";
    statDiv.textContent = (Number(p[mainField]) || 0).toLocaleString();

    li.appendChild(rank);
    li.appendChild(playerDiv);
    li.appendChild(statDiv);
    listEl.appendChild(li);
  });

  // Button label
  expandBtn.textContent = expanded ? "Show top 5" : "Show top 25";

  // Attach click handler once; it just flips the flag and re-renders this category.
  if (!expandBtn._hasListener) {
    expandBtn._hasListener = true;
    expandBtn.addEventListener("click", () => {
      const nowExpanded = expandBtn.dataset.expanded === "true";
      expandBtn.dataset.expanded = nowExpanded ? "false" : "true";
      renderCategory(players, save, category, ...fields);
    });
  }
}

// -----------------------------------------------------------------------------
// Team Stats Tab
// -----------------------------------------------------------------------------

function renderTeamRankings(leagueState, save /*, scope */) {
  const tableBody = document.getElementById("team-rankings-tbody");
  const offensePill = document.getElementById("pill-team-offense");
  const defensePill = document.getElementById("pill-team-defense");
  if (!tableBody || !offensePill || !defensePill) return;

  // Use real team stats if present, else build zeroed-out rows from TEAM_META
  const rawTeamsObj =
    (leagueState.seasonStats && leagueState.seasonStats.teams) || {};
  let teams = Object.values(rawTeamsObj);

  if (!teams.length) {
    teams = TEAM_META.map((meta) => ({
      teamCode: meta.code,
      gamesPlayed: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      yardsTotalFor: 0,
      yardsTotalAgainst: 0,
      passYdsFor: 0,
      passYdsAgainst: 0,
      rushYdsFor: 0,
      rushYdsAgainst: 0
    }));
  }

  function update(view) {
    tableBody.innerHTML = "";

    let sorted;
    if (view === "offense") {
      sorted = teams
        .map((t) => {
          const gp = t.gamesPlayed || 0;
          const denom = gp > 0 ? gp : 1;
          return {
            ...t,
            ppg: (t.pointsFor || 0) / denom,
            ypg: (t.yardsTotalFor || 0) / denom,
            pass: (t.passYdsFor || 0) / denom,
            rush: (t.rushYdsFor || 0) / denom
          };
        })
        .sort((a, b) => b.ppg - a.ppg);
    } else {
      // defense: lower is better
      sorted = teams
        .map((t) => {
          const gp = t.gamesPlayed || 0;
          const denom = gp > 0 ? gp : 1;
          return {
            ...t,
            ppg: (t.pointsAgainst || 0) / denom,
            ypg: (t.yardsTotalAgainst || 0) / denom,
            pass: (t.passYdsAgainst || 0) / denom,
            rush: (t.rushYdsAgainst || 0) / denom
          };
        })
        .sort((a, b) => a.ppg - b.ppg);
    }

    for (const t of sorted) {
      const tr = document.createElement("tr");
      if (t.teamCode === save.teamCode) {
        tr.classList.add("team-row--user-team");
      }

      const nameCell = document.createElement("td");
      nameCell.textContent = getTeamDisplayName(t.teamCode);

      const gpCell = document.createElement("td");
      gpCell.textContent = (t.gamesPlayed || 0).toString();

      const pfpgCell = document.createElement("td");
      pfpgCell.textContent = t.ppg.toFixed(1);

      const ypgCell = document.createElement("td");
      ypgCell.textContent = t.ypg.toFixed(1);

      const passCell = document.createElement("td");
      passCell.textContent = t.pass.toFixed(1);

      const rushCell = document.createElement("td");
      rushCell.textContent = t.rush.toFixed(1);

      tr.appendChild(nameCell);
      tr.appendChild(gpCell);
      tr.appendChild(pfpgCell);
      tr.appendChild(ypgCell);
      tr.appendChild(passCell);
      tr.appendChild(rushCell);

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

  // initial view
  update("offense");
}
