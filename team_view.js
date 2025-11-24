// team.js
//
// Franchise GM – Team View & Depth Chart
//
// This file drives the team/roster page. It:
// - Loads the current FranchiseSave from localStorage.
// - Loads the LeagueState for lock status and basic context.
// - Fetches the master roster CSV (all teams) and filters down to this team.
// - Builds or loads a depth chart object for this franchise.
// - Renders depth chart by unit (offense / defense / special) and full roster list.
// - Persists changes immediately.

// ---------------------------------------------------------------------------
// Types (doc comments only for reference)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} FranchiseSave
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} teamCode        // e.g. "CAR"
 * @property {string} [teamName]
 * @property {number} seasonYear
 * @property {number} weekIndex
 * @property {string} phase
 * @property {string} record
 * @property {Object} ownerExpectation
 * @property {string} ownerExpectation.patience
 * @property {number} ownerExpectation.baselineWins
 * @property {number} ownerExpectation.targetYear
 */

/**
 * @typedef {Object} LeagueState
 * @property {string} franchiseId
 * @property {number} seasonYear
 * @property {Object} timeline
 * @property {Object} timeline.nextEvent
 * @property {string} timeline.nextEvent.type      // "game", "draft", etc.
 * @property {string|null} timeline.nextEvent.kickoffIso
 */

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} teamId
 * @property {string} teamName
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} naturalPos
 * @property {number} depthCsv
 * @property {number|null} ratingOverall
 * @property {number|null} ratingPos
 * @property {Object<string, number>} positionScores  // e.g. { QB: 10000, WR: 0, ... }
 * @property {string|null} primaryArchetype
 */

/**
 * @typedef {Object} DepthChartState
 * @property {string} franchiseId
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {string} lastUpdatedIso
 * @property {Object<string, Array<string|null>>} positions  // pos -> [playerId or null]
 */

// ---------------------------------------------------------------------------
// Constants / keys
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";
const DEPTH_CHART_KEY_PREFIX = "franchiseGM_depthChart_";

/** URL for the master roster CSV (all teams). Change to local path if desired. */
const ROSTERS_CSV_URL =
  "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/layer3_rosters.csv";

// Canonical positions grouped by unit
const OFFENSE_POSITIONS = ["QB", "RB", "FB", "WR", "TE", "LT", "LG", "C", "RG", "RT"];
const DEFENSE_POSITIONS = ["DT", "EDGE", "LB", "CB", "S"];
const SPECIAL_POSITIONS = ["K", "P"];

// Map canonical positions to CSV column names for position scores
const POSITION_SCORE_COLUMNS = {
  QB: "position_score_QB",
  RB: "position_score_RB",
  WR: "position_score_WR",
  TE: "position_score_TE",
  FB: "position_score_FB",
  LT: "position_score_LT",
  LG: "position_score_LG",
  C: "position_score_C",
  RG: "position_score_RG",
  RT: "position_score_RT",
  DT: "position_score_DT",
  EDGE: "position_score_EDGE",
  LB: "position_score_LB",
  CB: "position_score_CB",
  S: "position_score_S",
  K: "position_score_K",
  P: "position_score_P"
};

// Threshold for "eligible" position based on position_score_X (0–10000 scale).
// Natural position is always considered eligible regardless of score.
const POSITION_ELIGIBILITY_THRESHOLD = 3500;

// Max depth slots per position to show
const MAX_DEPTH_SLOTS = 4;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__team";
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

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
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

function getDepthChartKey(franchiseId) {
  return `${DEPTH_CHART_KEY_PREFIX}${franchiseId}`;
}

function loadDepthChart(franchiseId) {
  if (!storageAvailable() || !franchiseId) return null;
  const raw = window.localStorage.getItem(getDepthChartKey(franchiseId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveDepthChart(depthState) {
  if (!storageAvailable() || !depthState || !depthState.franchiseId) return;
  try {
    depthState.lastUpdatedIso = new Date().toISOString();
    window.localStorage.setItem(
      getDepthChartKey(depthState.franchiseId),
      JSON.stringify(depthState)
    );
  } catch (err) {
    console.warn("[Franchise GM] Failed to save depth chart:", err);
  }
}

// ---------------------------------------------------------------------------
// CSV parsing for layer3_rosters.csv
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into an array of row objects with string values.
 * Assumes simple CSV (no quoted commas). Good enough for this data.
 * @param {string} text
 * @returns {Array<Object<string,string>>}
 */
function parseSimpleCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length) return [];

  const headerCells = lines[0].split(",");
  const headers = headerCells.map((h) => h.trim());

  /** @type {Array<Object<string,string>>} */
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length === 1 && cells[0] === "") continue; // skip empty
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j] || `col_${j}`;
      row[key] = (cells[j] || "").trim();
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Convert a raw CSV row into a normalized Player object.
 * @param {Object<string,string>} row
 * @param {number} index
 * @returns {Player}
 */
