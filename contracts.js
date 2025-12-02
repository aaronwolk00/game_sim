// contracts.js
// -----------------------------------------------------------------------------
// Franchise GM – Contracts & Cap Overview
//
// - Loads FranchiseSave + LeagueState from localStorage.
// - Loads the Layer3 league (same CSV as game day).
// - If LeagueState.contracts is missing, seeds contracts for every player on
//   every team, fitting roughly under a cap per club.
// - Renders a cap-sheet style grid for the selected team or the full league.
// -----------------------------------------------------------------------------

import { loadLeague } from "./data_models.js";
import {
  getTeamDisplayName,
  ensureAllTeamSchedules
} from "./league_schedule.js";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__contracts";
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
    console.warn("[Contracts] Failed to save league state:", err);
  }
}

// ---------------------------------------------------------------------------
// League loading (same CSV override convention as franchise_gameday)
// ---------------------------------------------------------------------------

const PARAMS = new URLSearchParams(window.location.search);

const RAW_PLAYERS_PARAM = (PARAMS.get("players") || "").replace(
  "/refs/heads/",
  "/"
);

const DEFAULT_CSV_URL =
  "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/layer3_rosters.csv";

const CSV_URL = RAW_PLAYERS_PARAM || DEFAULT_CSV_URL;

let gLeague = null;
let leagueLoadPromise = null;

function ensureLeagueLoaded() {
  if (!leagueLoadPromise) {
    leagueLoadPromise = (async () => {
      const lg = await loadLeague(CSV_URL);
      if (!lg || !Array.isArray(lg.teams) || !lg.teams.length) {
        throw new Error("League has no teams");
      }
      gLeague = lg;
      return lg;
    })();
  }
  return leagueLoadPromise;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = getEl(id);
  if (el) el.textContent = text;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "$—";
  const millions = value / 1_000_000;
  return "$" + millions.toFixed(1) + "M";
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(1) + "%";
}

function parseRecord(recordStr) {
  if (!recordStr || typeof recordStr !== "string") {
    return { wins: 0, losses: 0 };
  }
  const m = recordStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return { wins: 0, losses: 0 };
  return { wins: Number(m[1]) || 0, losses: Number(m[2]) || 0 };
}

// ---------------------------------------------------------------------------
// Contracts model
// ---------------------------------------------------------------------------

const CONTRACTS_MODEL_VERSION = 1;
const DEFAULT_CAP_START = 255_000_000; // starting cap this season
const DEFAULT_CAP_GROWTH = 0.04;       // +4% / year
const CONTRACT_YEARS = 4;              // how many forward seasons to model

/**
 * @typedef {Object} ContractYear
 * @property {number} seasonYear
 * @property {number} capHit
 * @property {number} cash
 * @property {number} deadIfCut
 */

/**
 * @typedef {Object} PlayerContract
 * @property {string} playerId
 * @property {string} name
 * @property {string} pos
 * @property {string} teamCode
 * @property {number|null} age
 * @property {number|null} overall
 * @property {number} years
 * @property {number} totalValue
 * @property {number} guaranteed
 * @property {number} aav
 * @property {ContractYear[]} schedule
 */

/**
 * @typedef {Object} LeagueContracts
 * @property {number} version
 * @property {number} baseSeasonYear
 * @property {Object.<string, number>} capBySeason
 * @property {Object.<string, PlayerContract[]>} byTeam   // teamCode -> contracts
 */

// Try to extract a "players" array from the loaded league model
function extractPlayersArray(league) {
  if (!league) return [];
  if (Array.isArray(league.players)) return league.players;
  if (Array.isArray(league.roster)) return league.roster;
  if (Array.isArray(league.allPlayers)) return league.allPlayers;

  // Fallback: aggregate from team rosters if present
  const aggregated = [];
  if (Array.isArray(league.teams)) {
    for (const t of league.teams) {
      const roster =
        t.players ||
        t.roster ||
        t.playerList ||
        null;
      if (Array.isArray(roster)) {
        aggregated.push(...roster);
      }
    }
  }
  return aggregated;
}

