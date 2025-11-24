// team.js
//
// Franchise GM – Team View & Depth Chart
//
// This page shows the current team's roster and depth chart, and allows the
// GM to assign starters / backups / special teams roles without exposing
// numeric ratings.
//
// It uses the same FranchiseSave + LeagueState storage pattern as
// franchise.js and schedule.js:
//
// - FranchiseSave summary:  localStorage["franchiseGM_lastFranchise"]
// - LeagueState per franchise: localStorage["franchiseGM_leagueState_<id>"]
//
// New fields on LeagueState used here:
//
//   leagueState.teamRosters:     { [teamCode: string]: Player[] }
//   leagueState.teamDepthCharts: { [teamCode: string]: TeamDepthChart }
//   leagueState.depthChartMeta:  { lockedForCurrentWeek?: boolean }
//
// This file is intentionally conservative: roster-building and depth chart
// seeding are stubbed and should be wired into the real engine later.

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
 * @property {number} accolades.seasons
 * @property {number} accolades.playoffAppearances
 * @property {number} accolades.divisionTitles
 * @property {number} accolades.championships
 *
 * @property {Object} gmJob
 * @property {number} gmJob.contractYears
 * @property {number} gmJob.currentYear
 * @property {number} gmJob.salaryPerYearMillions
 * @property {number} gmJob.contractTotalMillions
 * @property {string} gmJob.status
 * @property {number} gmJob.ageYears
 * @property {number} gmJob.birthYear
 *
 * @property {Object} leagueSummary
 * @property {number} leagueSummary.teams
 * @property {number} leagueSummary.seasonsSimmed
 *
 * @property {Object} realismOptions
 * @property {boolean} realismOptions.injuriesOn
 * @property {string} realismOptions.capMode
 * @property {string} realismOptions.difficulty
 * @property {boolean} realismOptions.ironman
 *
 * @property {Object} ownerExpectation
 * @property {string} ownerExpectation.patience
 * @property {number} ownerExpectation.targetYear
 * @property {number} ownerExpectation.baselineWins
 *
 * @property {number} gmCredibility
 */

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} teamCode
 * @property {string} firstName
 * @property {string} lastName
 * @property {number|null} jerseyNumber
 * @property {string} position
 * @property {"offense"|"defense"|"special"} sideOfBall
 * @property {string} [status]    // "healthy" | "questionable" | "out" | "ir" | ...
 * @property {string} [notes]
 */

/**
 * Up to three depth chart slots per position: [starter, 2nd, 3rd].
 * Values are Player IDs or null-ish.
 *
 * @typedef {Object} DepthChartOffense
 * @property {Array<string|null>} QB
 * @property {Array<string|null>} RB
 * @property {Array<string|null>} FB
 * @property {Array<string|null>} WR
 * @property {Array<string|null>} TE
 * @property {Array<string|null>} LT
 * @property {Array<string|null>} LG
 * @property {Array<string|null>} C
 * @property {Array<string|null>} RG
 * @property {Array<string|null>} RT
 */

/**
 * @typedef {Object} DepthChartDefense
 * @property {Array<string|null>} DT
 * @property {Array<string|null>} EDGE
 * @property {Array<string|null>} LB
 * @property {Array<string|null>} CB
 * @property {Array<string|null>} S
 */

/**
 * @typedef {Object} DepthChartSpecial
 * @property {Array<string|null>} K
 * @property {Array<string|null>} P
 * @property {Array<string|null>} KR
 * @property {Array<string|null>} PR
 * @property {Array<string|null>} LS
 */

/**
 * @typedef {Object} TeamDepthChart
 * @property {DepthChartOffense} offense
 * @property {DepthChartDefense} defense
 * @property {DepthChartSpecial} special
 */

/**
 * @typedef {Object} DepthChartMeta
 * @property {boolean} [lockedForCurrentWeek]
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
 *
 * @property {Object<string, Player[]>} [teamRosters]
 * @property {Object<string, TeamDepthChart>} [teamDepthCharts]
 * @property {DepthChartMeta} [depthChartMeta]
 */

// ---------------------------------------------------------------------------
// Constants / storage keys
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

// Positions by side of ball
const OFFENSE_POSITIONS = ["QB", "RB", "FB", "WR", "TE", "LT", "LG", "C", "RG", "RT"];
const DEFENSE_POSITIONS = ["DT", "EDGE", "LB", "CB", "S"];
const SPECIAL_POSITIONS = ["K", "P", "KR", "PR", "LS"];

const ALL_POSITIONS = [
  ...OFFENSE_POSITIONS,
  ...DEFENSE_POSITIONS,
  ...SPECIAL_POSITIONS
];

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

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

/** @returns {FranchiseSave|null} */
function loadLastFranchise() {
  if (!storageAvailable()) return null;
  const raw = window.localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    console.warn("[Franchise GM] Failed to parse FranchiseSave.");
    return null;
  }
}

