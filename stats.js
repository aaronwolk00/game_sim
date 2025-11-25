// stats.js
// -----------------------------------------------------------------------------
// Franchise GM – League Stats & Leaders
//
// Displays player and team leaderboards based on leagueState.seasonStats.
// Supports week/range filtering, expandable leader cards, and an offense/defense
// team stats tab.
// -----------------------------------------------------------------------------

import { TEAM_META, getTeamDisplayName, recomputeRecordFromSchedule } from "./league_schedule.js";
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
    noFranchise.hidden = false;
    root.querySelector("main").hidden = true;
    document.getElementById("btn-no-franchise-start").onclick = () => {
      window.location.href = "team_select.html";
    };
    document.getElementById("btn-no-franchise-landing").onclick = () => {
      window.location.href = "index.html";
    };
    return;
  }

  // Load state
  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear,
      gameStats: {},
      seasonStats: { updatedThroughWeekIndex0: null, teams: {}, players: {} },
    };
  }

  // Ensure we have season stats rebuilt
  rebuildSeasonStats(leagueState, { throughWeekIndex0: null });
  saveLeagueState(save.franchiseId, leagueState);

  populateHeader(save, leagueState);
  setupNavigation(save);
  setupScopeControls(save, leagueState);
  setupTabs();
  renderAllLeaders(leagueState, save, { throughWeekIndex0: null, rangeFrom: null, rangeTo: null });
}

function populateHeader(save, leagueState) {
    const teamName = getTeamDisplayName(save.teamCode);
    const recordFromSchedule = recomputeRecordFromSchedule(leagueState, save.teamCode);
    const record = recordFromSchedule || save.record || "0–0";
  
    document.getElementById("stats-header-name").textContent = teamName;
    document.getElementById("stats-header-subline").textContent =
      `Season ${save.seasonYear} • League Stats & Leaders`;
    document.getElementById("stats-record-value").textContent = record;
}
  

function setupNavigation(save) {
  const btnBack = document.getElementById("btn-stats-back");
  btnBack.addEventListener("click", () => {
    window.location.href = "franchise.html";
  });
}

function setupTabs() {
  const tabs = document.querySelectorAll(".stats-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => {
        t.dataset.active = "false";
        t.setAttribute("aria-selected", "false");
        document.getElementById(t.dataset.panelId).hidden = true;
      });
      tab.dataset.active = "true";
      tab.setAttribute("aria-selected", "true");
      document.getElementById(tab.dataset.panelId).hidden = false;
    });
  });
}

