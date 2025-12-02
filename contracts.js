// contracts_cap.js
// -----------------------------------------------------------------------------
// Franchise GM – Contracts & Cap Overview (new UI wiring)
//
// - Loads FranchiseSave + LeagueState from localStorage.
// - Loads the Layer3 league (same CSV as game day).
// - If LeagueState.contracts is missing, seeds contracts for every player on
//   every team, fitting roughly under a cap per club.
// - Renders a cap-sheet style grid for the selected team or the full league.
// - Right side: cap summary (cap limit, used, space, top AAV & guarantees).
// - Per-player pane: rank by position, base vs bonus (approx) by year.
// - Contract actions (my team only):
//   • Cut (Pre-June)
//   • Cut (Post-June)
//   • Restructure
//   • Extend +1 year
// - Logs each action into LeagueState.capMoves and shows it in "Moves log" tab.
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
// DOM & formatting helpers
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

// Try to extract a "players" array from the loaded league model
function extractPlayersArray(league) {
  if (!league) return [];
  if (Array.isArray(league.players)) return league.players;
  if (Array.isArray(league.roster)) return league.roster;
  if (Array.isArray(league.allPlayers)) return league.allPlayers;

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
  const t = (o % 10) / 10; // deterministic-ish jitter
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
        // Slightly backloaded structure
        const pct =
          0.22 + (i / Math.max(1, years - 1)) * 0.16 + 0.02 * (idx % 3);
        const capHit = Math.min(capYear * 0.18, aav * (0.9 + pct));
        const cash = aav * (0.9 + pct * 0.25);

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

    contracts.sort((a, b) => b.aav - a.aav);
    model.byTeam[teamCode] = contracts;
  }

  leagueState.contracts = model;
  return model;
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

let gSave = null;
let gLeagueState = null;
let gContracts = null;

let gSelectedTeamCode = "";
let gSelectedSeasonYear = 0;
let gViewMode = "cap"; // "cap" or "dead" (what Y1–Y3 columns show)
let gSearchTerm = "";

let gCurrentContracts = [];         // slice currently rendered in the table
let gPlayerRankingsByPos = {};      // pos -> [{ teamCode, playerId, aav, guaranteed }]
let gFocusedPlayerKey = null;       // `${teamCode}|${playerId or name}`
let gFranchiseTeamCodeUpper = "";

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
// Rendering – header + filters
// ---------------------------------------------------------------------------

function getTeamNameFromSave(save) {
  if (save.teamName) return save.teamName;
  if (save.franchiseName) return save.franchiseName;
  return getTeamDisplayName(save.teamCode || "");
}

function renderHeader() {
  if (!gSave) return;

  const titleEl = getEl("contracts-header-title");
  const subEl = getEl("contracts-header-subline");
  const recordEl = getEl("contracts-record-pill");

  if (titleEl) {
    titleEl.textContent = `${getTeamNameFromSave(gSave)} – Contracts & Cap`;
  }
  if (subEl) {
    const year = gSave.seasonYear || "";
    subEl.textContent = `${year} • Contracts & Cap Overview`;
  }
  if (recordEl) {
    recordEl.textContent = gSave.record || "0–0";
  }
}

function renderTeamSelect() {
  const select = getEl("cap-team-select");
  if (!select || !gContracts) return;

  const teamCodes = Object.keys(gContracts.byTeam || {}).sort();
  const franchiseCode = (gSave?.teamCode || "").toUpperCase();

  select.innerHTML = "";

  if (franchiseCode && teamCodes.includes(franchiseCode)) {
    const opt = document.createElement("option");
    opt.value = franchiseCode;
    opt.textContent = `${getTeamDisplayName(franchiseCode)} (My team)`;
    select.appendChild(opt);
  }

  const leagueOpt = document.createElement("option");
  leagueOpt.value = "LEAGUE_ALL";
  leagueOpt.textContent = "League – All teams";
  select.appendChild(leagueOpt);

  teamCodes.forEach((code) => {
    if (code === franchiseCode) return;
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = getTeamDisplayName(code);
    select.appendChild(opt);
  });

  gSelectedTeamCode = franchiseCode || "LEAGUE_ALL";
  select.value = gSelectedTeamCode;

  select.addEventListener("change", () => {
    gSelectedTeamCode = select.value;
    gFocusedPlayerKey = null;
    const ctx = getEl("contracts-player-context");
    if (ctx) ctx.hidden = true;
    const actions = getEl("contracts-player-actions");
    if (actions) actions.hidden = true;
    renderContractsView();
    renderMovesLog();
  });
}