/** @returns {LeagueState|null} */
function loadLeagueState(franchiseId) {
  if (!storageAvailable() || !franchiseId) return null;
  const raw = window.localStorage.getItem(getLeagueStateKey(franchiseId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    console.warn("[Franchise GM] Failed to parse LeagueState.");
    return null;
  }
}

/** @param {LeagueState} state */
function saveLeagueState(state) {
  if (!storageAvailable() || !state || !state.franchiseId) return;
  try {
    window.localStorage.setItem(
      getLeagueStateKey(state.franchiseId),
      JSON.stringify(state)
    );
  } catch (err) {
    console.warn("[Franchise GM] Failed to save LeagueState:", err);
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

/** @param {FranchiseSave} save */
function getTeamDisplayName(save) {
  if (save.teamName && typeof save.teamName === "string") {
    return save.teamName;
  }
  if (save.franchiseName && typeof save.franchiseName === "string") {
    return save.franchiseName;
  }
  if (save.teamCode) return save.teamCode;
  return "Franchise Team";
}

/** @param {FranchiseSave} save */
function formatHeaderSubline(save) {
  const season = save.seasonYear ? `Season ${save.seasonYear}` : "Season";
  const phase = save.phase || "";
  const weekIndex = typeof save.weekIndex === "number" ? save.weekIndex : null;
  const weekLabel =
    weekIndex !== null && Number.isFinite(weekIndex)
      ? `Week ${weekIndex + 1}`
      : "";
  if (phase && weekLabel) {
    return `${season} • ${phase} • ${weekLabel}`;
  }
  if (phase) return `${season} • ${phase}`;
  return season;
}

function formatRecord(record) {
  const str = (record || "").trim();
  if (!str) return "0–0";
  return str.replace("-", "–");
}

function formatPlayerDisplayName(player) {
  const num = player.jerseyNumber != null ? `#${player.jerseyNumber} ` : "";
  const lastInitial = player.lastName ? player.lastName : "";
  const firstInitial = player.firstName ? player.firstName.charAt(0) + "." : "";
  return `${num}${firstInitial} ${lastInitial}`.trim();
}

function formatStatusLabel(status) {
  const s = (status || "healthy").toLowerCase();
  if (s === "healthy") return "Healthy";
  if (s === "questionable") return "Questionable";
  if (s === "doubtful") return "Doubtful";
  if (s === "out") return "Out";
  if (s === "ir") return "Injured reserve";
  if (s === "ps") return "Practice squad";
  if (s === "suspended") return "Suspended";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isPlayerUnavailable(player) {
  const s = (player.status || "healthy").toLowerCase();
  return s === "out" || s === "ir" || s === "suspended";
}

function slotLabelFromIndex(index) {
  if (index === 0) return "Starter";
  if (index === 1) return "2nd";
  if (index === 2) return "3rd";
  return `#${index + 1}`;
}

function sideLabel(side) {
  if (side === "offense") return "Offense";
  if (side === "defense") return "Defense";
  return "Special Teams";
}

// ---------------------------------------------------------------------------
// Eligibility mapping
// ---------------------------------------------------------------------------

/**
 * Return eligibility for assigning a player to a given position.
 * allowed: false means we don't show them at all.
 * needsConfirm: true means show a "this is risky" confirmation.
 *
 * @param {Player} player
 * @param {string} slotPosition
 * @returns {{allowed: boolean, needsConfirm: boolean}}
 */
function isPlayerEligibleForSlot(player, slotPosition) {
  const pos = player.position;
  if (!pos || !slotPosition) {
    return { allowed: false, needsConfirm: false };
  }

  /** @type {Record<string, {natural: string[], flex: string[]}>} */
  const map = {
    QB: { natural: ["QB"], flex: [] },
    RB: { natural: ["RB"], flex: ["FB"] },
    FB: { natural: ["FB"], flex: ["RB", "TE"] },
    WR: { natural: ["WR"], flex: ["RB"] },
    TE: { natural: ["TE"], flex: ["FB", "WR"] },

    LT: { natural: ["LT"], flex: ["LG"] },
    LG: { natural: ["LG"], flex: ["LT", "C"] },
    C:  { natural: ["C"],  flex: ["LG", "RG"] },
    RG: { natural: ["RG"], flex: ["C", "RT"] },
    RT: { natural: ["RT"], flex: ["RG"] },

    DT:   { natural: ["DT"],   flex: ["EDGE"] },
    EDGE: { natural: ["EDGE"], flex: ["DT", "LB"] },
    LB:   { natural: ["LB"],   flex: ["EDGE", "S"] },
    CB:   { natural: ["CB"],   flex: ["S"] },
    S:    { natural: ["S"],    flex: ["CB"] },

    K:  { natural: ["K"], flex: [] },
    P:  { natural: ["P"], flex: [] },
    KR: { natural: ["WR", "RB"], flex: ["CB", "S"] },
    PR: { natural: ["WR", "RB"], flex: ["CB", "S"] },
    LS: { natural: ["C", "TE"], flex: ["LB"] }
  };

  const entry = map[slotPosition];
  if (!entry) {
    return { allowed: true, needsConfirm: true };
  }

  if (entry.natural.includes(pos)) {
    return { allowed: true, needsConfirm: false };
  }
  if (entry.flex.includes(pos)) {
    return { allowed: true, needsConfirm: true };
  }

  // Out-of-family positions are still technically allowed but high-risk.
  return { allowed: true, needsConfirm: true };
}

// ---------------------------------------------------------------------------
// League state helpers for roster & depth chart
// ---------------------------------------------------------------------------

/**
 * Build a default LeagueState-like shell if missing.
 * We only touch roster/depth-chart-related fields here.
 *
 * @param {FranchiseSave} save
 * @param {LeagueState|null} existing
 * @returns {LeagueState}
 */
function ensureLeagueStateForTeam(save, existing) {
  const state = existing || {
    franchiseId: save.franchiseId,
    seasonYear: save.seasonYear
  };

  if (!state.teamRosters) state.teamRosters = {};
  if (!state.teamDepthCharts) state.teamDepthCharts = {};
  if (!state.depthChartMeta) state.depthChartMeta = {};

  const teamCode = save.teamCode;

  if (!state.teamRosters[teamCode]) {
    state.teamRosters[teamCode] = buildInitialRosterForTeam(teamCode);
  }

  if (!state.teamDepthCharts[teamCode]) {
    const players = state.teamRosters[teamCode];
    state.teamDepthCharts[teamCode] = buildInitialDepthChartForTeam(players);
  }

  return state;
}

/**
 * Stubbed roster builder. In the real project this should be wired to
 * the roster & engine data (e.g., layer3_rosters/game_engine).
 *
 * @param {string} teamCode
 * @returns {Player[]}
 */
function buildInitialRosterForTeam(teamCode) {
  console.warn(
    "[Franchise GM] buildInitialRosterForTeam is using stub data. " +
      "Wire this into your real roster source."
  );

  // Minimal, fake roster just so the page is useful during UI dev.
  // You can replace this entire function with real roster loading.
  const mk = (suffix, first, last, pos, side, num) => ({
    id: `${teamCode}-${pos}-${suffix}`,
    teamCode,
    firstName: first,
    lastName: last,
    jerseyNumber: num,
    position: pos,
    sideOfBall: side,
    status: "healthy",
    notes: ""
  });

  return [
    mk("QB1", "Marcus", "Banks", "QB", "offense", 12),
    mk("QB2", "Tyler", "Hodge", "QB", "offense", 8),
    mk("RB1", "Kendrick", "Hall", "RB", "offense", 25),
    mk("WR1", "Jalen", "Cole", "WR", "offense", 11),
    mk("WR2", "Darius", "Young", "WR", "offense", 13),
    mk("TE1", "Logan", "Price", "TE", "offense", 86),
    mk("LT1", "Evan", "Sloan", "LT", "offense", 71),
    mk("LG1", "Connor", "Reed", "LG", "offense", 67),
    mk("C1", "Noah", "Fields", "C", "offense", 60),
    mk("RG1", "Isaiah", "Clark", "RG", "offense", 64),
    mk("RT1", "Mason", "Brooks", "RT", "offense", 72),

    mk("DT1", "Jordan", "Steele", "DT", "defense", 94),
    mk("EDGE1", "Rashad", "King", "EDGE", "defense", 91),
    mk("LB1", "Cole", "Mitchell", "LB", "defense", 52),
    mk("CB1", "Aaron", "Wells", "CB", "defense", 23),
    mk("S1", "Brandon", "Lewis", "S", "defense", 32),

    mk("K1", "Elliot", "James", "K", "special", 3),
    mk("P1", "Ryan", "Foster", "P", "special", 6),
    mk("KR1", "Myles", "Patton", "WR", "offense", 16),
    mk("LS1", "Grant", "Hughes", "C", "offense", 61)
  ];
}

/**
 * Build an initial depth chart from a roster.
 *
 * @param {Player[]} players
 * @returns {TeamDepthChart}
 */
function buildInitialDepthChartForTeam(players) {
  /** @type {TeamDepthChart} */
  const chart = {
    offense: {
      QB: [null, null, null],
      RB: [null, null, null],
      FB: [null, null, null],
      WR: [null, null, null],
      TE: [null, null, null],
      LT: [null, null, null],
      LG: [null, null, null],
      C: [null, null, null],
      RG: [null, null, null],
      RT: [null, null, null]
    },
    defense: {
      DT: [null, null, null],
      EDGE: [null, null, null],
      LB: [null, null, null],
      CB: [null, null, null],
      S: [null, null, null]
    },
    special: {
      K: [null, null, null],
      P: [null, null, null],
      KR: [null, null, null],
      PR: [null, null, null],
      LS: [null, null, null]
    }
  };

  // Fill each position with up to 3 players, in roster order.
  const byPos = {};
  for (const p of players) {
    if (!byPos[p.position]) byPos[p.position] = [];
    byPos[p.position].push(p);
  }

  function seed(posList, sideKey) {
    for (const pos of posList) {
      const arr = chart[sideKey][pos];
      const pool = byPos[pos] || [];
      for (let i = 0; i < arr.length && i < pool.length; i++) {
        arr[i] = pool[i].id;
      }
    }
  }

  seed(OFFENSE_POSITIONS, "offense");
  seed(DEFENSE_POSITIONS, "defense");
  seed(SPECIAL_POSITIONS, "special");

  return chart;
}

/**
 * @param {LeagueState} leagueState
 * @param {string} teamCode
 * @returns {Player[]}
 */
function getTeamPlayers(leagueState, teamCode) {
  if (!leagueState.teamRosters) return [];
  return leagueState.teamRosters[teamCode] || [];
}

/**
 * @param {LeagueState} leagueState
 * @param {string} teamCode
 * @returns {TeamDepthChart|null}
 */
function getTeamDepthChart(leagueState, teamCode) {
  if (!leagueState.teamDepthCharts) return null;
  return leagueState.teamDepthCharts[teamCode] || null;
}

/**
 * Ensure an array has length >= n, pad with null.
 * @param {Array<any>} arr
 * @param {number} n
 */
function ensureLength(arr, n) {
  while (arr.length < n) arr.push(null);
}

/**
 * Set a depth chart slot (auto-saves).
 *
 * @param {LeagueState} leagueState
 * @param {string} teamCode
 * @param {"offense"|"defense"|"special"} side
 * @param {string} position
 * @param {number} slotIndex
 * @param {string|null} playerId
 */
function setDepthChartSlot(leagueState, teamCode, side, position, slotIndex, playerId) {
  const chart = getTeamDepthChart(leagueState, teamCode);
  if (!chart) return;

  const group = chart[side];
  if (!group || !group[position]) return;

  // Remove this player from all slots of this position on this side
  if (playerId) {
    const posKeys = Object.keys(group);
    for (const pos of posKeys) {
      const arr = group[pos];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === playerId && (pos !== position || i !== slotIndex)) {
          arr[i] = null;
        }
      }
    }
  }

  const slots = group[position];
  ensureLength(slots, slotIndex + 1);
  slots[slotIndex] = playerId || null;

  // Persist
  if (!leagueState.teamDepthCharts) leagueState.teamDepthCharts = {};
  leagueState.teamDepthCharts[teamCode] = chart;
  saveLeagueState(leagueState);
}

// ---------------------------------------------------------------------------
// Depth chart health & usage
// ---------------------------------------------------------------------------

/**
 * Build a usage map: which players are starters / backups where.
 *
 * @param {TeamDepthChart} chart
 * @returns {Record<string, {roles: Array<{side:string, position:string, slotIndex:number}>}>}
 */
function buildUsageMap(chart) {
  const usage = {};

  function addRole(sideKey, positions) {
    for (const pos of positions) {
      const arr = chart[sideKey][pos] || [];
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i];
        if (!id) continue;
        if (!usage[id]) usage[id] = { roles: [] };
        usage[id].roles.push({ side: sideKey, position: pos, slotIndex: i });
      }
    }
  }

  addRole("offense", OFFENSE_POSITIONS);
  addRole("defense", DEFENSE_POSITIONS);
  addRole("special", SPECIAL_POSITIONS);

  return usage;
}