// Attempt to infer teamCode for a player based on commonly used fields
function inferTeamCodeForPlayer(p, validCodes) {
  const candidates = [
    p.teamCode,
    p.team,
    p.team_id,
    p.teamId,
    p.nfl_team,
    p.nflTeam,
    p.team_abbr,
    p.abbr
  ]
    .map((v) => (v == null ? "" : String(v).toUpperCase()))
    .filter(Boolean);

  for (const c of candidates) {
    if (!validCodes || validCodes.has(c)) return c;
  }
  return candidates[0] || null;
}

function inferPlayerId(p, idx) {
  return (
    p.playerId ||
    p.id ||
    p.gsis_id ||
    p.pfr_id ||
    p.name ||
    `player_${idx}`
  );
}

function inferPlayerName(p) {
  return (
    p.displayName ||
    p.name ||
    p.full_name ||
    `${p.first_name || ""} ${p.last_name || ""}`.trim() ||
    "Player"
  );
}

function inferPlayerPos(p) {
  const pos =
    p.position ||
    p.pos ||
    p.role ||
    p.depth_chart_position ||
    "";
  return pos ? String(pos).toUpperCase() : "UNK";
}

function inferPlayerAge(p) {
  const age =
    p.age ??
    p.player_age ??
    p.age_on_season_start ??
    null;
  const num = Number(age);
  if (!Number.isFinite(num) || num <= 0 || num > 45) return null;
  return num;
}