function renderSeasonSelect() {
  const select = getEl("cap-season-select");
  if (!select || !gContracts) return;

  const seasons = Object.keys(gContracts.capBySeason || {})
    .map(Number)
    .sort((a, b) => a - b);

  if (!seasons.length) return;

  select.innerHTML = "";
  seasons.forEach((yr) => {
    const opt = document.createElement("option");
    opt.value = String(yr);
    opt.textContent = String(yr);
    select.appendChild(opt);
  });

  if (!gSelectedSeasonYear) {
    gSelectedSeasonYear = seasons[0];
  }
  if (!seasons.includes(gSelectedSeasonYear)) {
    gSelectedSeasonYear = seasons[0];
  }

  select.value = String(gSelectedSeasonYear);

  select.addEventListener("change", () => {
    gSelectedSeasonYear = Number(select.value);
    gFocusedPlayerKey = null;
    const ctx = getEl("contracts-player-context");
    if (ctx) ctx.hidden = true;
    const actions = getEl("contracts-player-actions");
    if (actions) actions.hidden = true;
    renderContractsView();
    renderMovesLog();
  });
}

function bindViewToggle() {
  const root = getEl("cap-view-toggle");
  if (!root) return;
  const buttons = Array.from(root.querySelectorAll("button"));

  const applyMode = (mode) => {
    // "contracts" => show cap hits; "cap" => show dead if cut
    gViewMode = mode === "cap" ? "dead" : "cap";
    buttons.forEach((btn) => {
      const m = btn.getAttribute("data-mode");
      btn.dataset.active = m === mode ? "true" : "false";
    });
    renderContractsView();
  };

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode") || "contracts";
      applyMode(mode);
    });
  });

  // Initialize
  applyMode("contracts");
}

function bindSearchInput() {
  const input = getEl("contracts-search");
  if (!input) return;
  input.addEventListener("input", () => {
    gSearchTerm = input.value || "";
    renderContractsView();
  });
}

function bindCapTabs() {
  const tabsRoot = getEl("cap-tabs");
  if (!tabsRoot) return;
  const tabs = Array.from(tabsRoot.querySelectorAll(".cap-tab"));
  const summary = getEl("contracts-cap-summary");
  const moves = getEl("cap-moves-wrapper");

  const switchTo = (tabName) => {
    tabs.forEach((t) => {
      t.dataset.active = t.getAttribute("data-tab") === tabName ? "true" : "false";
    });
    if (summary) summary.hidden = tabName !== "summary";
    if (moves) moves.hidden = tabName !== "moves";
  };

  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      const tab = t.getAttribute("data-tab") || "summary";
      switchTo(tab);
    });
  });

  switchTo("summary");
}

// ---------------------------------------------------------------------------
// Slice helpers
// ---------------------------------------------------------------------------

function getCurrentSliceContracts() {
  if (!gContracts) return [];

  let contracts = [];

  if (gSelectedTeamCode === "LEAGUE_ALL") {
    const all = [];
    for (const [teamCode, list] of Object.entries(gContracts.byTeam || {})) {
      list.forEach((c) => all.push({ ...c, teamCode }));
    }
    all.sort((a, b) => b.aav - a.aav);
    contracts = all;
  } else {
    contracts = (gContracts.byTeam[gSelectedTeamCode] || []).map((c) => ({
      ...c,
      teamCode: c.teamCode || gSelectedTeamCode
    }));
  }

  if (gSearchTerm && gSearchTerm.trim().length) {
    const q = gSearchTerm.trim().toLowerCase();
    contracts = contracts.filter((c) => {
      const name = (c.name || "").toLowerCase();
      const pos = (c.pos || "").toLowerCase();
      const tm = (getTeamDisplayName(c.teamCode || "") || "").toLowerCase();
      return (
        name.includes(q) ||
        pos.includes(q) ||
        tm.includes(q)
      );
    });
  }

  // For league view, hard cap list length to avoid huge tables
  if (gSelectedTeamCode === "LEAGUE_ALL") {
    contracts = contracts.slice(0, 200);
  }

  return contracts;
}

function findYearEntry(contract, seasonYear) {
  if (!contract || !Array.isArray(contract.schedule)) return null;
  return contract.schedule.find((y) => y.seasonYear === seasonYear) || null;
}

// ---------------------------------------------------------------------------
// Rendering – contracts table
// ---------------------------------------------------------------------------

function renderContractsSubtitle(count) {
  const el = getEl("contracts-table-subtitle");
  if (!el) return;
  const teamLabel =
    gSelectedTeamCode === "LEAGUE_ALL"
      ? "League – all teams"
      : getTeamDisplayName(gSelectedTeamCode) || gSelectedTeamCode;
  const sliceText = gSearchTerm && gSearchTerm.trim()
    ? `${count} contracts (filtered)`
    : `${count} contracts`;
  el.textContent = `${sliceText} • ${teamLabel} • ${gSelectedSeasonYear}`;
}