/**
 * Compute simple health summary: missing starters and empty slots.
 *
 * @param {TeamDepthChart} chart
 * @returns {{missingStarters: number, emptySlots: number}}
 */
function computeDepthChartHealth(chart) {
  let missingStarters = 0;
  let emptySlots = 0;

  function countPositions(sideKey, positions) {
    for (const pos of positions) {
      const arr = chart[sideKey][pos] || [];
      if (!arr[0]) missingStarters++;
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i]) emptySlots++;
      }
    }
  }

  countPositions("offense", OFFENSE_POSITIONS);
  countPositions("defense", DEFENSE_POSITIONS);
  countPositions("special", SPECIAL_POSITIONS);

  return { missingStarters, emptySlots };
}

// ---------------------------------------------------------------------------
// Global state for this page
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;

/** @type {"offense"|"defense"|"special"} */
let currentSide = "offense";

/** @type {string|null} */
let highlightedPlayerId = null;

/** Is depth chart locked for current week? */
let isLockedForWeek = false;

/**
 * Current slot being edited in assign modal.
 * @type {{side:"offense"|"defense"|"special", position:string, slotIndex:number}|null}
 */
let currentAssignContext = null;

// ---------------------------------------------------------------------------
// Render: header & banners
// ---------------------------------------------------------------------------