function playerFromCsvRow(row, index) {
  const teamId = row.team_id || row.teamId || "";
  const teamName = row.team_name || row.teamName || "";
  const first = row.first_name || "";
  const last = row.last_name || "";
  const naturalPos = row.position || row.pos || "";
  const depthCsv = Number(row.depth || "0") || 0;
  const ratingOverall = row.rating_overall ? Number(row.rating_overall) : null;
  const ratingPos = row.rating_pos ? Number(row.rating_pos) : null;
  const primaryArchetype = row.primary_archetype || null;

  /** @type {Object<string, number>} */
  const positionScores = {};
  for (const [pos, colName] of Object.entries(POSITION_SCORE_COLUMNS)) {
    const rawVal = row[colName];
    if (rawVal !== undefined && rawVal !== "") {
      const num = Number(rawVal);
      if (!Number.isNaN(num)) {
        positionScores[pos] = num;
      }
    }
  }

  const id = `${teamId || "TEAM"}_${first || "Player"}_${last || "X"}_${index}`;

  return {
    id,
    teamId,
    teamName,
    firstName: first,
    lastName: last,
    naturalPos: naturalPos,
    depthCsv,
    ratingOverall: Number.isFinite(ratingOverall) ? ratingOverall : null,
    ratingPos: Number.isFinite(ratingPos) ? ratingPos : null,
    positionScores,
    primaryArchetype
  };
}

// ---------------------------------------------------------------------------
// Depth chart helpers
// ---------------------------------------------------------------------------

/**
 * Turn a rating number into a rough text tier, without exposing the number.
 * @param {number|null} rating
 */
function ratingToTierLabel(rating) {
  if (rating == null || Number.isNaN(rating)) return "Fringe contributor";
  const r = rating;
  if (r >= 92) return "Elite";
  if (r >= 88) return "Pro bowl caliber";
  if (r >= 84) return "High-end starter";
  if (r >= 80) return "Solid starter";
  if (r >= 75) return "Spot starter";
  if (r >= 70) return "Reliable depth";
  if (r >= 65) return "Depth piece";
  if (r >= 60) return "Fringe roster";
  return "Camp body";
}

/**
 * Human-readable position archetype from primary_archetype.
 * e.g. "arch_WR_deep_threat" -> "Deep threat WR"
 */
function archetypeToLabel(archetype, naturalPos) {
  if (!archetype) return naturalPos || "";
  if (!archetype.startsWith("arch_")) return archetype;
  const parts = archetype.split("_");
  // Typical: ["arch", "WR", "deep", "threat"]
  if (parts.length < 3) return archetype;
  const pos = parts[1];
  const descriptor = parts.slice(2).join(" ");
  const niceDescriptor =
    descriptor
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || "";
  return `${niceDescriptor} ${pos}`;
}

/**
 * Determine if a player is "eligible" for a given position based on:
 * - natural position match, or
 * - position_scores threshold.
 * @param {Player} player
 * @param {string} pos
 */
function isPlayerEligibleForPosition(player, pos) {
  if (!player) return false;
  if (player.naturalPos === pos) return true;
  const score = player.positionScores[pos];
  if (typeof score === "number" && score >= POSITION_ELIGIBILITY_THRESHOLD) {
    return true;
  }
  return false;
}

/**
 * Build a default depth chart from scratch based on roster.
 * This only runs when no saved depth chart exists for this franchise.
 * @param {Array<Player>} players
 * @param {FranchiseSave} save
 * @returns {DepthChartState}
 */