function setupScopeControls(save, leagueState) {
  const modeSelect = document.getElementById("scope-mode-select");
  const weekSelect = document.getElementById("scope-week-select");
  const fromSelect = document.getElementById("scope-range-from-select");
  const toSelect = document.getElementById("scope-range-to-select");
  const summary = document.getElementById("scope-summary-text");

  const weekCount =
    (leagueState.schedule && leagueState.schedule.byTeam && leagueState.schedule.byTeam[save.teamCode]?.length) ||
    18;

  // Populate weeks
  [weekSelect, fromSelect, toSelect].forEach(sel => {
    sel.innerHTML = "";
    for (let i = 0; i < weekCount; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Week ${i + 1}`;
      sel.appendChild(opt);
    }
  });

  const state = { throughWeekIndex0: null, rangeFrom: null, rangeTo: null };

  function applyFilter() {
    const mode = modeSelect.value;
    if (mode === "season") {
      state.throughWeekIndex0 = null;
      summary.textContent = "Season to date.";
      rebuildSeasonStats(leagueState, { throughWeekIndex0: null });
    } else if (mode === "week") {
      const w = parseInt(weekSelect.value, 10);
      state.throughWeekIndex0 = w;
      summary.textContent = `Week ${w + 1} only.`;
      rebuildSeasonStats(leagueState, { throughWeekIndex0: w });
    } else if (mode === "range") {
      const from = parseInt(fromSelect.value, 10);
      const to = parseInt(toSelect.value, 10);
      state.rangeFrom = Math.min(from, to);
      state.rangeTo = Math.max(from, to);
      summary.textContent = `Weeks ${state.rangeFrom + 1}–${state.rangeTo + 1}.`;
      rebuildSeasonStats(leagueState, { throughWeekIndex0: state.rangeTo });
    }
    renderAllLeaders(leagueState, save, state);
    renderTeamRankings(leagueState, save, state);
  }

  modeSelect.addEventListener("change", () => {
    const mode = modeSelect.value;
    document.getElementById("scope-week-wrapper").hidden = mode !== "week";
    document.getElementById("scope-range-from-wrapper").hidden = mode !== "range";
    document.getElementById("scope-range-to-wrapper").hidden = mode !== "range";
    applyFilter();
  });
  weekSelect.addEventListener("change", applyFilter);
  fromSelect.addEventListener("change", applyFilter);
  toSelect.addEventListener("change", applyFilter);
}

function renderAllLeaders(leagueState, save, scope) {
  const stats = leagueState.seasonStats?.players || {};
  const players = Object.values(stats);
  renderCategory(players, save, "passing", "passYds", "passTD", "passInt");
  renderCategory(players, save, "rushing", "rushYds", "rushTD");
  renderCategory(players, save, "receiving", "recYds", "recTD");
  renderCategory(players, save, "kicking", "fgMade", "fgAtt", "xpMade", "xpAtt");
}

function renderCategory(players, save, category, ...fields) {
  const listEl = document.getElementById(`leader-list-${category}`);
  if (!listEl) return;
  listEl.innerHTML = "";
  let filtered = [];
  if (category === "passing") filtered = players.filter(p => p.passAtt > 0);
  else if (category === "rushing") filtered = players.filter(p => p.rushAtt > 0);
  else if (category === "receiving") filtered = players.filter(p => p.receptions > 0 || p.targets > 0);
  else if (category === "kicking") filtered = players.filter(p => p.fgAtt > 0 || p.xpAtt > 0);

  filtered.sort((a, b) => {
    const main = fields[0];
    return (b[main] || 0) - (a[main] || 0);
  });

  const showTop = 5;
  const topPlayers = filtered.slice(0, showTop);

  for (let i = 0; i < topPlayers.length; i++) {
    const p = topPlayers[i];
    const li = document.createElement("li");
    li.className = "leader-row";
    if (p.teamCode === save.teamCode) li.classList.add("leader-row--user-team");
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
    const mainField = fields[0];
    stat.textContent = (p[mainField] || 0).toLocaleString();
    li.append(rank, playerDiv, stat);
    listEl.appendChild(li);
  }

  // Expand button
  const expandBtn = document.getElementById(`btn-expand-${category}`);
  if (expandBtn) {
    expandBtn.onclick = () => {
      const expanded = expandBtn.dataset.expanded === "true";
      expandBtn.dataset.expanded = expanded ? "false" : "true";
      expandBtn.textContent = expanded ? "Show top 25" : "Show top 5";
      listEl.innerHTML = "";
      const arr = expanded ? filtered.slice(0, 25) : filtered.slice(0, 5);
      arr.forEach((p, i) => {
        const li = document.createElement("li");
        li.className = "leader-row";
        if (p.teamCode === save.teamCode) li.classList.add("leader-row--user-team");
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
        const mainField = fields[0];
        stat.textContent = (p[mainField] || 0).toLocaleString();
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
  const teams = Object.values(leagueState.seasonStats?.teams || {});
  const offensePill = document.getElementById("pill-team-offense");
  const defensePill = document.getElementById("pill-team-defense");

  function update(view) {
    tableBody.innerHTML = "";
    let sorted = [];
    if (view === "offense") {
      sorted = teams
        .map(t => ({
          ...t,
          ppg: t.pointsFor / Math.max(1, t.gamesPlayed),
          ypg: t.yardsTotalFor / Math.max(1, t.gamesPlayed),
        }))
        .sort((a, b) => b.ppg - a.ppg);
    } else {
      sorted = teams
        .map(t => ({
          ...t,
          ppg: t.pointsAgainst / Math.max(1, t.gamesPlayed),
          ypg: t.yardsTotalAgainst / Math.max(1, t.gamesPlayed),
        }))
        .sort((a, b) => a.ppg - b.ppg);
    }

    for (const t of sorted) {
      const tr = document.createElement("tr");
      if (t.teamCode === save.teamCode) tr.classList.add("team-row--user-team");
      const nameCell = document.createElement("td");
      nameCell.textContent = getTeamDisplayName(t.teamCode);
      const gp = document.createElement("td");
      gp.textContent = t.gamesPlayed;
      const pfpg = document.createElement("td");
      pfpg.textContent = t.ppg.toFixed(1);
      const ypg = document.createElement("td");
      ypg.textContent = t.ypg.toFixed(1);
      const pass = document.createElement("td");
      const rush = document.createElement("td");
      if (view === "offense") {
        pass.textContent = (t.passYdsFor / Math.max(1, t.gamesPlayed)).toFixed(1);
        rush.textContent = (t.rushYdsFor / Math.max(1, t.gamesPlayed)).toFixed(1);
      } else {
        pass.textContent = (t.passYdsAgainst / Math.max(1, t.gamesPlayed)).toFixed(1);
        rush.textContent = (t.rushYdsAgainst / Math.max(1, t.gamesPlayed)).toFixed(1);
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

  update("offense");
}