/** @param {FranchiseSave} save */
function renderHeader(save) {
  const nameEl = getEl("team-header-name");
  const seasonLineEl = getEl("team-header-season-line");
  const recordValueEl = getEl("team-header-record-value");

  if (nameEl) nameEl.textContent = getTeamDisplayName(save);
  if (seasonLineEl) seasonLineEl.textContent = formatHeaderSubline(save);
  if (recordValueEl) recordValueEl.textContent = formatRecord(save.record);
}

/**
 * @param {FranchiseSave} save
 * @param {LeagueState} leagueState
 */
function renderStatusBanners(save, leagueState) {
  const healthBanner = getEl("depthchart-health-banner");
  const healthTextEl = getEl("depthchart-health-text");
  const lockBanner = getEl("depthchart-lock-banner");

  const chart = getTeamDepthChart(leagueState, save.teamCode);
  if (chart && healthBanner && healthTextEl) {
    const health = computeDepthChartHealth(chart);
    if (health.missingStarters === 0) {
      healthTextEl.textContent =
        "Depth chart complete — all positions have a named starter.";
    } else {
      healthTextEl.textContent =
        `Depth chart incomplete — ${health.missingStarters} ` +
        `position${health.missingStarters === 1 ? "" : "s"} missing a starter.`;
    }
    healthBanner.hidden = false;
  } else if (healthBanner) {
    healthBanner.hidden = true;
  }

  isLockedForWeek =
    !!leagueState.depthChartMeta &&
    !!leagueState.depthChartMeta.lockedForCurrentWeek;

  if (lockBanner) {
    lockBanner.hidden = !isLockedForWeek;
  }
}