function createDefaultDepthChart(players, save) {
  /** @type {DepthChartState} */
  const depth = {
    franchiseId: save.franchiseId,
    teamCode: save.teamCode,
    seasonYear: save.seasonYear,
    lastUpdatedIso: new Date().toISOString(),
    positions: {}
  };

  const allPositions = [
    ...OFFENSE_POSITIONS,
    ...DEFENSE_POSITIONS,
    ...SPECIAL_POSITIONS
  ];

  // Group players by natural position
  /** @type {Record<string, Player[]>} */
  const byPos = {};
  for (const p of players) {
    const pos = (p.naturalPos || "").toUpperCase();
    if (!pos) continue;
    if (!byPos[pos]) byPos[pos] = [];
    byPos[pos].push(p);
  }

  // For each position: sort by position-specific rating or overall, then assign
  for (const pos of allPositions) {
    const pool = (byPos[pos] || []).slice();
    if (!pool.length) {
      depth.positions[pos] = new Array(MAX_DEPTH_SLOTS).fill(null);
      continue;
    }

    pool.sort((a, b) => {
      const ra = (a.ratingPos ?? a.ratingOverall ?? 0);
      const rb = (b.ratingPos ?? b.ratingOverall ?? 0);
      return rb - ra;
    });

    const slots = [];
    for (let i = 0; i < MAX_DEPTH_SLOTS; i++) {
      const player = pool[i];
      slots.push(player ? player.id : null);
    }
    depth.positions[pos] = slots;
  }

  return depth;
}

/**
 * Get the unit label for a position (offense/defense/special).
 * @param {string} pos
 */
function unitForPosition(pos) {
  const up = pos.toUpperCase();
  if (OFFENSE_POSITIONS.includes(up)) return "offense";
  if (DEFENSE_POSITIONS.includes(up)) return "defense";
  if (SPECIAL_POSITIONS.includes(up)) return "special";
  return "other";
}

/**
 * Get the human-readable description for a position group.
 * @param {string} pos
 */
function posGroupSubLabel(pos) {
  const up = pos.toUpperCase();
  switch (up) {
    case "QB":
      return "Quarterbacks";
    case "RB":
      return "Halfbacks / tailbacks";
    case "FB":
      return "Fullbacks";
    case "WR":
      return "Wide receivers";
    case "TE":
      return "Tight ends";
    case "LT":
    case "LG":
    case "C":
    case "RG":
    case "RT":
      return "Offensive line";
    case "DT":
      return "Interior defensive line";
    case "EDGE":
      return "Edge rushers";
    case "LB":
      return "Linebackers";
    case "CB":
      return "Cornerbacks";
    case "S":
      return "Safeties";
    case "K":
      return "Kicker";
    case "P":
      return "Punter";
    default:
      return "";
  }
}

/**
 * Return an ordered list of positions for a given unit filter.
 * @param {"offense"|"defense"|"special"|"all"} unitFilter
 */