function inferPlayerOverall(p) {
  const o =
    p.overall ??
    p.ovr ??
    p.rating ??
    p.overallRating ??
    null;
  const num = Number(o);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

// Very simple positional market buckets (AAV in millions before scaling)
function baseAavMillionsFor(pos, overall) {
  const o = overall ?? 75;
  const posGroup = (() => {
    if (pos === "QB") return "QB";
    if (["WR", "TE"].includes(pos)) return "REC";
    if (["RB", "FB"].includes(pos)) return "RB";
    if (["OT", "OG", "C", "OL", "LT", "RT", "G"].includes(pos)) return "OL";
    if (["EDGE", "DE", "DT", "DL", "IDL"].includes(pos)) return "DL";
    if (["LB", "ILB", "MLB", "OLB"].includes(pos)) return "LB";
    if (["CB", "S", "FS", "SS", "DB"].includes(pos)) return "DB";
    if (["K", "P"].includes(pos)) return "K";
    return "OTHER";
  })();

  const tier =
    o >= 90 ? "elite" :
    o >= 82 ? "starter" :
    o >= 74 ? "role" :
    "depth";

  const ranges = {
    QB: {
      elite: [45, 60],
      starter: [25, 35],
      role: [10, 18],
      depth: [3, 6]
    },
    REC: {
      elite: [22, 30],
      starter: [14, 22],
      role: [6, 12],
      depth: [1.5, 4]
    },
    RB: {
      elite: [13, 18],
      starter: [7, 12],
      role: [3, 7],
      depth: [1, 3]
    },
    OL: {
      elite: [18, 24],
      starter: [11, 17],
      role: [5, 9],
      depth: [1.5, 4]
    },
    DL: {
      elite: [22, 30],
      starter: [14, 21],
      role: [6, 12],
      depth: [1.5, 4]
    },
    LB: {
      elite: [16, 22],
      starter: [10, 15],
      role: [5, 9],
      depth: [1.5, 4]
    },
    DB: {
      elite: [19, 26],
      starter: [11, 18],
      role: [5, 9],
      depth: [1.5, 4]
    },
    K: {
      elite: [4, 6],
      starter: [3, 4],
      role: [1.5, 3],
      depth: [1, 1.5]
    },
    OTHER: {
      elite: [10, 14],
      starter: [6, 9],
      role: [3, 5],
      depth: [1, 3]
    }
  };

  const [min, max] = ranges[posGroup][tier];
  // simple deterministic-ish jitter: use overall as seed factor
  const t = (o % 10) / 10;
  return min + (max - min) * t;
}

// Seed LeagueState.contracts from the actual roster if not present.
function ensureContractsModel(leagueState, league, seasonYear) {
  if (!leagueState) return null;

  if (
    leagueState.contracts &&
    leagueState.contracts.version === CONTRACTS_MODEL_VERSION &&
    leagueState.contracts.byTeam &&
    Object.keys(leagueState.contracts.byTeam).length
  ) {
    return leagueState.contracts;
  }

  /** @type {LeagueContracts} */
  const model = {
    version: CONTRACTS_MODEL_VERSION,
    baseSeasonYear: seasonYear,
    capBySeason: {},
    byTeam: {}
  };

  // Cap table
  let cap = DEFAULT_CAP_START;
  for (let i = 0; i < CONTRACT_YEARS; i++) {
    const yr = seasonYear + i;
    model.capBySeason[yr] = Math.round(cap);
    cap *= 1 + DEFAULT_CAP_GROWTH;
  }

  const scheduleTeamCodes = new Set(
    Object.keys(leagueState.schedule?.byTeam || {})
  );

  const players = extractPlayersArray(league);
  const byTeamRaw = new Map();

  players.forEach((p, idx) => {
    const teamCode = inferTeamCodeForPlayer(p, scheduleTeamCodes);
    if (!teamCode) return;
    const playerId = inferPlayerId(p, idx);
    const name = inferPlayerName(p);
    const pos = inferPlayerPos(p);
    const age = inferPlayerAge(p);
    const overall = inferPlayerOverall(p);

    const key = String(teamCode).toUpperCase();
    if (!byTeamRaw.has(key)) byTeamRaw.set(key, []);
    byTeamRaw.get(key).push({
      playerId,
      name,
      pos,
      age,
      overall
    });
  });

  // For each team, compute a base AAV for everyone, then scale so that
  // total AAV ≈ 88% of cap in year 1.
  for (const [teamCode, roster] of byTeamRaw.entries()) {
    const contracts = [];

    if (!roster.length) {
      model.byTeam[teamCode] = contracts;
      continue;
    }

    const baseAavs = roster.map((p) =>
      baseAavMillionsFor(p.pos, p.overall || 75)
    ); // in millions
    const totalBaseAavMillions = baseAavs.reduce((a, b) => a + b, 0);
    const capYear1 = model.capBySeason[seasonYear] || DEFAULT_CAP_START;
    const targetAavMillions = (capYear1 * 0.88) / 1_000_000;
    const scale =
      totalBaseAavMillions > 0
        ? Math.max(
            0.4,
            Math.min(1.2, targetAavMillions / totalBaseAavMillions)
          )
        : 0.6;

    roster.forEach((p, idx) => {
      const aavMillions = baseAavs[idx] * scale;
      const aav = Math.max(0.75, aavMillions) * 1_000_000;

      const age = p.age ?? 26;
      let years = 3;
      if (age <= 25) years = 4;
      else if (age >= 30) years = 2;
      years = Math.max(1, Math.min(CONTRACT_YEARS, years));

      const totalValue = aav * years;
      const guaranteePctBase =
        p.overall && p.overall >= 88
          ? 0.78
          : p.overall && p.overall >= 82
          ? 0.68
          : p.overall && p.overall >= 75
          ? 0.58
          : 0.4;
      const guaranteed = totalValue * guaranteePctBase;

      const schedule = [];
      let remainingGuarantee = guaranteed;

      for (let i = 0; i < years; i++) {
        const season = seasonYear + i;
        const capYear = model.capBySeason[season] || capYear1;
        // Give a slightly backloaded structure
        const pct =
          0.22 + (i / Math.max(1, years - 1)) * 0.16 + 0.02 * (idx % 3);
        const capHit = Math.min(capYear * 0.18, aav * (0.9 + pct));
        const cash = aav * (0.9 + pct * 0.25);

        // Simple guarantee amortization
        const thisYearGuarantee =
          i === years - 1
            ? remainingGuarantee
            : Math.min(remainingGuarantee, guaranteed / years);
        remainingGuarantee -= thisYearGuarantee;

        schedule.push({
          seasonYear: season,
          capHit: Math.round(capHit),
          cash: Math.round(cash),
          deadIfCut: Math.round(thisYearGuarantee)
        });
      }

      /** @type {PlayerContract} */
      const contract = {
        playerId: p.playerId,
        name: p.name,
        pos: p.pos,
        teamCode,
        age: p.age,
        overall: p.overall ?? null,
        years,
        totalValue: Math.round(totalValue),
        guaranteed: Math.round(guaranteed),
        aav: Math.round(aav),
        schedule
      };

      contracts.push(contract);
    });

    // Sort within team by AAV descending so best players bubble up
    contracts.sort((a, b) => b.aav - a.aav);
    model.byTeam[teamCode] = contracts;
  }

  leagueState.contracts = model;
  return model;
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let gSave = null;
/** @type {any} */
let gLeagueState = null;
/** @type {LeagueContracts|null} */
let gContracts = null;

let gSelectedTeamCode = "FRANCHISE"; // or "LEAGUE_ALL"
let gSelectedSeasonYear = 0;
let gViewMode = "cap"; // "cap" | "cash" | "dead"

let gCurrentContracts = []; // currently displayed contracts (team or league slice)
let gPlayerRankingsByPos = {}; // pos -> sorted list for league rankings
let gFocusedPlayerKey = null;

// ---------------------------------------------------------------------------
// League-wide rankings
// ---------------------------------------------------------------------------

function buildLeagueRankings(contractsModel) {
  const byPos = {};

  for (const [teamCode, contracts] of Object.entries(
    contractsModel.byTeam || {}
  )) {
    contracts.forEach((c) => {
      const pos = c.pos || "UNK";
      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push({
        teamCode,
        name: c.name,
        aav: c.aav,
        guaranteed: c.guaranteed,
        playerId: c.playerId
      });
    });
  }

  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => b.aav - a.aav);
  }

  gPlayerRankingsByPos = byPos;
}

