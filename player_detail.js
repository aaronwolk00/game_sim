// player_detail.js
//
// Franchise GM – Player Detail & Reports
//
// Loads:
// - FranchiseSave (franchiseGM_lastFranchise)
// - LeagueState (franchiseGM_leagueState_<franchiseId>)
// - Depth chart (franchiseGM_depthChart_<franchiseId>)
// - layer3_rosters.csv (same source as team.js)
//
// Identifies a player by ?playerId=<id>, then renders:
// - Header (name, pos, archetype, tier, quick tagline)
// - Scouting report text
// - Usage & production (season stats, if present)
// - Team context (depth chart slot, role)
// - Personality / intangibles (inferred)
// - Injury notes (stubbed for future injury model)

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
 * @property {Object} [schedule]
 * @property {{ updatedThroughWeekIndex0?: number|null, teams?: Object, players?: Object }} [seasonStats]
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

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__player_detail";
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

// ---------------------------------------------------------------------------
// CSV helpers (mirroring team.js)
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

/**
 * Convert a raw CSV row into a normalized Player object.
 * (Same logic as team.js – keep in sync.)
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
// Shared helpers (mirroring team.js behavior)
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
  const phase = save.phase || "Regular Season";
  return `${save.seasonYear} • ${phase}`;
}

function depthLabelForIndex(idx) {
  if (idx === 0) return "Starter";
  if (idx === 1) return "2nd";
  if (idx === 2) return "3rd";
  return `${idx + 1}th`;
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;
/** @type {DepthChartState|null} */
let currentDepthChart = null;
/** @type {Player[]} */
let currentRoster = [];
/** @type {Player|null} */
let currentPlayer = null;
/** @type {Object|null} */
let currentPlayerSeasonStats = null;

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

/**
 * Try to find a seasonStats.players row matching this player.
 * Uses teamCode + full name, with a last-name fallback.
 */
function findSeasonStatsRowForPlayer(player, leagueState) {
  if (!leagueState || !leagueState.seasonStats || !leagueState.seasonStats.players) {
    return null;
  }
  const statsPlayers = Object.values(leagueState.seasonStats.players);
  const fullName = `${player.firstName} ${player.lastName}`.trim();
  const lastName = player.lastName.trim();
  const teamCode = (player.teamId || player.teamCode || "").toUpperCase();

  let candidate = null;
  for (const row of statsPlayers) {
    if (!row) continue;
    const rowName = (row.name || "").trim();
    const rowTeam = (row.teamCode || "").toUpperCase();
    if (rowTeam !== teamCode) continue;

    if (rowName === fullName) {
      return row;
    }
    const rowLast = rowName.split(" ").slice(-1)[0];
    if (!candidate && rowLast === lastName) {
      candidate = row;
    }
  }
  return candidate;
}

/**
 * Derive a rough role label from rating tier + depth index + position.
 */
function deriveRoleLabel(player, depthIndex, statsRow) {
  const rating = player.ratingPos ?? player.ratingOverall ?? null;
  const tier = ratingToTierLabel(rating);
  const pos = (player.naturalPos || "").toUpperCase();

  const gamesPlayed = statsRow?.games ?? statsRow?.gp ?? null;
  const volume =
    (statsRow?.rushAtt || 0) +
    (statsRow?.passAtt || 0) +
    (statsRow?.targets || 0) +
    (statsRow?.receptions || 0);

  const highUsage = gamesPlayed && gamesPlayed >= 8 && volume && volume >= 80;
  const veryLowUsage = !volume || volume < 10;

  if (depthIndex === 0) {
    if (tier === "Elite" || tier === "Pro bowl caliber") {
      return "Franchise pillar";
    }
    if (tier === "High-end starter" || tier === "Solid starter") {
      return "Locked-in starter";
    }
    if (tier === "Spot starter") {
      return "Starter on a pitch count";
    }
  }

  if (depthIndex === 1) {
    if (tier === "High-end starter" || tier === "Solid starter") {
      return "Overqualified 2nd-string";
    }
    return "Rotational piece";
  }

  if (depthIndex >= 2) {
    if (tier === "Reliable depth" || tier === "Depth piece") {
      return "Depth / special teams";
    }
    return "Camp / injury cover";
  }

  // If we reach here, either not on depth chart or special case
  if (veryLowUsage) {
    return "Developmental / inactive most weeks";
  }

  if (highUsage) {
    if (pos === "RB" || pos === "WR" || pos === "TE") {
      return "Featured skill player";
    }
    if (pos === "QB") return "Primary backup pressed into duty";
    return "Heavy snap contributor";
  }

  return "Role player";
}