function positionsForUnit(unitFilter) {
  if (unitFilter === "offense") return OFFENSE_POSITIONS.slice();
  if (unitFilter === "defense") return DEFENSE_POSITIONS.slice();
  if (unitFilter === "special") return SPECIAL_POSITIONS.slice();
  return [
    ...OFFENSE_POSITIONS,
    ...DEFENSE_POSITIONS,
    ...SPECIAL_POSITIONS
  ];
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Lock state
// ---------------------------------------------------------------------------

/**
 * Determine whether the depth chart should be locked based on the next event.
 * Lock once the next game's kickoff time has passed.
 * @param {LeagueState|null} leagueState
 */
function computeLockState(leagueState) {
  if (!leagueState || !leagueState.timeline || !leagueState.timeline.nextEvent) {
    return { locked: false, reason: "No upcoming game set." };
  }

  const next = leagueState.timeline.nextEvent;
  if (next.type !== "game") {
    // For non-game phases, we leave things editable for now.
    return { locked: false, reason: "No active game window." };
  }

  if (!next.kickoffIso) {
    return {
      locked: false,
      reason: "Game time not set; depth chart editable."
    };
  }

  const kickoff = new Date(next.kickoffIso);
  if (Number.isNaN(kickoff.getTime())) {
    return { locked: false, reason: "Game time invalid; chart editable." };
  }

  const now = new Date();
  if (now >= kickoff) {
    return {
      locked: true,
      reason: "Kickoff has passed; depth chart locked for this game."
    };
  }

  // Before kickoff, editable but close to lock
  return {
    locked: false,
    reason: `Editable until kickoff on ${kickoff.toLocaleString()}`
  };
}

// ---------------------------------------------------------------------------
// Global-ish page state
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;
/** @type {Array<Player>} */
let currentRoster = [];
/** @type {DepthChartState|null} */
let currentDepthChart = null;
/** @type {"offense"|"defense"|"special"|"all"} */
let currentUnitFilter = "offense";
/** @type {boolean} */
let depthLocked = false;
/** @type {string|null} */
let highlightedPlayerId = null;

// ---------------------------------------------------------------------------
// Rendering – header
// ---------------------------------------------------------------------------

function getTeamDisplayName(save) {
  if (save.teamName && typeof save.teamName === "string") return save.teamName;
  if (save.franchiseName && typeof save.franchiseName === "string") return save.franchiseName;
  if (save.teamCode) return save.teamCode;
  return "Franchise Team";
}

function formatSeasonSubline(save) {
  const season = save.seasonYear ? `Season ${save.seasonYear}` : "Season";
  const phase = save.phase || "";
  const weekIndex =
    typeof save.weekIndex === "number" && Number.isFinite(save.weekIndex)
      ? save.weekIndex
      : null;
  const weekLabel =
    weekIndex != null ? `Week ${weekIndex + 1}` : "";

  return [season, phase, weekLabel].filter(Boolean).join(" • ");
}

function renderHeader() {
  const nameEl = getEl("team-header-name");
  const sublineEl = getEl("team-header-subline");
  const recordValueEl = getEl("team-record-value");
  const lockPill = getEl("depth-lock-pill");
  const lockLabel = getEl("depth-lock-label");

  if (!currentFranchiseSave) return;

  if (nameEl) nameEl.textContent = getTeamDisplayName(currentFranchiseSave);
  if (sublineEl) sublineEl.textContent = formatSeasonSubline(currentFranchiseSave);

  const record = (currentFranchiseSave.record || "").trim() || "0–0";
  if (recordValueEl) recordValueEl.textContent = record;

  const lockInfo = computeLockState(currentLeagueState);
  depthLocked = lockInfo.locked;

  if (lockPill && lockLabel) {
    lockPill.classList.toggle("pill-lock--locked", depthLocked);
    lockPill.classList.toggle("pill-lock--editable", !depthLocked);
    lockLabel.textContent = depthLocked
      ? "Depth chart locked"
      : "Depth chart editable";
  }

  const lockBannerContainer = getEl("lock-banner-container");
  if (lockBannerContainer) {
    lockBannerContainer.innerHTML = "";
    const div = document.createElement("div");
    div.className =
      "lock-banner " +
      (depthLocked ? "lock-banner--locked" : "lock-banner--warning");
    div.textContent = lockInfo.reason;
    lockBannerContainer.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// Rendering – depth chart
// ---------------------------------------------------------------------------

/**
 * Get player by id.
 * @param {string|null} playerId
 * @returns {Player|null}
 */
function getPlayerById(playerId) {
  if (!playerId) return null;
  return currentRoster.find((p) => p.id === playerId) || null;
}

/**
 * Build a human description of how "risky" this assignment is.
 * @param {Player} player
 * @param {string} pos
 */
function buildSlotRiskTags(player, pos) {
  const tags = [];

  if (!player) return tags;

  if (player.naturalPos === pos) {
    tags.push("Natural fit");
  } else if (isPlayerEligibleForPosition(player, pos)) {
    tags.push("Reasonable fit");
  } else {
    tags.push("Emergency only");
  }

  // We could later add injury flags, fatigue, etc. For now we only look at fit.
  return tags;
}

/**
 * Render the entire depth chart for the current unit filter.
 */
function renderDepthChart() {
  const container = getEl("depth-chart-container");
  if (!container || !currentDepthChart) return;

  container.innerHTML = "";

  const positions = positionsForUnit(currentUnitFilter);

  positions.forEach((pos) => {
    const unit = unitForPosition(pos);
    // If filtering by offense/defense/special, skip mismatched
    if (
      currentUnitFilter !== "all" &&
      unit !== currentUnitFilter
    ) {
      return;
    }

    const posSlots = currentDepthChart.positions[pos] || [];

    const group = document.createElement("div");
    group.className = "pos-group";
    group.dataset.pos = pos;

    const header = document.createElement("div");
    header.className = "pos-group-header";

    const left = document.createElement("div");
    const label = document.createElement("div");
    label.className = "pos-group-label";
    label.textContent = pos;
    const sub = document.createElement("div");
    sub.className = "pos-group-sub";
    sub.textContent = posGroupSubLabel(pos);

    left.appendChild(label);
    if (sub.textContent) left.appendChild(sub);

    header.appendChild(left);
    group.appendChild(header);

    // Slots
    const maxSlots = Math.max(posSlots.length, MAX_DEPTH_SLOTS);
    for (let i = 0; i < maxSlots; i++) {
      const slotRow = document.createElement("div");
      slotRow.className = "slot-row";

      const labelEl = document.createElement("div");
      labelEl.className = "slot-row-label";
      if (i === 0) labelEl.textContent = "Starter";
      else if (i === 1) labelEl.textContent = "2nd";
      else if (i === 2) labelEl.textContent = "3rd";
      else labelEl.textContent = `${i + 1}th`;

      const slotPlayerId = posSlots[i] || null;
      const player = getPlayerById(slotPlayerId);

      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "slot-player-pill";
      pill.dataset.pos = pos;
      pill.dataset.slotIndex = String(i);

      if (!player) {
        pill.classList.add("slot-player-pill--empty");
        pill.textContent = depthLocked
          ? "Unfilled"
          : "Click to assign player";
      } else {
        const nameDiv = document.createElement("div");
        nameDiv.className = "slot-player-name";
        nameDiv.textContent = `${player.firstName} ${player.lastName}`;

        const metaDiv = document.createElement("div");
        metaDiv.className = "slot-player-meta";
        const tier = ratingToTierLabel(player.ratingOverall ?? player.ratingPos);
        const archetypeLabel = archetypeToLabel(
          player.primaryArchetype,
          player.naturalPos
        );
        metaDiv.textContent = `${archetypeLabel || player.naturalPos} • ${tier}`;

        pill.appendChild(nameDiv);
        pill.appendChild(metaDiv);
      }

      if (depthLocked) {
        pill.disabled = true;
      } else {
        pill.addEventListener("click", () => {
          openPlayerPickerForSlot(pos, i);
        });
      }

      const badgeCell = document.createElement("div");
      badgeCell.className = "slot-badge-row";

      if (player) {
        const tags = buildSlotRiskTags(player, pos);
        tags.forEach((tag) => {
          const b = document.createElement("span");
          b.className = "slot-badge";
          if (tag === "Natural fit") b.classList.add("slot-badge--starter");
          if (tag === "Emergency only") b.classList.add("slot-badge--risk");
          b.textContent = tag;
          badgeCell.appendChild(b);
        });
      }

      slotRow.appendChild(labelEl);
      slotRow.appendChild(pill);
      slotRow.appendChild(badgeCell);
      group.appendChild(slotRow);
    }

    container.appendChild(group);
  });
}

// ---------------------------------------------------------------------------
// Rendering – roster list
// ---------------------------------------------------------------------------

function passesRosterFilter(player, query, posFilter) {
  const q = query.trim().toLowerCase();
  const pos = posFilter.trim().toUpperCase();

  if (pos && player.naturalPos.toUpperCase() !== pos) return false;

  if (!q) return true;

  const fullName = `${player.firstName} ${player.lastName}`.toLowerCase();
  if (fullName.includes(q)) return true;

  if (player.naturalPos.toLowerCase().includes(q)) return true;

  return false;
}

/**
 * Determine whether a player appears anywhere on the depth chart.
 * @param {Player} player
 */
function playerIsAssignedSomewhere(player) {
  if (!currentDepthChart) return false;
  for (const pos of Object.keys(currentDepthChart.positions || {})) {
    const slots = currentDepthChart.positions[pos] || [];
    if (slots.some((id) => id === player.id)) return true;
  }
  return false;
}

function renderRosterList() {
  const listEl = getEl("roster-list");
  const emptyMsg = getEl("roster-empty-msg");
  const searchInput = /** @type {HTMLInputElement|null} */ (
    getEl("roster-search-input")
  );
  const posSelect = /** @type {HTMLSelectElement|null} */ (
    getEl("roster-filter-pos")
  );

  if (!listEl) return;

  const query = searchInput ? searchInput.value || "" : "";
  const posFilter = posSelect ? posSelect.value || "" : "";

  const filtered = currentRoster.filter((player) =>
    passesRosterFilter(player, query, posFilter)
  );

  listEl.innerHTML = "";

  if (!filtered.length) {
    if (emptyMsg) {
      emptyMsg.textContent = query
        ? "No players match this filter."
        : "No players loaded for this roster.";
      emptyMsg.style.display = "block";
      listEl.appendChild(emptyMsg);
    }
    return;
  }

  if (emptyMsg) emptyMsg.style.display = "none";

  filtered.forEach((player) => {
    const row = document.createElement("div");
    row.className = "roster-row";
    if (!playerIsAssignedSomewhere(player)) {
      row.classList.add("roster-row--unassigned");
    }
    if (highlightedPlayerId === player.id) {
      row.classList.add("roster-row-highlight");
    }

    const nameCell = document.createElement("div");
    nameCell.className = "roster-row-name";
    nameCell.textContent = `${player.firstName} ${player.lastName}`;

    const posCell = document.createElement("div");
    posCell.className = "roster-row-pos";
    posCell.textContent = player.naturalPos || "—";

    const roleCell = document.createElement("div");
    roleCell.className = "roster-row-role";
    const tier = ratingToTierLabel(player.ratingOverall ?? player.ratingPos);
    const archetypeLabel = archetypeToLabel(
      player.primaryArchetype,
      player.naturalPos
    );
    roleCell.textContent = archetypeLabel
      ? `${archetypeLabel} • ${tier}`
      : tier;

    row.appendChild(nameCell);
    row.appendChild(posCell);
    row.appendChild(roleCell);

    listEl.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Player picker for slot assignment
// ---------------------------------------------------------------------------

/**
 * Open a simple inline picker for a specific slot.
 * For now, we use window.prompt-style selection:
 * - The user picks a player from a filtered list in a simple dialog-like flow.
 * - If the player is not eligible, we ask them to confirm the risky move.
 * @param {string} pos
 * @param {number} slotIndex
 */
function openPlayerPickerForSlot(pos, slotIndex) {
  if (depthLocked) return;

  // Build a sorted list of candidates of this team, sorted by fit.
  const candidates = currentRoster.slice().sort((a, b) => {
    // Prefer players whose naturalPos == pos, then by position score, then rating.
    const aNatural = a.naturalPos.toUpperCase() === pos.toUpperCase();
    const bNatural = b.naturalPos.toUpperCase() === pos.toUpperCase();
    if (aNatural && !bNatural) return -1;
    if (!aNatural && bNatural) return 1;

    const aScore = a.positionScores[pos] ?? 0;
    const bScore = b.positionScores[pos] ?? 0;
    if (bScore !== aScore) return bScore - aScore;

    const aRating = (a.ratingPos ?? a.ratingOverall ?? 0);
    const bRating = (b.ratingPos ?? b.ratingOverall ?? 0);
    return bRating - aRating;
  });

  if (!candidates.length) {
    window.alert("No players found for this team.");
    return;
  }

  const labelLines = candidates.map((p, idx) => {
    const tier = ratingToTierLabel(p.ratingOverall ?? p.ratingPos);
    const naturalTag = p.naturalPos.toUpperCase() === pos.toUpperCase()
      ? " (natural)"
      : "";
    return `${idx + 1}. ${p.firstName} ${p.lastName} [${p.naturalPos}${naturalTag}, ${tier}]`;
  });

  const input = window.prompt(
    `Assign ${pos} depth ${slotIndex + 1}:\n` +
      labelLines.slice(0, 30).join("\n") +
      (labelLines.length > 30 ? "\n…" : "") +
      `\n\nEnter number (1-${Math.min(labelLines.length, 30)}) or leave blank to cancel:`
  );

  if (!input) return;
  const choiceIndex = Number(input) - 1;
  if (!Number.isFinite(choiceIndex) || choiceIndex < 0 || choiceIndex >= candidates.length) {
    window.alert("Invalid selection.");
    return;
  }

  const chosen = candidates[choiceIndex];
  if (!chosen) return;

  const eligible = isPlayerEligibleForPosition(chosen, pos);
  if (!eligible) {
    const confirmRisk = window.confirm(
      `${chosen.firstName} ${chosen.lastName} is not a natural or rated fit at ${pos}. ` +
      "In real life this would be an emergency-only assignment. Do you want to proceed anyway?"
    );
    if (!confirmRisk) return;
  }

  // Assign player to this slot. We allow players to appear in multiple positions
  // (e.g., WR + special teams). We do not forcibly remove them from other slots.
  if (!currentDepthChart.positions[pos]) {
    currentDepthChart.positions[pos] = new Array(MAX_DEPTH_SLOTS).fill(null);
  }
  currentDepthChart.positions[pos][slotIndex] = chosen.id;
  saveDepthChart(currentDepthChart);
  highlightedPlayerId = chosen.id;

  renderDepthChart();
  renderRosterList();
}

// ---------------------------------------------------------------------------
// Binding – unit tabs & controls
// ---------------------------------------------------------------------------

function bindUnitTabs() {
  const tabs = document.querySelectorAll(".unit-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const unit = tab.getAttribute("data-unit") || "offense";
      currentUnitFilter = /** @type any */ (unit);

      tabs.forEach((t) => t.classList.remove("unit-tab--active"));
      tab.classList.add("unit-tab--active");

      renderDepthChart();
    });
  });
}

function bindRosterFilters() {
  const searchInput = getEl("roster-search-input");
  const posSelect = getEl("roster-filter-pos");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderRosterList();
    });
  }
  if (posSelect) {
    posSelect.addEventListener("change", () => {
      renderRosterList();
    });
  }
}