// ---------------------------------------------------------------------------
// Rendering – header + controls
// ---------------------------------------------------------------------------

function getTeamNameFromSave(save) {
  if (save.teamName) return save.teamName;
  if (save.franchiseName) return save.franchiseName;
  return getTeamDisplayName(save.teamCode || "");
}

function renderHeader() {
  if (!gSave) return;
  setText("team-name-heading", getTeamNameFromSave(gSave));
  const year = gSave.seasonYear || "";
  setText(
    "season-phase-line",
    `${year} • Contracts & Cap Overview`
  );
  const record = gSave.record || "0-0";
  setText("record-pill-value", record);
}

function renderTeamSelect() {
  const select = getEl("contracts-team-select");
  if (!select || !gContracts) return;

  const teamCodes = Object.keys(gContracts.byTeam || {}).sort();

  select.innerHTML = "";

  // Franchise team first
  const franchiseCode = (gSave?.teamCode || "").toUpperCase();
  if (franchiseCode && teamCodes.includes(franchiseCode)) {
    const opt = document.createElement("option");
    opt.value = franchiseCode;
    opt.textContent = `${getTeamDisplayName(franchiseCode)} (My team)`;
    select.appendChild(opt);
  }

  // League All
  const leagueOpt = document.createElement("option");
  leagueOpt.value = "LEAGUE_ALL";
  leagueOpt.textContent = "League – All teams";
  select.appendChild(leagueOpt);

  // Divider-style option (disabled) is tricky across browsers, so skip.

  // Remaining teams (excluding franchise if already added)
  teamCodes.forEach((code) => {
    if (code === franchiseCode) return;
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = getTeamDisplayName(code);
    select.appendChild(opt);
  });

  // Initial selection
  gSelectedTeamCode = franchiseCode || "LEAGUE_ALL";
  select.value = gSelectedTeamCode;

  select.addEventListener("change", () => {
    gSelectedTeamCode = select.value;
    gFocusedPlayerKey = null;
    renderContractsView();
  });
}