// ---------------------------------------------------------------------------
// Render: depth chart
// ---------------------------------------------------------------------------

/**
 * @param {FranchiseSave} save
 * @param {LeagueState} leagueState
 */
function renderDepthChart(save, leagueState) {
  const rowsContainer = getEl("depthchart-rows");
  const subtitleEl = getEl("depthchart-subtitle");
  if (!rowsContainer) return;

  const chart = getTeamDepthChart(leagueState, save.teamCode);
  const players = getTeamPlayers(leagueState, save.teamCode);
  const playersById = {};
  for (const p of players) playersById[p.id] = p;

  rowsContainer.innerHTML = "";

  const usageMap = chart ? buildUsageMap(chart) : {};

  let positions;
  if (currentSide === "offense") {
    positions = OFFENSE_POSITIONS;
  } else if (currentSide === "defense") {
    positions = DEFENSE_POSITIONS;
  } else {
    positions = SPECIAL_POSITIONS;
  }

  if (subtitleEl) {
    subtitleEl.textContent = `${sideLabel(currentSide)} • Starters & backups`;
  }

  if (!chart) {
    const msg = document.createElement("div");
    msg.textContent = "Depth chart not available for this team yet.";
    msg.className = "card-subtitle";
    rowsContainer.appendChild(msg);
    return;
  }

  positions.forEach((pos) => {
    const row = document.createElement("div");
    row.className = "depth-row";
    row.setAttribute("data-position", pos);

    const label = document.createElement("div");
    label.className = "depth-row-label";
    label.textContent = pos;

    const slotsContainer = document.createElement("div");
    slotsContainer.className = "depth-row-slots";

    const sideChart = chart[currentSide];
    const slotArr = sideChart[pos] || [null, null, null];

    for (let i = 0; i < 3; i++) {
      const playerId = slotArr[i] || null;
      const player = playerId ? playersById[playerId] : null;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "depth-slot";
      if (i === 0) btn.classList.add("depth-slot--starter");
      if (!player) btn.classList.add("depth-slot--empty");

      if (isLockedForWeek) {
        btn.classList.add("depth-slot--locked");
      }

      btn.setAttribute("data-side", currentSide);
      btn.setAttribute("data-position", pos);
      btn.setAttribute("data-slot-index", String(i));
      if (playerId) btn.setAttribute("data-player-id", playerId);

      const main = document.createElement("div");
      main.className = "depth-slot-main";

      const labelSpan = document.createElement("div");
      labelSpan.className = "depth-slot-label";
      labelSpan.textContent = slotLabelFromIndex(i);

      const nameSpan = document.createElement("div");
      nameSpan.className = "depth-slot-player";
      nameSpan.textContent = player ? formatPlayerDisplayName(player) : "Empty";

      main.appendChild(labelSpan);
      main.appendChild(nameSpan);

      const tagsSpan = document.createElement("div");
      tagsSpan.className = "depth-slot-tags";

      if (player) {
        const usage = usageMap[player.id];
        let primaryRole = "";
        if (usage && usage.roles && usage.roles.length) {
          const starterRole = usage.roles.find((r) => r.slotIndex === 0);
          const anyRole = starterRole || usage.roles[0];
          const roleLabel =
            anyRole.slotIndex === 0 ? "Starter" : `Depth (${anyRole.position})`;
          primaryRole = roleLabel;
        }
        const statusLabel = formatStatusLabel(player.status);
        tagsSpan.textContent = `${player.position}${primaryRole ? " • " + primaryRole : ""} • ${statusLabel}`;
      } else {
        tagsSpan.textContent = "";
      }

      if (highlightedPlayerId && playerId === highlightedPlayerId) {
        btn.classList.add("depth-slot--highlight");
      }

      btn.appendChild(main);
      if (tagsSpan.textContent) {
        btn.appendChild(tagsSpan);
      }

      btn.addEventListener("click", onDepthSlotClick);

      slotsContainer.appendChild(btn);
    }

    row.appendChild(label);
    row.appendChild(slotsContainer);
    rowsContainer.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Render: roster
// ---------------------------------------------------------------------------

let rosterFilterSide = "all";     // "all"|"offense"|"defense"|"special"
let rosterFilterPosition = "all"; // position code or "all"
let rosterSearchQuery = "";

/**
 * @param {FranchiseSave} save
 * @param {LeagueState} leagueState
 */
function renderRoster(save, leagueState) {
  const listEl = getEl("roster-list");
  const subtitleEl = getEl("roster-subtitle");
  if (!listEl) return;

  const players = getTeamPlayers(leagueState, save.teamCode);
  const chart = getTeamDepthChart(leagueState, save.teamCode);

  listEl.innerHTML = "";

  if (!players.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "Roster data not available yet.";
    listEl.appendChild(empty);
    return;
  }

  if (subtitleEl) {
    subtitleEl.textContent = `${players.length} players under contract`;
  }

  const usageMap = chart ? buildUsageMap(chart) : {};

  const q = rosterSearchQuery.trim().toLowerCase();

  const filtered = players.filter((p) => {
    if (rosterFilterSide !== "all" && p.sideOfBall !== rosterFilterSide) {
      return false;
    }
    if (rosterFilterPosition !== "all" && p.position !== rosterFilterPosition) {
      return false;
    }
    if (q) {
      const name = `${p.firstName} ${p.lastName}`.toLowerCase();
      if (!name.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "No players match the current filters.";
    listEl.appendChild(empty);
    return;
  }

  filtered.forEach((p) => {
    const row = document.createElement("div");
    row.className = "roster-player-row";
    row.setAttribute("data-player-id", p.id);

    if (highlightedPlayerId === p.id) {
      row.classList.add("roster-player-row--highlight");
    }

    const main = document.createElement("div");
    main.className = "roster-player-main";

    const nameSpan = document.createElement("div");
    nameSpan.className = "roster-player-name";
    nameSpan.textContent = formatPlayerDisplayName(p);

    const metaSpan = document.createElement("div");
    metaSpan.className = "roster-player-meta";

    const usage = usageMap[p.id];
    let usageText = "Unassigned";
    if (usage && usage.roles && usage.roles.length) {
      const starterRole = usage.roles.find((r) => r.slotIndex === 0);
      if (starterRole) {
        usageText = `Starter (${starterRole.position})`;
      } else if (usage.roles.length === 1) {
        usageText = `Depth (${usage.roles[0].position})`;
      } else {
        usageText = "Multiple roles";
      }
    }

    metaSpan.textContent = `${p.position} • ${usageText}`;

    main.appendChild(nameSpan);
    main.appendChild(metaSpan);

    const statusPill = document.createElement("div");
    const statusLabel = formatStatusLabel(p.status);
    statusPill.className = "roster-player-status-pill";
    const unavailable = isPlayerUnavailable(p);
    if (unavailable) {
      statusPill.classList.add("roster-player-status-pill--injured");
    }
    statusPill.textContent = statusLabel;

    row.appendChild(main);
    row.appendChild(statusPill);

    row.addEventListener("click", () => {
      highlightedPlayerId = p.id;
      // Re-render to update highlights.
      if (currentFranchiseSave && currentLeagueState) {
        renderDepthChart(currentFranchiseSave, currentLeagueState);
        renderRoster(currentFranchiseSave, currentLeagueState);
      }
    });

    listEl.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Render: notes card
// ---------------------------------------------------------------------------

/**
 * @param {FranchiseSave} save
 * @param {LeagueState} leagueState
 */
function renderNotesCard(save, leagueState) {
  const bodyEl = getEl("notes-card-body");
  if (!bodyEl) return;

  const baselineWins =
    save.ownerExpectation?.baselineWins || 9;
  const targetYear =
    save.ownerExpectation?.targetYear || (save.seasonYear || 0) + 2;
  const patience =
    save.ownerExpectation?.patience || "average";

  bodyEl.innerHTML = "";

  const p1 = document.createElement("p");
  p1.textContent =
    `Staff summary: baseline expectation is around ${baselineWins} wins ` +
    `by ${targetYear}. Patience level is tagged as "${patience}".`;

  const p2 = document.createElement("p");
  p2.textContent =
    "Use this space to keep your own notes on lineup decisions, " +
    "position battles, and special teams roles. A future version will let " +
    "you edit and persist custom notes here.";

  const p3 = document.createElement("p");
  p3.textContent =
    "Depth chart changes are saved immediately and will be used by the game " +
    "engine when simulating your next matchup.";

  bodyEl.appendChild(p1);
  bodyEl.appendChild(p2);
  bodyEl.appendChild(p3);
}

// ---------------------------------------------------------------------------
// Depth chart interactions
// ---------------------------------------------------------------------------

function onDepthSlotClick(event) {
  const btn = event.currentTarget;
  if (!(btn instanceof HTMLElement)) return;

  if (isLockedForWeek) {
    window.alert(
      "Depth chart is locked for this week. Changes will apply after the current game."
    );
    return;
  }

  const side = btn.getAttribute("data-side");
  const position = btn.getAttribute("data-position");
  const slotIndexStr = btn.getAttribute("data-slot-index");

  if (!side || !position || slotIndexStr == null) return;

  const slotIndex = Number(slotIndexStr);
  if (!Number.isFinite(slotIndex)) return;

  const currentPlayerId = btn.getAttribute("data-player-id") || null;

  openAssignModal(
    /** @type {"offense"|"defense"|"special"} */ (side),
    position,
    slotIndex,
    currentPlayerId
  );
}

// ---------------------------------------------------------------------------
// Assign modal
// ---------------------------------------------------------------------------

function openAssignModal(side, position, slotIndex, currentPlayerId) {
  if (!currentFranchiseSave || !currentLeagueState) return;

  currentAssignContext = { side, position, slotIndex };

  const modal = getEl("assign-modal");
  const slotLabelEl = getEl("assign-modal-slot-label");
  const eligibleListEl = getEl("assign-eligible-list");
  const oopSection = getEl("assign-oop-section");
  const oopListEl = getEl("assign-oop-list");

  if (!modal || !slotLabelEl || !eligibleListEl || !oopSection || !oopListEl) {
    console.warn("[Franchise GM] Assign modal elements missing.");
    return;
  }

  const sideLabelText = sideLabel(side);
  const slotLabel = slotLabelFromIndex(slotIndex);
  slotLabelEl.textContent = `${sideLabelText} • ${position} — ${slotLabel}`;

  eligibleListEl.innerHTML = "";
  oopListEl.innerHTML = "";

  const players = getTeamPlayers(currentLeagueState, currentFranchiseSave.teamCode);

  /** @type {Array<{player: Player, needsConfirm: boolean}>} */
  const eligible = [];
  /** @type {Array<{player: Player, needsConfirm: boolean}>} */
  const oop = [];

  players.forEach((p) => {
    if (isPlayerUnavailable(p)) {
      return; // unavailable players excluded from assignment lists
    }
    const { allowed, needsConfirm } = isPlayerEligibleForSlot(p, position);
    if (!allowed) return;

    if (!needsConfirm) {
      eligible.push({ player: p, needsConfirm: false });
    } else {
      oop.push({ player: p, needsConfirm: true });
    }
  });

  if (!eligible.length) {
    const div = document.createElement("div");
    div.className = "assign-empty";
    div.textContent = "No natural fits for this slot.";
    eligibleListEl.appendChild(div);
  } else {
    eligible.forEach(({ player, needsConfirm }) => {
      eligibleListEl.appendChild(
        createAssignPlayerButton(player, needsConfirm)
      );
    });
  }

  if (!oop.length) {
    oopSection.style.display = "none";
  } else {
    oopSection.style.display = "block";
    oop.forEach(({ player, needsConfirm }) => {
      oopListEl.appendChild(
        createAssignPlayerButton(player, needsConfirm)
      );
    });
  }

  modal.hidden = false;

  const cancelBtn = getEl("assign-modal-cancel");
  if (cancelBtn) cancelBtn.focus();
}

function closeAssignModal() {
  const modal = getEl("assign-modal");
  if (modal) modal.hidden = true;
  currentAssignContext = null;
}

/**
 * @param {Player} player
 * @param {boolean} needsConfirm
 */
function handleAssignPlayerFromModal(player, needsConfirm) {
  if (!currentFranchiseSave || !currentLeagueState || !currentAssignContext) {
    return;
  }

  const { side, position, slotIndex } = currentAssignContext;

  if (needsConfirm) {
    const msg =
      `Use ${formatPlayerDisplayName(player)} at ${position}? ` +
      "This is an out-of-position assignment and will carry risk in the sim.";
    const ok = window.confirm(msg);
    if (!ok) return;
  }

  setDepthChartSlot(
    currentLeagueState,
    currentFranchiseSave.teamCode,
    side,
    position,
    slotIndex,
    player.id
  );

  // Re-render everything to reflect new assignment
  renderDepthChart(currentFranchiseSave, currentLeagueState);
  renderRoster(currentFranchiseSave, currentLeagueState);
  renderStatusBanners(currentFranchiseSave, currentLeagueState);

  closeAssignModal();
}

/**
 * Clear current slot.
 */
function handleClearSlotFromModal() {
  if (!currentFranchiseSave || !currentLeagueState || !currentAssignContext) {
    return;
  }
  const { side, position, slotIndex } = currentAssignContext;

  setDepthChartSlot(
    currentLeagueState,
    currentFranchiseSave.teamCode,
    side,
    position,
    slotIndex,
    null
  );

  renderDepthChart(currentFranchiseSave, currentLeagueState);
  renderRoster(currentFranchiseSave, currentLeagueState);
  renderStatusBanners(currentFranchiseSave, currentLeagueState);

  closeAssignModal();
}

/**
 * @param {Player} player
 * @param {boolean} needsConfirm
 */
function createAssignPlayerButton(player, needsConfirm) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assign-player-btn";

  const main = document.createElement("div");
  main.className = "assign-player-main";

  const nameSpan = document.createElement("div");
  nameSpan.className = "assign-player-name";
  nameSpan.textContent = formatPlayerDisplayName(player);

  const metaSpan = document.createElement("div");
  metaSpan.className = "assign-player-meta";
  metaSpan.textContent = `${player.position} • ${formatStatusLabel(player.status)}`;

  main.appendChild(nameSpan);
  main.appendChild(metaSpan);

  btn.appendChild(main);

  btn.addEventListener("click", () => {
    handleAssignPlayerFromModal(player, needsConfirm);
  });

  return btn;
}

// ---------------------------------------------------------------------------
// Roster filter bindings
// ---------------------------------------------------------------------------

function bindRosterFilters() {
  const sideButtons = document.querySelectorAll(".roster-filter-btn");
  sideButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const side = btn.getAttribute("data-side-filter") || "all";
      rosterFilterSide = side;
      sideButtons.forEach((b) => {
        const s = b.getAttribute("data-side-filter") || "all";
        b.setAttribute("aria-pressed", s === side ? "true" : "false");
      });
      if (currentFranchiseSave && currentLeagueState) {
        renderRoster(currentFranchiseSave, currentLeagueState);
      }
    });
  });

  const posSelect = getEl("roster-position-filter");
  if (posSelect) {
    posSelect.addEventListener("change", () => {
      const val = posSelect.value;
      rosterFilterPosition = val;
      if (currentFranchiseSave && currentLeagueState) {
        renderRoster(currentFranchiseSave, currentLeagueState);
      }
    });
  }

  const searchInput = getEl("roster-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      rosterSearchQuery = searchInput.value || "";
      if (currentFranchiseSave && currentLeagueState) {
        renderRoster(currentFranchiseSave, currentLeagueState);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Side-of-ball toggle bindings
// ---------------------------------------------------------------------------

function bindSideToggle() {
  const btnOff = getEl("toggle-offense");
  const btnDef = getEl("toggle-defense");
  const btnSpec = getEl("toggle-special");

  function setSide(side) {
    currentSide = side;
    if (btnOff) btnOff.setAttribute("aria-pressed", side === "offense" ? "true" : "false");
    if (btnDef) btnDef.setAttribute("aria-pressed", side === "defense" ? "true" : "false");
    if (btnSpec) btnSpec.setAttribute("aria-pressed", side === "special" ? "true" : "false");

    if (currentFranchiseSave && currentLeagueState) {
      renderDepthChart(currentFranchiseSave, currentLeagueState);
    }
  }

  if (btnOff) btnOff.addEventListener("click", () => setSide("offense"));
  if (btnDef) btnDef.addEventListener("click", () => setSide("defense"));
  if (btnSpec) btnSpec.addEventListener("click", () => setSide("special"));
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

function bindShortcuts() {
  const hubBtn = getEl("shortcut-hub");
  const scheduleBtn = getEl("shortcut-schedule");
  const statsBtn = getEl("shortcut-stats");
  const contractsBtn = getEl("shortcut-contracts");
  const scoutingBtn = getEl("shortcut-scouting");

  if (hubBtn) {
    hubBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }
  if (scheduleBtn) {
    scheduleBtn.addEventListener("click", () => {
      window.location.href = "schedule.html";
    });
  }
  if (statsBtn) {
    statsBtn.addEventListener("click", () => {
      window.location.href = "stats.html";
    });
  }
  if (contractsBtn) {
    contractsBtn.addEventListener("click", () => {
      window.location.href = "contracts.html";
    });
  }
  if (scoutingBtn) {
    scoutingBtn.addEventListener("click", () => {
      window.location.href = "scouting.html";
    });
  }
}

// ---------------------------------------------------------------------------
// Modal bindings
// ---------------------------------------------------------------------------

function bindAssignModal() {
  const modal = getEl("assign-modal");
  const cancelBtn = getEl("assign-modal-cancel");
  const clearBtn = getEl("assign-clear-slot");

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      closeAssignModal();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      handleClearSlotFromModal();
    });
  }

  // ESC closes modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modal && !modal.hidden) {
        e.preventDefault();
        closeAssignModal();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// No-franchise handling
// ---------------------------------------------------------------------------

function showNoFranchiseState() {
  const page = getEl("team-page");
  const fallback = getEl("no-franchise");
  if (page) page.style.display = "none";
  if (fallback) fallback.hidden = false;

  const btn = getEl("btn-go-main-menu");
  if (btn) {
    btn.addEventListener("click", () => {
      window.location.href = "main_page.html";
    });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initTeamView() {
  const save = loadLastFranchise();
  if (!save) {
    showNoFranchiseState();
    return;
  }

  let leagueState = loadLeagueState(save.franchiseId);
  leagueState = ensureLeagueStateForTeam(save, leagueState);
  saveLeagueState(leagueState);

  currentFranchiseSave = save;
  currentLeagueState = leagueState;

  renderHeader(save);
  renderStatusBanners(save, leagueState);
  renderDepthChart(save, leagueState);
  renderRoster(save, leagueState);
  renderNotesCard(save, leagueState);

  bindSideToggle();
  bindRosterFilters();
  bindShortcuts();
  bindAssignModal();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTeamView);
} else {
  initTeamView();
}
