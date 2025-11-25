// stats.js — Franchise GM League Stats
// -----------------------------------------------------------------------------
// Clean, modular, and defensive rewrite of your previous stats system.
// -----------------------------------------------------------------------------

import { getTeamDisplayName } from "./league_schedule.js";
import { rebuildSeasonStats } from "./league_stats.js";

const SAVE_KEY = "franchiseGM_lastFranchise";
const LEAGUE_PREFIX = "franchiseGM_leagueState_";

// -----------------------------
// Storage utilities
// -----------------------------
const safeStorage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  has() {
    try {
      const k = "__test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch { return false; }
  }
};

function leagueKey(id) { return `${LEAGUE_PREFIX}${id}`; }

// -----------------------------
// Initialization
// -----------------------------
document.addEventListener("DOMContentLoaded", async () => {
  if (!safeStorage.has()) return showNoFranchise();

  const save = safeStorage.get(SAVE_KEY);
  if (!save?.franchiseId) return showNoFranchise();

  let state = safeStorage.get(leagueKey(save.franchiseId)) || {
    franchiseId: save.franchiseId,
    seasonYear: save.seasonYear,
    gameStats: {},
    seasonStats: { teams: {}, players: {} },
  };

  rebuildSeasonStats(state);
  safeStorage.set(leagueKey(save.franchiseId), state);

  populateHeader(save, state);
  initNavigation();
  initScope(state, save);
  initTabs();
  renderLeaders(state, save);
  renderTeams(state, save);
});

// -----------------------------
// UI Functions
// -----------------------------
function populateHeader(save, state) {
  document.getElementById("stats-header-name").textContent = getTeamDisplayName(save.teamCode);
  document.getElementById("stats-header-subline").textContent = `Season ${save.seasonYear} • League Stats`;
  document.getElementById("stats-record-value").textContent = save.record || "0–0";
}

function initNavigation() {
  const back = document.getElementById("btn-stats-back");
  if (back) back.onclick = () => (window.location.href = "franchise.html");
  const newFr = document.getElementById("btn-new-franchise");
  if (newFr) newFr.onclick = () => (window.location.href = "team_select.html");
}

function initTabs() {
  const tabs = document.querySelectorAll(".stats-tab");
  tabs.forEach(t => {
    t.addEventListener("click", () => {
      tabs.forEach(tab => {
        tab.dataset.active = "false";
        document.getElementById(tab.dataset.panel).hidden = true;
      });
      t.dataset.active = "true";
      document.getElementById(t.dataset.panel).hidden = false;
    });
  });
}

function initScope(state, save) {
  const modeSel = document.getElementById("scope-mode-select");
  const weekSel = document.getElementById("scope-week-select");
  const fromSel = document.getElementById("scope-range-from-select");
  const toSel = document.getElementById("scope-range-to-select");
  const summary = document.getElementById("scope-summary-text");

  const weekCount = 18;
  [weekSel, fromSel, toSel].forEach(sel => {
    sel.innerHTML = "";
    for (let i = 0; i < weekCount; i++) {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = `Week ${i + 1}`;
      sel.appendChild(o);
    }
  });

  function apply() {
    const mode = modeSel.value;
    let range = { through: null };
    if (mode === "season") summary.textContent = "Season to date.";
    if (mode === "week") {
      const w = parseInt(weekSel.value, 10);
      summary.textContent = `Week ${w + 1} only.`;
      range.through = w;
    }
    if (mode === "range") {
      const a = parseInt(fromSel.value, 10), b = parseInt(toSel.value, 10);
      const min = Math.min(a, b), max = Math.max(a, b);
      summary.textContent = `Weeks ${min + 1}–${max + 1}.`;
      range.through = max;
    }
    rebuildSeasonStats(state, { throughWeekIndex0: range.through });
    renderLeaders(state, save);
    renderTeams(state, save);
  }

  modeSel.onchange = apply;
  weekSel.onchange = apply;
  fromSel.onchange = apply;
  toSel.onchange = apply;
}

// -----------------------------
// Renderers
// -----------------------------
function renderLeaders(state, save) {
  const stats = state.seasonStats?.players || {};
  const arr = Object.values(stats);
  renderCategory(arr, save, "passing", "passYds");
  renderCategory(arr, save, "rushing", "rushYds");
  renderCategory(arr, save, "receiving", "recYds");
  renderCategory(arr, save, "kicking", "fgMade");
}

function renderCategory(players, save, id, key) {
  const list = document.getElementById(`leader-list-${id}`);
  if (!list) return;
  list.innerHTML = "";

  const filtered = players
    .filter(p => (p[key] || 0) > 0)
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .slice(0, 10);

  filtered.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "leader-row";
    if (p.teamCode === save.teamCode) li.classList.add("leader-row--user-team");

    const left = document.createElement("div");
    left.innerHTML = `<strong>${i + 1}.</strong> ${p.name || "Unknown"} <span style="color:#9ca3af;">(${p.teamCode})</span>`;
    const right = document.createElement("div");
    right.className = "leader-stat";
    right.textContent = (p[key] || 0).toLocaleString();

    li.append(left, right);
    list.appendChild(li);
  });
}

function renderTeams(state, save) {
  const teams = Object.values(state.seasonStats?.teams || {});
  const body = document.getElementById("team-rankings-tbody");
  if (!body) return;
  body.innerHTML = "";

  const ranked = teams
    .map(t => ({
      ...t,
      ppg: t.pointsFor / Math.max(1, t.gamesPlayed),
      ypg: t.yardsTotalFor / Math.max(1, t.gamesPlayed),
    }))
    .sort((a, b) => b.ppg - a.ppg);

  ranked.forEach(t => {
    const tr = document.createElement("tr");
    if (t.teamCode === save.teamCode) tr.classList.add("team-row--user-team");
    tr.innerHTML = `
      <td>${getTeamDisplayName(t.teamCode)}</td>
      <td>${t.gamesPlayed}</td>
      <td>${t.ppg.toFixed(1)}</td>
      <td>${t.ypg.toFixed(1)}</td>
      <td>${(t.passYdsFor / Math.max(1, t.gamesPlayed)).toFixed(1)}</td>
      <td>${(t.rushYdsFor / Math.max(1, t.gamesPlayed)).toFixed(1)}</td>`;
    body.appendChild(tr);
  });
}

// -----------------------------
// Fallback
// -----------------------------
function showNoFranchise() {
  document.querySelector("main").hidden = true;
  document.getElementById("no-franchise").hidden = false;
}