/**
 * Simple inferred personality text.
 */
function derivePersonalityText(player, depthIndex) {
  const rating = player.ratingPos ?? player.ratingOverall ?? null;
  const tier = ratingToTierLabel(rating);
  const pos = (player.naturalPos || "").toUpperCase();
  const archetypeLabel = archetypeToLabel(player.primaryArchetype, player.naturalPos);

  const bullets = [];

  // Work ethic / preparation
  if (tier === "Elite" || tier === "Pro bowl caliber") {
    bullets.push(
      "Ultra-competitive and sets the tone for his position room. Rarely accepts anything less than top-tier execution."
    );
  } else if (tier === "High-end starter" || tier === "Solid starter") {
    bullets.push(
      "Steady, professional approach. Preparation shows up in consistent week-to-week performance."
    );
  } else if (tier === "Depth piece" || tier === "Camp body") {
    bullets.push(
      "Fighting to stick on the roster. Coaches will lean on his attitude and versatility to carve out a role."
    );
  } else {
    bullets.push(
      "Day-to-day habits are trending in the right direction, but there’s still room to sharpen consistency."
    );
  }

  // Style / confidence by position archetype
  if (pos === "WR") {
    bullets.push(
      `${archetypeLabel || "Receiver"} plays with noticeable swagger – thrives on big moments but can press if touches dry up.`
    );
  } else if (pos === "RB") {
    bullets.push(
      "Physical runner who responds well to volume. Confidence grows as he gets into a rhythm over four quarters."
    );
  } else if (pos === "QB") {
    bullets.push(
      "Quarterback demeanor is calm and composed. Will challenge windows when he trusts the picture, but generally plays within structure."
    );
  } else if (pos === "CB" || pos === "S") {
    bullets.push(
      "Back-end defender with a short memory. Competitive at the catch point and doesn’t shy away from tough assignments."
    );
  } else if (pos === "EDGE" || pos === "DT" || pos === "LB") {
    bullets.push(
      "Front-seven motor runs hot. Effort shows up chasing plays down and on long drives late in games."
    );
  }

  // Locker room / leadership feel from depth
  if (depthIndex === 0) {
    bullets.push(
      "Seen as a tone-setter for the unit. Younger players tend to mirror his body language throughout the week."
    );
  } else if (depthIndex === 1) {
    bullets.push(
      "Respected voice in the room who understands his role. Can steady a drive or a series when called upon."
    );
  } else if (depthIndex >= 2) {
    bullets.push(
      "Energy player whose value often shows up on scout team and in special-teams meetings."
    );
  }

  return bullets;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderHeader() {
  if (!currentPlayer || !currentFranchiseSave) return;

  const teamLabelEl = getEl("top-team-label");
  const seasonLabelEl = getEl("top-season-label");
  const nameEl = getEl("player-name");
  const posArchEl = getEl("player-pos-arch");
  const tierChipEl = getEl("player-tier-chip");
  const roleChipEl = getEl("player-role-chip");
  const depthChipEl = getEl("player-depth-chip");
  const taglineEl = getEl("player-tagline");
  const footerEl = getEl("player-header-footer");

  const teamName = getTeamDisplayNameFromSave(currentFranchiseSave);
  const seasonLine = formatSeasonLabel(currentFranchiseSave);
  if (teamLabelEl) teamLabelEl.textContent = teamName;
  if (seasonLabelEl) seasonLabelEl.textContent = seasonLine;

  if (nameEl) {
    nameEl.textContent = `${currentPlayer.firstName} ${currentPlayer.lastName}`.trim();
  }

  const archLabel = archetypeToLabel(
    currentPlayer.primaryArchetype,
    currentPlayer.naturalPos
  );
  if (posArchEl) {
    const pos = (currentPlayer.naturalPos || "").toUpperCase();
    posArchEl.textContent = archLabel
      ? `${pos} • ${archLabel}`
      : pos || "Position";
  }

  // Depth + role for chips
  const depthInfo = findPlayerDepthInfo(currentPlayer, currentDepthChart);
  const depthLabel =
    depthInfo && Number.isFinite(depthInfo.depthIndex)
      ? `${depthLabelForIndex(depthInfo.depthIndex)} ${depthInfo.pos}`
      : "Off-chart / flexible";

  const rating = currentPlayer.ratingPos ?? currentPlayer.ratingOverall ?? null;
  const tierLabel = ratingToTierLabel(rating);
  const roleLabel = deriveRoleLabel(
    currentPlayer,
    depthInfo?.depthIndex ?? -1,
    currentPlayerSeasonStats
  );

  if (tierChipEl) tierChipEl.textContent = tierLabel;
  if (roleChipEl) roleChipEl.textContent = roleLabel;
  if (depthChipEl) depthChipEl.textContent = depthLabel;

  // Tagline – short scouting one-liner
  const pos = (currentPlayer.naturalPos || "").toUpperCase();
  let tagline = "";

  if (pos === "QB") {
    tagline =
      tierLabel === "Elite" || tierLabel === "Pro bowl caliber"
        ? "High-end starter at quarterback with enough arm talent and processing to carry a passing game."
        : "Quarterback with functional tools who fits best in a defined structure and rhythm passing game.";
  } else if (pos === "RB") {
    tagline =
      "Back who can handle early-down volume and contribute as a finisher near the goal line when the blocking is there.";
  } else if (pos === "WR" || pos === "TE") {
    tagline =
      "Pass-game weapon whose value spikes when the offense creates matchups and lets him attack his best leverage.";
  } else if (pos === "EDGE" || pos === "DT") {
    tagline =
      "Front-seven defender who can tilt downs when he wins the first two steps and converts speed to power.";
  } else if (pos === "CB" || pos === "S") {
    tagline =
      "Back-end defender who plays with competitive toughness and flashes when the ball is in the air.";
  } else {
    tagline =
      "Contributor whose impact depends heavily on role clarity and how the staff chooses to deploy him.";
  }

  if (taglineEl) taglineEl.textContent = tagline;

  if (footerEl) {
    const record = (currentFranchiseSave.record || "").trim() || "0–0";
    const phase = currentFranchiseSave.phase || "Regular Season";
    footerEl.textContent = `${teamName} • Record ${record} • ${phase}`;
  }
}

/**
 * Find primary depth chart info for this player.
 * @returns {{ pos: string, depthIndex: number } | null}
 */
function findPlayerDepthInfo(player, depthChart) {
  if (!player || !depthChart || !depthChart.positions) return null;

  const matches = [];
  for (const [pos, slots] of Object.entries(depthChart.positions)) {
    const idx = (slots || []).indexOf(player.id);
    if (idx !== -1) {
      matches.push({ pos, depthIndex: idx });
    }
  }

  if (!matches.length) return null;

  const nat = (player.naturalPos || "").toUpperCase();
  const natMatch = matches.find((m) => m.pos.toUpperCase() === nat);
  if (natMatch) return natMatch;

  matches.sort((a, b) => a.depthIndex - b.depthIndex);
  return matches[0];
}

function renderScoutingSection() {
  const el = getEl("scouting-body");
  if (!el || !currentPlayer) return;

  const pos = (currentPlayer.naturalPos || "").toUpperCase();
  const tier = ratingToTierLabel(
    currentPlayer.ratingPos ?? currentPlayer.ratingOverall ?? null
  );
  const archLabel = archetypeToLabel(
    currentPlayer.primaryArchetype,
    currentPlayer.naturalPos
  );
  const depthInfo = findPlayerDepthInfo(currentPlayer, currentDepthChart);

  const bulletLines = [];

  // How he wins
  if (pos === "QB") {
    bulletLines.push(
      "Operates best when the picture is clear pre-snap and he can work through defined progressions.",
      "Accuracy is more reliable in the short-to-intermediate windows than when pushing the ball late downfield."
    );
  } else if (pos === "RB") {
    bulletLines.push(
      "Runs with balanced pad level and enough contact balance to finish runs falling forward.",
      "Shows feel for pressing the aiming point before cutting, especially behind zone concepts."
    );
  } else if (pos === "WR") {
    bulletLines.push(
      `${archLabel || "Receiver"} wins when he gets a clean release and can build speed into his stem.`,
      "Hands are generally trustworthy, though ball security and contested-catch consistency can still tick up."
    );
  } else if (pos === "TE") {
    bulletLines.push(
      "Hybrid tight end who can move around the formation – inline, in the slot, or detached.",
      "Blocking effort is there, but technique and anchor versus true power still fluctuate drive to drive."
    );
  } else if (pos === "EDGE" || pos === "DT") {
    bulletLines.push(
      "Flashes real disruption when he times the snap and wins half a man off the line.",
      "Can muddy the pocket or reset the line of scrimmage, but needs a consistent rush plan versus top tackles."
    );
  } else if (pos === "LB") {
    bulletLines.push(
      "Plays downhill with intent and will trigger quickly versus run keys.",
      "Range is adequate; man coverage versus true space athletes is still a stress point."
    );
  } else if (pos === "CB" || pos === "S") {
    bulletLines.push(
      "Shows comfort playing with vision on the quarterback in zone concepts.",
      "Transition and long speed are good enough when his technique is clean at the line."
    );
  } else {
    bulletLines.push(
      "Skill set is serviceable across multiple roles, giving the staff flexibility when injuries or game plans shift."
    );
  }

  // Ideal usage based on depth + tier
  const depthIndex = depthInfo?.depthIndex ?? -1;
  if (depthIndex === 0) {
    bulletLines.push(
      "Best deployed as a true starter – plan weekly game scripts assuming he will carry a significant share of snaps."
    );
  } else if (depthIndex === 1) {
    bulletLines.push(
      "Ideal usage is as a heavy rotational piece, keeping him fresh while still letting him influence critical downs."
    );
  } else if (depthIndex >= 2) {
    bulletLines.push(
      "Profile fits more as depth and special-teams support unless injuries or matchups force him into extended duty."
    );
  } else {
    bulletLines.push(
      "Role will be determined by how quickly he gains staff trust and stacks consistent weeks of practice and tape."
    );
  }

  // Tier-dependent note
  if (tier === "Elite" || tier === "Pro bowl caliber") {
    bulletLines.push(
      "Game plans should lean into his strengths rather than just fitting him into the existing playbook."
    );
  } else if (tier === "High-end starter" || tier === "Solid starter") {
    bulletLines.push(
      "Can hold up as the backbone of his position group – capable of handling playoff-level competition."
    );
  } else if (tier === "Spot starter" || tier === "Reliable depth") {
    bulletLines.push(
      "If you manage the matchups and volume, he can give starter-quality snaps in the right windows."
    );
  } else {
    bulletLines.push(
      "Needs reps and a clearly defined role to show his best; asking him to be a do-everything piece will dilute his impact."
    );
  }

  const firstLine = document.createElement("div");
  firstLine.textContent = `${tier} ${pos || ""}${archLabel ? " • " + archLabel : ""}`;
  el.innerHTML = "";
  el.appendChild(firstLine);

  const ul = document.createElement("ul");
  bulletLines.forEach((txt) => {
    const li = document.createElement("li");
    li.textContent = txt;
    ul.appendChild(li);
  });
  el.appendChild(ul);
}

function renderUsageSection() {
  const summaryEl = getEl("usage-summary");
  const noteEl = getEl("usage-note");
  if (!summaryEl || !currentPlayer) return;

  summaryEl.innerHTML = "";
  if (!currentPlayerSeasonStats) {
    const msg = document.createElement("div");
    msg.className = "muted";
    msg.textContent =
      "No season stats recorded yet for this player. This panel will populate once games have been simulated and season stats are rebuilt.";
    summaryEl.appendChild(msg);
    if (noteEl) {
      noteEl.textContent =
        "Season stats read from leagueState.seasonStats.players and are keyed by whatever identity your stats pipeline uses.";
    }
    return;
  }

  const s = currentPlayerSeasonStats;
  const pos = (currentPlayer.naturalPos || "").toUpperCase();

  const row = document.createElement("div");
  row.className = "usage-summary-row";

  function addMetric(label, value) {
    if (value == null) return;
    const span = document.createElement("span");
    span.className = "usage-metric";
    span.textContent = `${label}: ${value}`;
    row.appendChild(span);
  }

  // Generic games / touches
  const games = s.games ?? s.gp ?? null;
  if (games != null) addMetric("Games", games);

  // Passing
  if (s.passAtt || s.passYds || s.passTD || s.passInt) {
    const att = s.passAtt || 0;
    const yds = s.passYds || 0;
    const tds = s.passTD || 0;
    const ints = s.passInt || 0;
    const ypa = att ? (yds / att).toFixed(1) : "—";
    addMetric("Pass Yds", yds);
    addMetric("TD", tds);
    addMetric("INT", ints);
    addMetric("YPA", ypa);
  }

  // Rushing
  if (s.rushAtt || s.rushYds || s.rushTD) {
    const att = s.rushAtt || 0;
    const yds = s.rushYds || 0;
    const tds = s.rushTD || 0;
    const ypc = att ? (yds / att).toFixed(1) : "—";
    addMetric("Rush Yds", yds);
    addMetric("Rush TD", tds);
    addMetric("YPC", ypc);
  }

  // Receiving
  if (s.receptions || s.targets || s.recYds || s.recTD) {
    const rec = s.receptions || 0;
    const tgt = s.targets || 0;
    const yds = s.recYds || 0;
    const tds = s.recTD || 0;
    const ypt = tgt ? (yds / tgt).toFixed(1) : "—";
    addMetric("Rec", rec);
    addMetric("Targets", tgt);
    addMetric("Rec Yds", yds);
    addMetric("Rec TD", tds);
    addMetric("Yards/Target", ypt);
  }

  // Kicking
  if (s.fgAtt || s.fgMade || s.xpAtt || s.xpMade) {
    if (s.fgAtt != null) addMetric("FGM / FGA", `${s.fgMade || 0}/${s.fgAtt}`);
    if (s.xpAtt != null) addMetric("XPM / XPA", `${s.xpMade || 0}/${s.xpAtt}`);
  }

  summaryEl.appendChild(row);

  if (noteEl) {
    noteEl.textContent =
      "This summary is season-to-date and is aggregated from leagueState.seasonStats.players.";
  }
}

function renderTeamContext() {
  const listEl = getEl("team-context-list");
  if (!listEl || !currentPlayer || !currentFranchiseSave) return;

  listEl.innerHTML = "";

  const liRole = document.createElement("li");
  const liDepth = document.createElement("li");
  const liUsage = document.createElement("li");

  const depthInfo = findPlayerDepthInfo(currentPlayer, currentDepthChart);
  const depthLabel =
    depthInfo && Number.isFinite(depthInfo.depthIndex)
      ? `${depthLabelForIndex(depthInfo.depthIndex)} at ${depthInfo.pos}`
      : "Not currently slotted on the depth chart";

  const roleLabel = deriveRoleLabel(
    currentPlayer,
    depthInfo?.depthIndex ?? -1,
    currentPlayerSeasonStats
  );

  const totalTouches =
    (currentPlayerSeasonStats?.rushAtt || 0) +
    (currentPlayerSeasonStats?.targets || 0) +
    (currentPlayerSeasonStats?.receptions || 0) +
    (currentPlayerSeasonStats?.passAtt || 0);

  let usageLine = "Usage will update as more games are played.";
  if (totalTouches >= 120) {
    usageLine = "Featured option in the current game plan – volume justifies keeping him central to weekly scripts.";
  } else if (totalTouches >= 50) {
    usageLine = "Active part of the rotation whose touches should be managed based on matchups and game flow.";
  } else if (totalTouches > 0) {
    usageLine = "Lightly used to this point; a spike in volume would represent a clear philosophical shift.";
  } else if (!currentPlayerSeasonStats) {
    usageLine = "No recorded touches yet – usage profile is still being established.";
  }

  liRole.innerHTML = `
    <span class="context-label">Role</span>
    <span class="context-value-strong">${roleLabel}</span>
  `;
  liDepth.innerHTML = `
    <span class="context-label">Depth chart</span>
    <span>${depthLabel}</span>
  `;
  liUsage.innerHTML = `
    <span class="context-label">Game-day usage</span>
    <span>${usageLine}</span>
  `;

  listEl.appendChild(liRole);
  listEl.appendChild(liDepth);
  listEl.appendChild(liUsage);
}

function renderPersonality() {
  const el = getEl("personality-body");
  if (!el || !currentPlayer) return;

  const depthInfo = findPlayerDepthInfo(currentPlayer, currentDepthChart);
  const depthIndex = depthInfo?.depthIndex ?? -1;
  const bullets = derivePersonalityText(currentPlayer, depthIndex);

  el.innerHTML = "";
  const ul = document.createElement("ul");
  bullets.forEach((txt) => {
    const li = document.createElement("li");
    li.textContent = txt;
    ul.appendChild(li);
  });
  el.appendChild(ul);
}

function renderInjuryNotes() {
  const el = getEl("injury-body");
  if (!el) return;
  el.innerHTML = "";

  const p = document.createElement("p");
  p.className = "muted";
  p.textContent =
    "No dedicated injury model is wired in yet. Once injury data is added to LeagueState, this panel will surface current status and recent history.";
  el.appendChild(p);
}

// ---------------------------------------------------------------------------
// Navigation / state fallbacks
// ---------------------------------------------------------------------------

function showNoFranchiseState() {
  const playerPage = getEl("player-page");
  const nf = getEl("no-franchise-state");
  if (playerPage) playerPage.hidden = true;
  if (nf) nf.hidden = false;

  const btn = getEl("btn-go-main-menu-fallback");
  if (btn) {
    btn.addEventListener("click", () => {
      window.location.href = "index.html";
    });
  }
}

function showPlayerNotFoundState(playerId) {
  const playerPage = getEl("player-page");
  const nf = getEl("player-not-found-state");
  if (playerPage) playerPage.hidden = true;
  if (nf) nf.hidden = false;

  const msg = getEl("player-not-found-message");
  if (msg) {
    msg.textContent = playerId
      ? `We couldn't find a player with id "${playerId}" on your active roster.`
      : "No playerId was provided in the URL. Open this screen from the team formation page.";
  }

  const backBtn = getEl("btn-back-from-missing");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = "team.html";
      }
    });
  }
}

