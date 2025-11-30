// team.js
//
// Franchise GM – Team Formation Dashboard
//
// This keeps the existing data architecture:
// - Loads FranchiseSave from localStorage ("franchiseGM_lastFranchise").
// - Loads LeagueState from "franchiseGM_leagueState_<franchiseId>".
// - Loads / saves depth chart at "franchiseGM_depthChart_<franchiseId>".
// - Player data comes from layer3_rosters.csv.
// - Depth chart structure: positions[pos] = [playerId | null, ...].
//
// The UI here is a formation board using CSS Grid for Offense / Defense / Special.

// ---------------------------------------------------------------------------
// Types (doc comments only)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FranchiseSave
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} teamCode
 * @property {string} [teamName]
 * @property {number} seasonYear
 * @property {number} weekIndex
 * @property {string} phase
 * @property {string} record
 */

/**
 * @typedef {Object} LeagueState
 * @property {string} franchiseId
 * @property {number} seasonYear
 * @property {{ nextEvent?: { type: string, kickoffIso?: string|null } }} timeline
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
 * @property {Object<string, number>} positionScores
 * @property {string|null} primaryArchetype
 */

/**
 * @typedef {Object} DepthChartState
 * @property {string} franchiseId
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {string} lastUpdatedIso
 * @property {Object<string, Array<string|null>>} positions
 */

// ---------------------------------------------------------------------------
// Constants / keys
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";
const DEPTH_CHART_KEY_PREFIX = "franchiseGM_depthChart_";

const ROSTERS_CSV_URL =
  "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/layer3_rosters.csv";

// Canonical positions grouped by unit
const OFFENSE_POSITIONS = [
  "QB",
  "RB",
  "FB",
  "WR",
  "TE",
  "LT",
  "LG",
  "C",
  "RG",
  "RT"
];
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

// Threshold for "eligible" position on 0–10000 scale
const POSITION_ELIGIBILITY_THRESHOLD = 3500;