function renderContractsTable() {
  const tbody = getEl("contracts-table-body");
  const emptyEl = getEl("contracts-table-empty");
  if (!tbody || !gContracts) return;

  const col1 = getEl("col-cap-yr1");
  const col2 = getEl("col-cap-yr2");
  const col3 = getEl("col-cap-yr3");

  const seasons = Object.keys(gContracts.capBySeason || {})
    .map(Number)
    .sort((a, b) => a - b);

  const baselineIndex = Math.max(0, seasons.indexOf(gSelectedSeasonYear));
  const yr1 = seasons[baselineIndex] ?? seasons[0];
  const yr2 = seasons[baselineIndex + 1] ?? seasons[baselineIndex] ?? seasons[0];
  const yr3 = seasons[baselineIndex + 2] ?? seasons[baselineIndex + 1] ?? seasons[0];

  const labelSuffix = gViewMode === "dead" ? "Dead" : "Cap";

  if (col1) col1.textContent = `${yr1} ${labelSuffix}`;
  if (col2) col2.textContent = `${yr2} ${labelSuffix}`;
  if (col3) col3.textContent = `${yr3} ${labelSuffix}`;

  const contracts = getCurrentSliceContracts();
  gCurrentContracts = contracts.slice();

  tbody.innerHTML = "";

  if (!contracts.length) {
    if (emptyEl) emptyEl.hidden = false;
    renderContractsSubtitle(0);
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  renderContractsSubtitle(contracts.length);

  const pickField = (y) => {
    if (!y) return "—";
    if (gViewMode === "cap") return formatMoney(y.capHit);
    return formatMoney(y.deadIfCut);
  };

  contracts.forEach((c) => {
    const tr = document.createElement("tr");

    const key = `${(c.teamCode || "").toUpperCase()}|${c.playerId || c.name}`;
    if (gFocusedPlayerKey === key) {
      tr.dataset.selected = "true";
    }

    const y1 = findYearEntry(c, yr1);
    const y2 = findYearEntry(c, yr2);
    const y3 = findYearEntry(c, yr3);

    const nameTd = document.createElement("td");
    const teamLabel = getTeamDisplayName(c.teamCode || "") || "";
    const ovrLabel =
      c.overall != null && Number.isFinite(c.overall)
        ? ` • OVR ${c.overall}`
        : "";
    const releasedTag =
      c.releasedYear && gSelectedSeasonYear >= c.releasedYear
        ? ` • Released ${c.releasedYear}`
        : "";
    nameTd.innerHTML = `
      <div class="contracts-player-name-cell">
        <div class="contracts-player-name">${c.name}</div>
        <div class="contracts-player-meta">
          ${teamLabel}${ovrLabel}${releasedTag}
        </div>
      </div>
    `;

    const posTd = document.createElement("td");
    posTd.textContent = c.pos || "—";

    const ageTd = document.createElement("td");
    ageTd.textContent =
      c.age != null && Number.isFinite(c.age) ? String(c.age) : "—";

    const yrsTd = document.createElement("td");
    yrsTd.textContent = String(c.years);

    const aavTd = document.createElement("td");
    aavTd.textContent = formatMoney(c.aav);

    const y1Td = document.createElement("td");
    const y2Td = document.createElement("td");
    const y3Td = document.createElement("td");
    y1Td.textContent = pickField(y1);
    y2Td.textContent = pickField(y2);
    y3Td.textContent = pickField(y3);

    const gTd = document.createElement("td");
    gTd.textContent = formatMoney(c.guaranteed);

    tr.appendChild(nameTd);
    tr.appendChild(posTd);
    tr.appendChild(ageTd);
    tr.appendChild(yrsTd);
    tr.appendChild(aavTd);
    tr.appendChild(y1Td);
    tr.appendChild(y2Td);
    tr.appendChild(y3Td);
    tr.appendChild(gTd);

    tr.addEventListener("click", () => {
      gFocusedPlayerKey = key;
      renderContractsTable();
      const modelContract = getFocusedModelContract();
      if (modelContract) {
        renderPlayerContext(modelContract);
        renderPlayerActionsVisibility();
      }
    });

    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Rendering – cap summary
// ---------------------------------------------------------------------------

function renderCapSummary() {
  const root = getEl("contracts-cap-summary");
  const empty = getEl("contracts-empty-summary");
  if (!root || !gContracts) return;

  const contracts = getCurrentSliceContracts();
  if (!contracts.length) {
    if (root) root.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  root.hidden = false;
  if (empty) empty.hidden = true;

  const capLimit = gContracts.capBySeason[gSelectedSeasonYear] ?? null;

  let capUsed = 0;
  contracts.forEach((c) => {
    const yr = findYearEntry(c, gSelectedSeasonYear);
    if (yr) {
      capUsed += yr.capHit || 0;
    }
  });
  const capSpace = capLimit != null ? capLimit - capUsed : null;

  setText("cap-limit-value", formatMoney(capLimit ?? NaN));
  setText("cap-limit-sub", `League year ${gSelectedSeasonYear}`);
  setText("cap-used-value", formatMoney(capUsed));
  setText("cap-used-sub", "Active roster + dead");
  setText("cap-space-value", formatMoney(capSpace ?? NaN));
  setText(
    "cap-space-sub",
    capSpace != null && capSpace < 0 ? "Over the cap" : "Room to maneuver"
  );

  const barFill = getEl("cap-usage-bar-fill");
  const leftLabel = getEl("cap-usage-label-left");
  const rightLabel = getEl("cap-usage-label-right");

  let pct = 0;
  if (capLimit && capLimit > 0) {
    pct = capUsed / capLimit;
  }
  const pctClamped = Math.max(0, Math.min(1.15, pct));
  if (barFill) {
    barFill.style.width = `${Math.max(0, Math.min(1, pctClamped)) * 100}%`;
  }
  if (leftLabel) {
    leftLabel.textContent = `Used: ${formatMoney(capUsed)}`;
  }
  if (rightLabel) {
    rightLabel.textContent =
      capLimit && capLimit > 0 ? `${formatPercent(pct * 100)} of cap` : "—";
  }

  // Top lists
  const sliceContracts = contracts.slice();
  const topAav = sliceContracts.sort((a, b) => b.aav - a.aav).slice(0, 6);
  const topG = contracts
    .slice()
    .sort((a, b) => b.guaranteed - a.guaranteed)
    .slice(0, 6);

  const aavList = getEl("cap-top-aav-list");
  const gList = getEl("cap-top-guarantees-list");
  const pill = getEl("cap-top-filter-pill");

  if (pill) {
    pill.textContent =
      gSelectedTeamCode === "LEAGUE_ALL"
        ? "Slice: League"
        : `Slice: ${getTeamDisplayName(gSelectedTeamCode) || gSelectedTeamCode}`;
  }

  if (aavList) {
    aavList.innerHTML = "";
    topAav.forEach((c) => {
      const li = document.createElement("li");
      li.className = "cap-top-item";
      li.innerHTML = `
        <span class="cap-top-name">${c.name} (${c.pos || "—"})</span>
        <span class="cap-top-meta">${formatMoney(c.aav)} • ${getTeamDisplayName(
          c.teamCode || ""
        )}</span>
      `;
      aavList.appendChild(li);
    });
  }

  if (gList) {
    gList.innerHTML = "";
    topG.forEach((c) => {
      const li = document.createElement("li");
      li.className = "cap-top-item";
      li.innerHTML = `
        <span class="cap-top-name">${c.name} (${c.pos || "—"})</span>
        <span class="cap-top-meta">${formatMoney(
          c.guaranteed
        )} • ${getTeamDisplayName(c.teamCode || "")}</span>
      `;
      gList.appendChild(li);
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering – player context + base vs bonus
// ---------------------------------------------------------------------------

function renderBaseVsBonus(contract) {
  const container = getEl("player-base-bonus");
  const list = getEl("player-base-bonus-list");
  if (!container || !list) return;

  const schedule = contract.schedule || [];
  if (!schedule.length) {
    container.hidden = true;
    return;
  }

  const rows = schedule
    .slice()
    .sort((a, b) => a.seasonYear - b.seasonYear)
    .map((y) => {
      const cap = y.capHit || 0;
      const dead = y.deadIfCut || 0;
      const bonus = Math.max(0, Math.min(dead, cap));
      const base = Math.max(0, cap - bonus);
      const pct = cap > 0 ? (bonus / cap) * 100 : 0;
      return `
        <div class="player-base-bonus-row">
          <span>${y.seasonYear}</span>
          <span>Cap ${formatMoney(cap)}</span>
          <span>Base ${formatMoney(base)}</span>
          <span>Bonus ${formatMoney(bonus)} (${pct.toFixed(0)}% bonus)</span>
        </div>
      `;
    })
    .join("");

  list.innerHTML = rows;
  container.hidden = false;
}

function renderPlayerContext(contract) {
  const root = getEl("contracts-player-context");
  if (!root || !contract) return;

  const nameEl = getEl("cap-player-name");
  const metaEl = getEl("cap-player-meta");
  const aavEl = getEl("cap-player-aav");
  const capThisYearEl = getEl("cap-player-cap-this-year");
  const rankLineEl = getEl("cap-player-rank-line");

  if (nameEl) nameEl.textContent = contract.name;

  const yearsRemaining = (contract.schedule || []).filter(
    (y) => y.seasonYear >= gSelectedSeasonYear && (y.capHit || y.deadIfCut)
  ).length;

  if (metaEl) {
    const ageStr =
      contract.age != null && Number.isFinite(contract.age)
        ? `Age ${contract.age}`
        : "Age —";
    metaEl.textContent = `${contract.pos || "UNK"} • ${ageStr} • ${
      yearsRemaining || 0
    } yrs remaining (model)`;
  }

  if (aavEl) {
    aavEl.textContent = `${formatMoney(contract.aav)} AAV`;
  }

  const thisYear = findYearEntry(contract, gSelectedSeasonYear);
  if (capThisYearEl) {
    if (!thisYear) {
      capThisYearEl.textContent = `No cap entry in ${gSelectedSeasonYear}`;
    } else {
      capThisYearEl.textContent = `Cap hit ${gSelectedSeasonYear}: ${formatMoney(
        thisYear.capHit
      )}`;
    }
  }

  // Ranking within position by AAV (league-wide)
  const pos = contract.pos || "UNK";
  const rankings = gPlayerRankingsByPos[pos] || [];
  const idx = rankings.findIndex(
    (r) =>
      r.playerId === contract.playerId &&
      String(r.teamCode || "").toUpperCase() ===
        String(contract.teamCode || "").toUpperCase()
  );

  if (rankLineEl) {
    if (idx < 0 || !rankings.length) {
      rankLineEl.textContent =
        "League ranking data unavailable at this position.";
    } else {
      const rank = idx + 1;
      const total = rankings.length;
      const pct = ((total - rank + 1) / total) * 100; // high rank => high percentile
      rankLineEl.textContent = `#${rank} of ${total} ${pos}s by AAV (${formatPercent(
        pct
      )} percentile)`;
    }
  }

  renderBaseVsBonus(contract);
  root.hidden = false;
}

// ---------------------------------------------------------------------------
// Player actions visibility
// ---------------------------------------------------------------------------

function renderPlayerActionsVisibility(message) {
  const actionsRoot = getEl("contracts-player-actions");
  if (!actionsRoot) return;

  let noteEl = document.getElementById("player-actions-note");
  if (!noteEl) {
    noteEl = document.createElement("div");
    noteEl.id = "player-actions-note";
    noteEl.style.fontSize = "0.72rem";
    noteEl.style.color = "#9ca3af";
    noteEl.style.marginTop = "4px";
    actionsRoot.appendChild(noteEl);
  }

  const canEdit =
    gFocusedPlayerKey &&
    gSelectedTeamCode === gFranchiseTeamCodeUpper;

  if (!canEdit) {
    actionsRoot.hidden = true;
    return;
  }

  actionsRoot.hidden = false;
  noteEl.textContent =
    message ||
    "Actions apply to the selected player for the current cap year and are saved to LeagueState.";
}

// ---------------------------------------------------------------------------
// Contract actions – helpers
// ---------------------------------------------------------------------------

function getFocusedModelContract() {
  if (!gContracts || !gFocusedPlayerKey) return null;
  const [teamCode, playerId] = gFocusedPlayerKey.split("|");
  const list = gContracts.byTeam?.[teamCode];
  if (!list) return null;
  return (
    list.find((c) => (c.playerId || c.name) === playerId) || null
  );
}

// Ensure cap table has an entry for a given year
function ensureCapForYear(year) {
  if (!gContracts) return;
  if (gContracts.capBySeason[year]) return;
  const keys = Object.keys(gContracts.capBySeason)
    .map(Number)
    .sort((a, b) => a - b);
  if (!keys.length) {
    gContracts.capBySeason[year] = DEFAULT_CAP_START;
    return;
  }
  let lastYear = keys[keys.length - 1];
  let lastCap = gContracts.capBySeason[lastYear];
  while (lastYear < year) {
    lastCap = Math.round(lastCap * (1 + DEFAULT_CAP_GROWTH));
    lastYear += 1;
    gContracts.capBySeason[lastYear] = lastCap;
  }
}

// Simple cap move log entry
function recordCapMove(contract, action, message, capDeltaThisYear) {
  if (!gLeagueState) return;
  if (!Array.isArray(gLeagueState.capMoves)) {
    gLeagueState.capMoves = [];
  }

  const move = {
    timestampIso: new Date().toISOString(),
    seasonYear: gSelectedSeasonYear,
    teamCode: contract.teamCode || gSelectedTeamCode,
    playerId: contract.playerId || contract.name,
    playerName: contract.name,
    pos: contract.pos || "UNK",
    action,
    message,
    capDeltaThisYear: Number.isFinite(capDeltaThisYear)
      ? Math.round(capDeltaThisYear)
      : 0
  };

  gLeagueState.capMoves.push(move);
}

// Pre-June cut: accelerate all remaining guarantees into current year.
function applyCutPreJune(contract) {
  const schedule = contract.schedule || [];
  const idx = schedule.findIndex(
    (y) => y.seasonYear === gSelectedSeasonYear
  );
  if (idx < 0) {
    return {
      message: "No cap year for this season; pre-June cut not applied.",
      capDeltaThisYear: 0
    };
  }

  if (contract.releasedYear && gSelectedSeasonYear >= contract.releasedYear) {
    return {
      message: `Already released in ${contract.releasedYear}.`,
      capDeltaThisYear: 0
    };
  }

  const current = schedule[idx];
  const totalRemainingDead = schedule
    .slice(idx)
    .reduce((sum, y) => sum + (y.deadIfCut || 0), 0);

  const originalCapThisYear = current.capHit || 0;
  const newCapThisYear = totalRemainingDead;

  current.capHit = newCapThisYear;
  current.cash = 0;
  current.deadIfCut = totalRemainingDead;

  for (let j = idx + 1; j < schedule.length; j++) {
    schedule[j].capHit = 0;
    schedule[j].cash = 0;
    schedule[j].deadIfCut = 0;
  }

  contract.releasedYear = gSelectedSeasonYear;

  const delta = newCapThisYear - originalCapThisYear;
  const deltaStr =
    delta >= 0
      ? `cap charge increases by ${formatMoney(delta)} this year.`
      : `cap savings of ${formatMoney(-delta)} this year.`;

  return {
    message: `Pre-June cut applied in ${gSelectedSeasonYear}: ${formatMoney(
      newCapThisYear
    )} cap this season, all future years cleared; ${deltaStr}`,
    capDeltaThisYear: delta
  };
}

// Post-June cut: current year's dead-only, future guarantees pushed to next year.
function applyCutPostJune(contract) {
  const schedule = contract.schedule || [];
  const idx = schedule.findIndex(
    (y) => y.seasonYear === gSelectedSeasonYear
  );
  if (idx < 0) {
    return {
      message: "No cap year for this season; post-June cut not applied.",
      capDeltaThisYear: 0
    };
  }

  if (contract.releasedYear && gSelectedSeasonYear >= contract.releasedYear) {
    return {
      message: `Already released in ${contract.releasedYear}.`,
      capDeltaThisYear: 0
    };
  }

  const current = schedule[idx];
  const originalCapThisYear = current.capHit || 0;
  const thisYearDead = current.deadIfCut || 0;
  const futureDead = schedule
    .slice(idx + 1)
    .reduce((sum, y) => sum + (y.deadIfCut || 0), 0);

  // Current year: only this year's dead remains as cap
  current.capHit = thisYearDead;
  current.cash = 0;
  current.deadIfCut = thisYearDead;

  // Future years: zero everything, then push all futureDead into next year (if exists)
  if (idx + 1 < schedule.length) {
    for (let j = idx + 1; j < schedule.length; j++) {
      schedule[j].capHit = 0;
      schedule[j].cash = 0;
      schedule[j].deadIfCut = 0;
    }
    const next = schedule[idx + 1];
    next.capHit = futureDead;
    next.deadIfCut = futureDead;
  }

  contract.releasedYear = gSelectedSeasonYear;

  const delta = current.capHit - originalCapThisYear;
  const targetYear = schedule[idx + 1]?.seasonYear || "future";
  const deltaStr =
    delta >= 0
      ? `cap charge increases by ${formatMoney(delta)} this year.`
      : `cap savings of ${formatMoney(-delta)} this year.`;

  return {
    message: `Post-June cut applied in ${gSelectedSeasonYear}: ${formatMoney(
      current.capHit
    )} cap this season, remaining ${formatMoney(
      futureDead
    )} pushed into ${targetYear}; ${deltaStr}`,
    capDeltaThisYear: delta
  };
}

// Restructure: convert ~30% of this year's cap hit into bonus spread over remaining years
function applyRestructure(contract) {
  const schedule = contract.schedule || [];
  const idx = schedule.findIndex(
    (y) => y.seasonYear === gSelectedSeasonYear
  );
  if (idx < 0) {
    return {
      message: "No cap year for this season; restructure not applied.",
      capDeltaThisYear: 0
    };
  }

  if (contract.releasedYear && gSelectedSeasonYear >= contract.releasedYear) {
    return {
      message: "Cannot restructure a player who has already been released.",
      capDeltaThisYear: 0
    };
  }

  const current = schedule[idx];
  const remaining = schedule.slice(idx);
  if (!remaining.length) {
    return {
      message: "No remaining years to spread restructuring over.",
      capDeltaThisYear: 0
    };
  }

  const restructurable = current.capHit * 0.3; // 30% of cap hit
  if (!Number.isFinite(restructurable) || restructurable <= 0) {
    return {
      message: "No restructurable cap in this season.",
      capDeltaThisYear: 0
    };
  }

  const originalCapThisYear = current.capHit;
  const perYearBonus = restructurable / remaining.length;

  // Remove from current year, then spread as bonus across remaining
  current.capHit -= restructurable;

  remaining.forEach((y) => {
    y.capHit += perYearBonus;
    y.deadIfCut += perYearBonus;
  });

  const newCapThisYear = current.capHit;
  const savings = originalCapThisYear - newCapThisYear;

  // Guarantees effectively increase by restructurable
  contract.guaranteed += Math.round(restructurable);

  return {
    message: `Restructure applied in ${gSelectedSeasonYear}: moved ${formatMoney(
      restructurable
    )} into bonus over remaining years, saving ${formatMoney(
      savings
    )} in this season.`,
    capDeltaThisYear: newCapThisYear - originalCapThisYear
  };
}

// Extend by +1 year with a simple new year based on current AAV
function applyExtendOneYear(contract) {
  const schedule = contract.schedule || [];
  if (!schedule.length) {
    return {
      message: "No existing schedule to extend from.",
      capDeltaThisYear: 0
    };
  }

  const lastYearObj = schedule.reduce((a, b) =>
    a.seasonYear > b.seasonYear ? a : b
  );
  const newSeasonYear = lastYearObj.seasonYear + 1;

  ensureCapForYear(newSeasonYear);
  const capForNewYear = gContracts.capBySeason[newSeasonYear];

  const base =
    contract.aav || contract.totalValue / contract.years || 5_000_000;
  const capHit = Math.min(capForNewYear * 0.18, base * 0.9);
  const dead = base * 0.8;
  const cash = base * 0.95;

  const newYear = {
    seasonYear: newSeasonYear,
    capHit: Math.round(capHit),
    cash: Math.round(cash),
    deadIfCut: Math.round(dead)
  };

  schedule.push(newYear);

  contract.years += 1;
  contract.totalValue += Math.round(base);
  contract.guaranteed += Math.round(dead);
  contract.aav = Math.round(contract.totalValue / contract.years);

  return {
    message: `Extension added for ${newSeasonYear}: approx ${formatMoney(
      capHit
    )} cap hit, ${formatMoney(dead)} dead, updating AAV to ${formatMoney(
      contract.aav
    )}.`,
    capDeltaThisYear: 0
  };
}

// ---------------------------------------------------------------------------
// Contract actions – bind buttons
// ---------------------------------------------------------------------------

function bindContractActionButtons() {
  const btnPre = getEl("btn-cap-cut-pre");
  const btnPost = getEl("btn-cap-cut-post");
  const btnRestruct = getEl("btn-cap-restructure");
  const btnExtend = getEl("btn-cap-extend");

  if (btnPre) {
    btnPre.addEventListener("click", () => {
      if (gSelectedTeamCode !== gFranchiseTeamCodeUpper) return;
      const c = getFocusedModelContract();
      if (!c) return;
      const { message, capDeltaThisYear } = applyCutPreJune(c);
      recordCapMove(c, "CUT_PRE", message, capDeltaThisYear);
      buildLeagueRankings(gContracts);
      saveLeagueState(gLeagueState);
      renderContractsView();
      renderPlayerContext(c);
      renderPlayerActionsVisibility(message);
      renderMovesLog();
    });
  }

  if (btnPost) {
    btnPost.addEventListener("click", () => {
      if (gSelectedTeamCode !== gFranchiseTeamCodeUpper) return;
      const c = getFocusedModelContract();
      if (!c) return;
      const { message, capDeltaThisYear } = applyCutPostJune(c);
      recordCapMove(c, "CUT_POST", message, capDeltaThisYear);
      buildLeagueRankings(gContracts);
      saveLeagueState(gLeagueState);
      renderContractsView();
      renderPlayerContext(c);
      renderPlayerActionsVisibility(message);
      renderMovesLog();
    });
  }

  if (btnRestruct) {
    btnRestruct.addEventListener("click", () => {
      if (gSelectedTeamCode !== gFranchiseTeamCodeUpper) return;
      const c = getFocusedModelContract();
      if (!c) return;
      const { message, capDeltaThisYear } = applyRestructure(c);
      recordCapMove(c, "RESTRUCTURE", message, capDeltaThisYear);
      buildLeagueRankings(gContracts);
      saveLeagueState(gLeagueState);
      renderContractsView();
      renderPlayerContext(c);
      renderPlayerActionsVisibility(message);
      renderMovesLog();
    });
  }

  if (btnExtend) {
    btnExtend.addEventListener("click", () => {
      if (gSelectedTeamCode !== gFranchiseTeamCodeUpper) return;
      const c = getFocusedModelContract();
      if (!c) return;
      const { message, capDeltaThisYear } = applyExtendOneYear(c);
      recordCapMove(c, "EXTEND", message, capDeltaThisYear);
      buildLeagueRankings(gContracts);
      saveLeagueState(gLeagueState);
      renderContractsView();
      renderPlayerContext(c);
      renderPlayerActionsVisibility(message);
      renderMovesLog();
    });
  }
}

// ---------------------------------------------------------------------------
// Moves log rendering
// ---------------------------------------------------------------------------

function renderMovesLog() {
  const listEl = getEl("cap-moves-list");
  if (!listEl || !gLeagueState) return;

  const moves = Array.isArray(gLeagueState.capMoves)
    ? gLeagueState.capMoves.slice()
    : [];

  const filtered = moves
    .filter((m) => {
      if (m.seasonYear !== gSelectedSeasonYear) return false;
      if (gSelectedTeamCode === "LEAGUE_ALL") return true;
      return (m.teamCode || "").toUpperCase() === gSelectedTeamCode;
    })
    .sort((a, b) => {
      const ta = a.timestampIso || "";
      const tb = b.timestampIso || "";
      return tb.localeCompare(ta);
    });

  if (!filtered.length) {
    listEl.innerHTML =
      '<div class="empty-state">No cap moves recorded yet for this slice.</div>';
    return;
  }

  const rows = filtered
    .map((m) => {
      const d = m.timestampIso ? new Date(m.timestampIso) : null;
      const dateStr = d && !isNaN(d.getTime())
        ? d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric"
          })
        : "—";
      const teamCode = (m.teamCode || "").toUpperCase();
      const isFranchise = teamCode === gFranchiseTeamCodeUpper;
      const delta = m.capDeltaThisYear || 0;
      const deltaLabel =
        delta === 0
          ? "No immediate cap change."
          : `${delta > 0 ? "Cap charge +" : "Cap savings"} ${formatMoney(
              Math.abs(delta)
            )} this year.`;

      return `
        <div class="cap-move-row" data-franchise="${isFranchise ? "true" : "false"}">
          <div class="cap-move-main">
            <span class="cap-move-time">${dateStr}</span>
            <span class="cap-move-team">${teamCode}</span>
            <span class="cap-move-player">${
              m.playerName || "Unknown player"
            }</span>
          </div>
          <div class="cap-move-desc">
            <span class="cap-move-action">${m.action || "MOVE"}</span>
            <span>${m.message || ""}</span>
          </div>
          <div class="cap-move-capline">${deltaLabel}</div>
        </div>
      `;
    })
    .join("");

  listEl.innerHTML = rows;
}

// ---------------------------------------------------------------------------
// High-level render entry point
// ---------------------------------------------------------------------------

function renderContractsView() {
  renderContractsTable();
  renderCapSummary();

  if (gFocusedPlayerKey) {
    const stillHere = gCurrentContracts.some((c) => {
      const key = `${(c.teamCode || "").toUpperCase()}|${
        c.playerId || c.name
      }`;
      return key === gFocusedPlayerKey;
    });
    if (!stillHere) {
      gFocusedPlayerKey = null;
      const ctx = getEl("contracts-player-context");
      if (ctx) ctx.hidden = true;
      const actions = getEl("contracts-player-actions");
      if (actions) actions.hidden = true;
    } else {
      const c = getFocusedModelContract();
      if (c) {
        renderPlayerContext(c);
        renderPlayerActionsVisibility();
      }
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
    const emptyEl = getEl("contracts-table-empty");
    if (tbody) tbody.innerHTML = "";
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent =
        "No active franchise found. Return to the main menu to start or load a franchise.";
    }
    const capRoot = getEl("contracts-cap-summary");
    const empty = getEl("contracts-empty-summary");
    if (capRoot && empty) {
      capRoot.hidden = true;
      empty.hidden = false;
    }
    return;
  }

  gSave = save;
  gFranchiseTeamCodeUpper = (save.teamCode || "").toUpperCase();

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear || new Date().getFullYear()
    };
  } else {
    leagueState.seasonYear = save.seasonYear || leagueState.seasonYear;
  }

  // Make sure the league has schedules for all teams this season
  await ensureAllTeamSchedules(leagueState, leagueState.seasonYear);
  leagueState.capMoves = leagueState.capMoves || [];
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

  // Initial UI wiring
  renderHeader();
  renderTeamSelect();
  renderSeasonSelect();
  bindViewToggle();
  bindSearchInput();
  bindCapTabs();
  bindContractActionButtons();

  // First render
  renderContractsView();
  renderMovesLog();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initContractsPage);
} else {
  initContractsPage();
}