function bindBackButton() {
  const backBtn = getEl("btn-back-team");
  if (!backBtn) return;
  backBtn.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = "team.html";
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function initPlayerDetailPage() {
  const save = loadLastFranchise();
  if (!save) {
    showNoFranchiseState();
    return;
  }
  currentFranchiseSave = save;
  currentLeagueState = loadLeagueState(save.franchiseId) || null;
  currentDepthChart = loadDepthChart(save.franchiseId) || null;

  const params = new URLSearchParams(window.location.search);
  const playerId = params.get("playerId");
  if (!playerId) {
    showPlayerNotFoundState(null);
    return;
  }

  // Load roster for this team
  let csvText;
  try {
    const resp = await fetch(ROSTERS_CSV_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    csvText = await resp.text();
  } catch (err) {
    console.error("[Franchise GM] Failed to load roster CSV on player detail:", err);
    showPlayerNotFoundState(playerId);
    return;
  }

  const rawRows = parseSimpleCsv(csvText);
  const teamCode = (save.teamCode || "").toUpperCase();
  currentRoster = rawRows
    .map(playerFromCsvRow)
    .filter((p) => p.teamId.toUpperCase() === teamCode);

  currentPlayer =
    currentRoster.find((p) => p.id === playerId) ||
    null;

  if (!currentPlayer) {
    showPlayerNotFoundState(playerId);
    return;
  }

  currentPlayerSeasonStats = findSeasonStatsRowForPlayer(
    currentPlayer,
    currentLeagueState
  );

  // Show main page and render
  const page = getEl("player-page");
  if (page) page.hidden = false;
  const nf = getEl("no-franchise-state");
  if (nf) nf.hidden = true;
  const nf2 = getEl("player-not-found-state");
  if (nf2) nf2.hidden = true;

  renderHeader();
  renderScoutingSection();
  renderUsageSection();
  renderTeamContext();
  renderPersonality();
  renderInjuryNotes();
  bindBackButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPlayerDetailPage);
} else {
  initPlayerDetailPage();
}