function bindButtons() {
  const backHubBtn = getEl("btn-back-hub");
  const mainMenuBtn = getEl("btn-go-main-menu");
  const resetDepthBtn = getEl("btn-sync-default-depth");

  if (backHubBtn) {
    backHubBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }
  if (mainMenuBtn) {
    mainMenuBtn.addEventListener("click", () => {
      window.location.href = "main_page.html";
    });
  }
  if (resetDepthBtn) {
    resetDepthBtn.addEventListener("click", () => {
      if (!currentFranchiseSave) return;
      const ok = window.confirm(
        "Reset depth chart to an automatic, engine-style default for this roster?"
      );
      if (!ok) return;

      currentDepthChart = createDefaultDepthChart(currentRoster, currentFranchiseSave);
      saveDepthChart(currentDepthChart);
      highlightedPlayerId = null;
      renderDepthChart();
      renderRosterList();
    });
  }
}

// ---------------------------------------------------------------------------
// No-franchise state handling
// ---------------------------------------------------------------------------

function showNoFranchiseState() {
  const main = getEl("team-main");
  const noFranchise = getEl("no-franchise");
  if (main) main.hidden = true;
  if (noFranchise) noFranchise.hidden = false;
}

// ---------------------------------------------------------------------------
// Init sequence
// ---------------------------------------------------------------------------