function renderSeasonTabs() {
  const tabsRoot = getEl("contracts-season-tabs");
  if (!tabsRoot || !gContracts) return;

  tabsRoot.innerHTML = "";

  const seasons = Object.keys(gContracts.capBySeason || {})
    .map((s) => Number(s))
    .sort((a, b) => a - b);

  if (!seasons.length) return;

  if (!gSelectedSeasonYear) {
    gSelectedSeasonYear = seasons[0];
  }

  seasons.forEach((yr) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "season-tab";
    btn.dataset.active = yr === gSelectedSeasonYear ? "true" : "false";
    btn.textContent = `${yr} Cap`;
    btn.addEventListener("click", () => {
      gSelectedSeasonYear = yr;
      renderSeasonTabs();
      renderContractsView();
    });
    tabsRoot.appendChild(btn);
  });
}

function bindViewToggleButtons() {
  const buttons = [
    getEl("contracts-view-cap"),
    getEl("contracts-view-cash"),
    getEl("contracts-view-dead")
  ].filter(Boolean);

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view") || "cap";
      gViewMode = view;
      buttons.forEach((b) => {
        b.dataset.active = b === btn ? "true" : "false";
      });
      renderContractsView();
    });
  });
}

// ---------------------------------------------------------------------------
// Rendering – contracts table
// ---------------------------------------------------------------------------

function getCurrentSliceContracts() {
  if (!gContracts) return [];

  if (gSelectedTeamCode === "LEAGUE_ALL") {
    const all = [];
    for (const [teamCode, list] of Object.entries(gContracts.byTeam || {})) {
      list.forEach((c) => all.push({ ...c, teamCode }));
    }
    // For league view, show top 150 by AAV for sanity
    all.sort((a, b) => b.aav - a.aav);
    return all.slice(0, 150);
  }

  return gContracts.byTeam[gSelectedTeamCode] || [];
}

function findYearEntry(contract, seasonYear) {
  if (!contract || !Array.isArray(contract.schedule)) return null;
  return contract.schedule.find((y) => y.seasonYear === seasonYear) || null;
}