// Default max depth slots per position in a fresh chart
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
    if (cells.length === 1 && cells[0] === "") continue;
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
      if (!Number.isNaN(num)) positionScores[pos] = num;
    }
  }

  const id = `${teamId || "TEAM"}_${first || "Player"}_${last || "X"}_${index}`;

  return {
    id,
    teamId,
    teamName,
    firstName: first,
    lastName: last,
    naturalPos: naturalPos.toUpperCase(),
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
 * e.g. "arch_WR_deep_threat" -> "Deep Threat WR"
 */
function archetypeToLabel(archetype, naturalPos) {
  if (!archetype) return naturalPos || "";
  if (!archetype.startsWith("arch_")) return archetype;
  const parts = archetype.split("_");
  if (parts.length < 3) return archetype;
  const pos = parts[1];
  const descriptor = parts.slice(2).join(" ");
  const niceDescriptor =
    descriptor.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "";
  return `${niceDescriptor} ${pos}`;
}

function isPlayerEligibleForPosition(player, pos) {
  if (!player) return false;
  const up = pos.toUpperCase();
  if (player.naturalPos.toUpperCase() === up) return true;
  const score = player.positionScores[up];
  if (typeof score === "number" && score >= POSITION_ELIGIBILITY_THRESHOLD) {
    return true;
  }
  return false;
}

/**
 * Build a default depth chart for this roster when no saved chart exists.
 * @param {Player[]} players
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

  /** @type {Record<string, Player[]>} */
  const byPos = {};
  for (const p of players) {
    const pos = (p.naturalPos || "").toUpperCase();
    if (!pos) continue;
    if (!byPos[pos]) byPos[pos] = [];
    byPos[pos].push(p);
  }

  for (const pos of allPositions) {
    const pool = (byPos[pos] || []).slice();
    if (!pool.length) {
      depth.positions[pos] = new Array(MAX_DEPTH_SLOTS).fill(null);
      continue;
    }

    pool.sort((a, b) => {
      const ra = a.ratingPos ?? a.ratingOverall ?? 0;
      const rb = b.ratingPos ?? b.ratingOverall ?? 0;
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

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Lock / header helpers
// ---------------------------------------------------------------------------

function computeLockState(leagueState) {
  if (!leagueState || !leagueState.timeline || !leagueState.timeline.nextEvent) {
    return { locked: false, reason: "No upcoming game set." };
  }

  const next = leagueState.timeline.nextEvent;
  if (next.type !== "game") {
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

  return {
    locked: false,
    reason: `Editable until kickoff on ${kickoff.toLocaleString()}`
  };
}

function getTeamDisplayNameFromSave(save) {
  if (!save) return "Franchise Team";
  if (save.teamName && typeof save.teamName === "string") return save.teamName;
  if (save.franchiseName && typeof save.franchiseName === "string")
    return save.franchiseName;
  if (save.teamCode) return save.teamCode;
  return "Franchise Team";
}

function formatSeasonLabel(save) {
  if (!save || !save.seasonYear) return "Season";
  return `Season ${save.seasonYear}`;
}

// ---------------------------------------------------------------------------
// Global-ish page state
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;
/** @type {Player[]} */
let currentRoster = [];
/** @type {DepthChartState|null} */
let currentDepthChart = null;
/** @type {"offense"|"defense"|"special"} */
let currentUnitFilter = "offense";
/** @type {boolean} */
let depthLocked = false;
/** @type {string|null} */
let highlightedPlayerId = null;

// ---------------------------------------------------------------------------
// Rendering – header
// ---------------------------------------------------------------------------

function renderHeader() {
  if (!currentFranchiseSave) return;

  const nameEl = getEl("top-team-name");
  const seasonEl = getEl("top-season-label");
  const recordEl = getEl("top-record");
  const lockLabelEl = getEl("top-lock-label");

  if (nameEl) nameEl.textContent = getTeamDisplayNameFromSave(currentFranchiseSave);
  if (seasonEl) seasonEl.textContent = formatSeasonLabel(currentFranchiseSave);

  const record = (currentFranchiseSave.record || "").trim() || "0–0";
  if (recordEl) recordEl.textContent = record;

  const lockInfo = computeLockState(currentLeagueState);
  depthLocked = lockInfo.locked;
  if (lockLabelEl) {
    lockLabelEl.textContent = lockInfo.locked
      ? "Depth chart locked"
      : "Depth chart editable";
  }
}

// ---------------------------------------------------------------------------
// Rendering – formation view
// ---------------------------------------------------------------------------

function getPlayerById(playerId) {
  if (!playerId) return null;
  return currentRoster.find((p) => p.id === playerId) || null;
}

function depthLabelForIndex(idx) {
  if (idx === 0) return "Starter";
  if (idx === 1) return "2nd";
  if (idx === 2) return "3rd";
  return `${idx + 1}th`;
}

/**
 * Render all position stacks for one unit into its formation container.
 *
 * @param {"offense"|"defense"|"special"} unit
 * @param {string[]} positions
 * @param {string} containerId
 */
function renderFormationUnit(unit, positions, containerId) {
  const container = getEl(containerId);
  if (!container || !currentDepthChart) return;

  container.innerHTML = "";

  positions.forEach((pos) => {
    const posKey = pos.toUpperCase();
    const posSlots = currentDepthChart.positions[posKey] || [];
    const slotCount = posSlots.length || 1;

    const card = document.createElement("section");
    card.className = `position-card position-card--${posKey}`;
    card.dataset.pos = posKey;

    const header = document.createElement("div");
    header.className = "position-card-header";

    const label = document.createElement("div");
    label.className = "position-label";
    label.textContent = posKey;

    const sub = document.createElement("div");
    sub.className = "position-sub";
    sub.textContent = posGroupSubLabel(posKey);

    header.appendChild(label);
    if (sub.textContent) header.appendChild(sub);

    const body = document.createElement("div");
    body.className = "position-card-body";

    for (let i = 0; i < slotCount; i++) {
      const playerId = posSlots[i] || null;
      const player = getPlayerById(playerId);

      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "player-pill";
      pill.dataset.pos = posKey;
      pill.dataset.slotIndex = String(i);

      if (i === 0) pill.classList.add("player-pill--starter");

      if (!player) {
        // Empty slot – main click still edits depth (when unlocked)
        pill.classList.add("player-pill--empty");
        const labelSpan = document.createElement("span");
        labelSpan.className = "player-pill-name";
        labelSpan.textContent = depthLocked ? "Open slot" : "Assign player";
        pill.appendChild(labelSpan);

        if (depthLocked) {
          pill.disabled = true;
        } else {
          pill.addEventListener("click", () => {
            const slotIdx = Number(pill.dataset.slotIndex || "0") || 0;
            openPlayerPickerForSlot(posKey, slotIdx);
          });
        }
      } else {
        if (player.id === highlightedPlayerId) {
          pill.style.boxShadow = "0 0 0 1px rgba(56,189,248,0.9)";
        }

        // Main pill content
        const topRow = document.createElement("div");
        topRow.className = "player-pill-top";

        const orderSpan = document.createElement("span");
        orderSpan.className = "player-pill-order";
        orderSpan.textContent = depthLabelForIndex(i);

        const nameSpan = document.createElement("span");
        nameSpan.className = "player-pill-name";
        nameSpan.textContent = `${player.firstName} ${player.lastName}`;

        topRow.appendChild(orderSpan);
        topRow.appendChild(nameSpan);

        const meta = document.createElement("div");
        meta.className = "player-pill-meta";
        const rating = player.ratingPos ?? player.ratingOverall;
        const ratingText =
          rating != null && Number.isFinite(rating) ? `OVR ${rating}` : "";
        const archLabel = archetypeToLabel(
          player.primaryArchetype,
          player.naturalPos
        );
        const tier = ratingToTierLabel(rating);
        const metaParts = [ratingText, archLabel, tier].filter(Boolean);
        meta.textContent = metaParts.join(" • ");

        pill.appendChild(topRow);
        pill.appendChild(meta);

        // Small inline "Edit depth" affordance – uses stopPropagation
        const actions = document.createElement("div");
        actions.className = "player-pill-actions";

        const editSpan = document.createElement("span");
        editSpan.className = "player-pill-edit-link";
        editSpan.textContent = depthLocked ? "Depth locked" : "Edit depth";

        if (!depthLocked) {
          editSpan.addEventListener("click", (evt) => {
            evt.stopPropagation();
            const slotIdx = Number(pill.dataset.slotIndex || "0") || 0;
            openPlayerPickerForSlot(posKey, slotIdx);
          });
        }

        actions.appendChild(editSpan);
        pill.appendChild(actions);

        // Main click → Player Detail page
        pill.addEventListener("click", () => {
          const url = new URL("player_detail.html", window.location.href);
          url.searchParams.set("playerId", player.id);
          window.location.href = url.toString();
        });

        if (depthLocked) {
          // Keep profile view active even if depth is locked.
          // Only the Edit Depth affordance is effectively disabled.
        }
      }

      body.appendChild(pill);
    }

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  });
}


function renderDepthChart() {
  if (!currentDepthChart) return;

  renderFormationUnit("offense", OFFENSE_POSITIONS, "offense-formation");
  renderFormationUnit("defense", DEFENSE_POSITIONS, "defense-formation");
  renderFormationUnit("special", SPECIAL_POSITIONS, "special-formation");

  const offenseEl = getEl("offense-formation");
  const defenseEl = getEl("defense-formation");
  const specialEl = getEl("special-formation");

  if (!offenseEl || !defenseEl || !specialEl) return;

  offenseEl.hidden = currentUnitFilter !== "offense";
  defenseEl.hidden = currentUnitFilter !== "defense";
  specialEl.hidden = currentUnitFilter !== "special";
}

// ---------------------------------------------------------------------------
// Player picker for slot assignment (existing behavior preserved)
// ---------------------------------------------------------------------------

/**
 * Open a simple picker for a specific slot, using a prompt-based list.
 * @param {string} pos
 * @param {number} slotIndex
 */
function openPlayerPickerForSlot(pos, slotIndex) {
  if (depthLocked) return;

  const upPos = pos.toUpperCase();

  // Build a sorted list of candidates for this team, sorted by fit.
  const candidates = currentRoster.slice().sort((a, b) => {
    const aNatural = a.naturalPos.toUpperCase() === upPos;
    const bNatural = b.naturalPos.toUpperCase() === upPos;
    if (aNatural && !bNatural) return -1;
    if (!aNatural && bNatural) return 1;

    const aScore = a.positionScores[upPos] ?? 0;
    const bScore = b.positionScores[upPos] ?? 0;
    if (bScore !== aScore) return bScore - aScore;

    const aRating = a.ratingPos ?? a.ratingOverall ?? 0;
    const bRating = b.ratingPos ?? b.ratingOverall ?? 0;
    return bRating - aRating;
  });

  if (!candidates.length) {
    window.alert("No players found for this team.");
    return;
  }

  const labelLines = candidates.map((p, idx) => {
    const tier = ratingToTierLabel(p.ratingOverall ?? p.ratingPos);
    const naturalTag =
      p.naturalPos.toUpperCase() === upPos ? " (natural)" : "";
    return `${idx + 1}. ${p.firstName} ${p.lastName} [${p.naturalPos}${naturalTag}, ${tier}]`;
  });

  const input = window.prompt(
    `Assign ${upPos} depth ${slotIndex + 1}:\n` +
      labelLines.slice(0, 30).join("\n") +
      (labelLines.length > 30 ? "\n…" : "") +
      `\n\nEnter number (1-${Math.min(
        labelLines.length,
        30
      )}) or leave blank to cancel:`
  );

  if (!input) return;
  const choiceIndex = Number(input) - 1;
  if (
    !Number.isFinite(choiceIndex) ||
    choiceIndex < 0 ||
    choiceIndex >= candidates.length
  ) {
    window.alert("Invalid selection.");
    return;
  }

  const chosen = candidates[choiceIndex];
  if (!chosen) return;

  const eligible = isPlayerEligibleForPosition(chosen, upPos);
  if (!eligible) {
    const confirmRisk = window.confirm(
      `${chosen.firstName} ${chosen.lastName} is not a natural or rated fit at ${upPos}. ` +
        "In real life this would be an emergency-only assignment. Do you want to proceed anyway?"
    );
    if (!confirmRisk) return;
  }

  if (!currentDepthChart.positions[upPos]) {
    currentDepthChart.positions[upPos] = new Array(MAX_DEPTH_SLOTS).fill(null);
  }

  currentDepthChart.positions[upPos][slotIndex] = chosen.id;
  saveDepthChart(currentDepthChart);
  highlightedPlayerId = chosen.id;

  renderDepthChart();
}

// ---------------------------------------------------------------------------
// Binding – tabs & actions
// ---------------------------------------------------------------------------

function bindUnitTabs() {
  const tabs = document.querySelectorAll(".unit-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const unit = tab.getAttribute("data-unit") || "offense";
      currentUnitFilter = /** @type any */ unit;

      tabs.forEach((t) => t.classList.remove("unit-tab--active"));
      tab.classList.add("unit-tab--active");

      renderDepthChart();
    });
  });
}

function bindTopActions() {
  const buttons = document.querySelectorAll(".top-action-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-action") || "action";
      window.alert(
        `"${action}" is a placeholder in this build. In the full game this would open the ${action} hub.`
      );
    });
  });

  const mainMenuBtn = getEl("btn-go-main-menu");
  if (mainMenuBtn) {
    mainMenuBtn.addEventListener("click", () => {
      window.location.href = "main_page.html";
    });
  }
}

// ---------------------------------------------------------------------------
// No-franchise state handling
// ---------------------------------------------------------------------------

function showNoFranchiseState() {
  const main = getEl("team-main");
  const noFranchise = getEl("no-franchise");
  const topBar = getEl("team-top-bar");
  if (main) main.hidden = true;
  if (topBar) topBar.hidden = true;
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
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    csvText = await resp.text();
  } catch (err) {
    console.error("[Franchise GM] Failed to load roster CSV:", err);
    renderHeader();
    const offense = getEl("offense-formation");
    if (offense) {
      offense.textContent =
        "Failed to load roster data. Check the CSV URL or your network.";
    }
    bindUnitTabs();
    bindTopActions();
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

  renderHeader();
  renderDepthChart();
  bindUnitTabs();
  bindTopActions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTeamPage);
} else {
  initTeamPage();
}