async function initTeamPage() {
  const save = loadLastFranchise();
  if (!save) {
    showNoFranchiseState();
    return;
  }
  currentFranchiseSave = save;

  currentLeagueState = loadLeagueState(save.franchiseId) || null;

  // Load roster CSV
  let csvText;
  try {
    const resp = await fetch(ROSTERS_CSV_URL);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    csvText = await resp.text();
  } catch (err) {
    console.error("[Franchise GM] Failed to load roster CSV:", err);
    const rosterList = getEl("roster-list");
    const empty = getEl("roster-empty-msg");
    if (rosterList && empty) {
      rosterList.innerHTML = "";
      empty.textContent =
        "Failed to load roster data. Check the CSV URL or network.";
      empty.style.display = "block";
      rosterList.appendChild(empty);
    }
    renderHeader();
    return;
  }

  const rawRows = parseSimpleCsv(csvText);

  const teamCode = (save.teamCode || "").toUpperCase();
  currentRoster = rawRows
    .map(playerFromCsvRow)
    .filter((p) => p.teamId.toUpperCase() === teamCode);

  // Load or create depth chart
  const existingDepth = loadDepthChart(save.franchiseId);
  if (existingDepth && existingDepth.positions) {
    currentDepthChart = existingDepth;
  } else {
    currentDepthChart = createDefaultDepthChart(currentRoster, save);
    saveDepthChart(currentDepthChart);
  }

  // Render everything
  renderHeader();
  renderDepthChart();
  renderRosterList();

  // Wire controls
  bindUnitTabs();
  bindRosterFilters();
  bindButtons();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTeamPage);
} else {
  initTeamPage();
}