function renderContractsTable() {
  const tbody = getEl("contracts-table-body");
  if (!tbody) return;

  const col1 = getEl("contracts-year-col-1");
  const col2 = getEl("contracts-year-col-2");
  const col3 = getEl("contracts-year-col-3");

  const seasons = Object.keys(gContracts?.capBySeason || {})
    .map((s) => Number(s))
    .sort((a, b) => a - b);
  const baseline = seasons.indexOf(gSelectedSeasonYear);
  const yr1 = seasons[baseline] ?? seasons[0];
  const yr2 = seasons[baseline + 1] ?? seasons[1] ?? seasons[0];
  const yr3 = seasons[baseline + 2] ?? seasons[2] ?? seasons[0];

  if (col1) col1.textContent = yr1 ? String(yr1) : "Yr 1";
  if (col2) col2.textContent = yr2 ? String(yr2) : "Yr 2";
  if (col3) col3.textContent = yr3 ? String(yr3) : "Yr 3";

  const contracts = getCurrentSliceContracts();
  gCurrentContracts = contracts.slice();

  tbody.innerHTML = "";

  if (!contracts.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 11;
    td.className = "empty-state";
    td.textContent = "No contracts found for this selection.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  contracts.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className = "contracts-row";

    const key = `${c.teamCode || ""}|${c.playerId || c.name}`;
    if (gFocusedPlayerKey === key) {
      tr.dataset.focus = "true";
    }

    const y1 = findYearEntry(c, yr1);
    const y2 = findYearEntry(c, yr2);
    const y3 = findYearEntry(c, yr3);

    const nameTd = document.createElement("td");
    nameTd.innerHTML = `
      <div class="contracts-name-cell">
        <div class="contracts-name-primary">${c.name}</div>
        <div class="contracts-name-secondary">
          ${getTeamDisplayName(c.teamCode || "") || ""}${
      c.overall ? " • OVR " + c.overall : ""
    }
        </div>
      </div>
    `;

    const posTd = document.createElement("td");
    posTd.textContent = c.pos || "—";

    const ageTd = document.createElement("td");
    ageTd.className = "numeric";
    ageTd.textContent =
      c.age != null && Number.isFinite(c.age) ? String(c.age) : "—";

    const ovrTd = document.createElement("td");
    ovrTd.className = "numeric";
    ovrTd.textContent =
      c.overall != null && Number.isFinite(c.overall)
        ? String(c.overall)
        : "—";

    const yrsTd = document.createElement("td");
    yrsTd.className = "numeric";
    yrsTd.textContent = String(c.years);

    const aavTd = document.createElement("td");
    aavTd.className = "numeric";
    aavTd.textContent = formatMoney(c.aav);

    const totalTd = document.createElement("td");
    totalTd.className = "numeric";
    totalTd.textContent = formatMoney(c.totalValue);

    const gTd = document.createElement("td");
    gTd.className = "numeric";
    gTd.textContent = formatMoney(c.guaranteed);

    const y1Td = document.createElement("td");
    const y2Td = document.createElement("td");
    const y3Td = document.createElement("td");
    y1Td.className = y2Td.className = y3Td.className = "numeric";

    const pickField = (y) => {
      if (!y) return "—";
      if (gViewMode === "cap") return formatMoney(y.capHit);
      if (gViewMode === "cash") return formatMoney(y.cash);
      return formatMoney(y.deadIfCut);
    };

    y1Td.textContent = pickField(y1);
    y2Td.textContent = pickField(y2);
    y3Td.textContent = pickField(y3);

    tr.appendChild(nameTd);
    tr.appendChild(posTd);
    tr.appendChild(ageTd);
    tr.appendChild(ovrTd);
    tr.appendChild(yrsTd);
    tr.appendChild(aavTd);
    tr.appendChild(totalTd);
    tr.appendChild(gTd);
    tr.appendChild(y1Td);
    tr.appendChild(y2Td);
    tr.appendChild(y3Td);

    tr.addEventListener("click", () => {
      gFocusedPlayerKey = key;
      renderContractsTable();
      renderPlayerContext(c);
    });

    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Rendering – cap summary + player context
// ---------------------------------------------------------------------------

function renderCapSummary() {
  const capRoot = getEl("contracts-cap-summary");
  const empty = getEl("contracts-empty-summary");
  if (!capRoot || !empty || !gContracts) return;

  const contracts = getCurrentSliceContracts();
  if (!contracts.length) {
    capRoot.hidden = true;
    empty.hidden = false;
    return;
  }

  capRoot.hidden = false;
  empty.hidden = true;

  const capLimit = gContracts.capBySeason[gSelectedSeasonYear] ?? null;

  let capUsed = 0;
  contracts.forEach((c) => {
    const yr = findYearEntry(c, gSelectedSeasonYear);
    if (yr) {
      capUsed += yr.capHit;
    }
  });

  const capSpace = capLimit != null ? capLimit - capUsed : null;

  setText(
    "cap-summary-season-label",
    String(gSelectedSeasonYear)
  );
  setText("cap-summary-cap-limit", formatMoney(capLimit ?? NaN));
  setText("cap-summary-cap-used", formatMoney(capUsed));
  setText("cap-summary-cap-space", formatMoney(capSpace ?? NaN));

  const barFill = getEl("cap-summary-bar-fill");
  if (barFill) {
    const pct =
      capLimit && capLimit > 0 ? Math.min(1.15, capUsed / capLimit) : 0;
    barFill.style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
  }

  // Top contracts by AAV (within slice)
  const topAav = [...contracts]
    .sort((a, b) => b.aav - a.aav)
    .slice(0, 6);
  const topG = [...contracts]
    .sort((a, b) => b.guaranteed - a.guaranteed)
    .slice(0, 6);

  const aavList = getEl("cap-summary-top-aav");
  const gList = getEl("cap-summary-top-guarantee");
  if (aavList) {
    aavList.innerHTML = "";
    topAav.forEach((c) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span>${c.name} (${c.pos || "—"})</span>
        <span>${formatMoney(c.aav)}</span>
      `;
      aavList.appendChild(li);
    });
  }
  if (gList) {
    gList.innerHTML = "";
    topG.forEach((c) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span>${c.name} (${c.pos || "—"})</span>
        <span>${formatMoney(c.guaranteed)}</span>
      `;
      gList.appendChild(li);
    });
  }
}

function renderPlayerContext(contract) {
  const root = getEl("contracts-player-context");
  const mainLine = getEl("player-context-main-line");
  const subLine = getEl("player-context-sub-line");
  if (!root || !mainLine || !subLine || !contract) return;

  const pos = contract.pos || "UNK";
  const rankings = gPlayerRankingsByPos[pos] || [];
  const idx = rankings.findIndex(
    (r) =>
      r.playerId === contract.playerId &&
      String(r.teamCode || "").toUpperCase() ===
        String(contract.teamCode || "").toUpperCase()
  );

  let rankStr = "League data unavailable at this position.";
  if (idx >= 0) {
    const rank = idx + 1;
    const total = rankings.length || 1;
    const pct = ((total - rank + 1) / total) * 100; // high rank => high percentile
    rankStr = `#${rank} of ${total} ${pos}s by AAV (${formatPercent(pct)} percentile).`;
  }

  const aavStr = formatMoney(contract.aav);
  const gStr = formatMoney(contract.guaranteed);

  mainLine.textContent = `${contract.name} (${pos}) – ${aavStr} AAV, ${gStr} guaranteed.`;
  subLine.textContent = rankStr;

  root.hidden = false;
}

// ---------------------------------------------------------------------------
// High-level render entry point
// ---------------------------------------------------------------------------

function renderContractsView() {
  renderContractsTable();
  renderCapSummary();

  // If a focus exists but the player is no longer in the slice, clear context
  if (gFocusedPlayerKey) {
    const stillHere = gCurrentContracts.some((c) => {
      const key = `${c.teamCode || ""}|${c.playerId || c.name}`;
      return key === gFocusedPlayerKey;
    });
    if (!stillHere) {
      gFocusedPlayerKey = null;
      const ctx = getEl("contracts-player-context");
      if (ctx) ctx.hidden = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function initContractsPage() {
  const save = loadLastFranchise();
  if (!save) {
    console.warn("[Contracts] No active franchise found.");
    const tbody = getEl("contracts-table-body");
    if (tbody) {
      tbody.innerHTML = `
        <tr><td colspan="11" class="empty-state">
          No active franchise found. Return to the main menu to start or load a franchise.
        </td></tr>`;
    }
    const capRoot = getEl("contracts-cap-summary");
    const empty = getEl("contracts-empty-summary");
    if (capRoot && empty) {
      capRoot.hidden = true;
      empty.hidden = false;
    }
    const back = getEl("btn-back-hub");
    if (back) {
      back.addEventListener("click", () => {
        window.location.href = "index.html";
      });
    }
    return;
  }

  gSave = save;

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear || new Date().getFullYear()
    };
  } else {
    leagueState.seasonYear = save.seasonYear || leagueState.seasonYear;
  }

  // Ensure schedules exist so we know all team codes
  await ensureAllTeamSchedules(leagueState, leagueState.seasonYear);
  saveLeagueState(leagueState);

  // Load league (rosters) then seed contract model
  await ensureLeagueLoaded();
  gContracts = ensureContractsModel(
    leagueState,
    gLeague,
    leagueState.seasonYear
  );
  gLeagueState = leagueState;
  saveLeagueState(leagueState);

  // Build league-wide positional rankings
  buildLeagueRankings(gContracts);

  // Initial header + controls
  renderHeader();
  renderTeamSelect();
  renderSeasonTabs();
  bindViewToggleButtons();

  const backBtn = getEl("btn-back-hub");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }

  // First render
  renderContractsView();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initContractsPage);
} else {
  initContractsPage();
}
