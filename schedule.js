// schedule.js
//
// Franchise GM – Season Schedule / Calendar
//
// Responsibilities:
// - Load the current FranchiseSave summary from localStorage.
// - Load or create a LeagueState object for this franchise.
// - Ensure an NFL-style schedule exists (per-team schedule, by season).
// - Render:
//   * Header (team name + season line).
//   * Left side: week-by-week list for the user's team.
//   * Right side: details for the selected week.
//   * Scope toggle: My Team / League (league view is stubbed for now).
//
// Notes:
// - Schedule generation uses an NFL-style 16-game rotation:
//     * 6 division games (home/away vs 3 rivals)
//     * 4 games vs one same-conference division (rotating 3-year cycle)
//     * 4 games vs one opposite-conference division (rotating 4-year cycle)
//     * 2 same-conference “extra” games vs teams from the remaining divisions
//   This mirrors the classic NFL structure; the modern 17th game is a TODO.
// - Weeks are treated as game index (Week 1..16) for now. Real bye logic
//   can be layered on later.
//
// Assumes schedule.html has (key IDs):
//   - Header:
//       #team-name-heading
//       #season-phase-line
//   - Scope toggle:
//       #btn-scope-my-team
//       #btn-scope-league
//   - Week list card:
//       #week-list
//   - Week detail card:
//       #week-detail-title
//       #week-detail-opponent
//       #week-detail-meta
//       #week-detail-result
//       #week-detail-record-line
//       #btn-week-gameday
//       #btn-week-boxscore
//   - View mode hint:
//       #schedule-view-mode-label
//   - Back to hub:
//       #btn-back-hub
//
// If something is missing, the code fails gracefully.

// ---------------------------------------------------------------------------
// Shared types (documentation only)
// ---------------------------------------------------------------------------

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
 * @property {Object} gmJob
 * @property {Object} leagueSummary
 * @property {Object} realismOptions
 * @property {Object} ownerExpectation
 * @property {number} gmCredibility
 */

/**
 * @typedef {Object} TeamGame
 * @property {number} index           // 0-based index in schedule
 * @property {number} seasonWeek      // 1-based user facing week label
 * @property {string} teamCode        // our team
 * @property {string} opponentCode
 * @property {boolean} isHome
 * @property {"division"|"conference"|"nonconference"|"extra"} type
 * @property {string|null} kickoffIso
 * @property {"scheduled"|"final"} status
 * @property {number|null} teamScore
 * @property {number|null} opponentScore
 */

/**
 * @typedef {Object} LeagueSchedule
 * @property {number} seasonYear
 * @property {Object.<string, TeamGame[]>} byTeam
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
 * @property {LeagueSchedule} [schedule]
 */

// ---------------------------------------------------------------------------
// Storage keys & helpers
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

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

function saveLeagueState(state) {
  if (!storageAvailable() || !state || !state.franchiseId) return;
  try {
    window.localStorage.setItem(
      getLeagueStateKey(state.franchiseId),
      JSON.stringify(state)
    );
  } catch (err) {
    console.warn("[Franchise GM] Failed to save league state:", err);
  }
}

// ---------------------------------------------------------------------------
// Team metadata (conference / division / city / name)
// ---------------------------------------------------------------------------

/**
 * Minimal team metadata needed for schedule generation.
 */
const TEAM_META = [
  // AFC East
  { teamCode: "BUF", city: "Buffalo", name: "Bills", conference: "AFC", division: "East" },
  { teamCode: "MIA", city: "Miami", name: "Dolphins", conference: "AFC", division: "East" },
  { teamCode: "NE",  city: "New England", name: "Patriots", conference: "AFC", division: "East" },
  { teamCode: "NYJ", city: "New York", name: "Jets", conference: "AFC", division: "East" },

  // AFC North
  { teamCode: "BAL", city: "Baltimore", name: "Ravens", conference: "AFC", division: "North" },
  { teamCode: "CIN", city: "Cincinnati", name: "Bengals", conference: "AFC", division: "North" },
  { teamCode: "CLE", city: "Cleveland", name: "Browns", conference: "AFC", division: "North" },
  { teamCode: "PIT", city: "Pittsburgh", name: "Steelers", conference: "AFC", division: "North" },

  // AFC South
  { teamCode: "HOU", city: "Houston", name: "Texans", conference: "AFC", division: "South" },
  { teamCode: "IND", city: "Indianapolis", name: "Colts", conference: "AFC", division: "South" },
  { teamCode: "JAX", city: "Jacksonville", name: "Jaguars", conference: "AFC", division: "South" },
  { teamCode: "TEN", city: "Tennessee", name: "Titans", conference: "AFC", division: "South" },

  // AFC West
  { teamCode: "DEN", city: "Denver", name: "Broncos", conference: "AFC", division: "West" },
  { teamCode: "KC",  city: "Kansas City", name: "Chiefs", conference: "AFC", division: "West" },
  { teamCode: "LV",  city: "Las Vegas", name: "Raiders", conference: "AFC", division: "West" },
  { teamCode: "LAC", city: "Los Angeles", name: "Chargers", conference: "AFC", division: "West" },

  // NFC East
  { teamCode: "DAL", city: "Dallas", name: "Cowboys", conference: "NFC", division: "East" },
  { teamCode: "NYG", city: "New York", name: "Giants", conference: "NFC", division: "East" },
  { teamCode: "PHI", city: "Philadelphia", name: "Eagles", conference: "NFC", division: "East" },
  { teamCode: "WAS", city: "Washington", name: "Commanders", conference: "NFC", division: "East" },

  // NFC North
  { teamCode: "CHI", city: "Chicago", name: "Bears", conference: "NFC", division: "North" },
  { teamCode: "DET", city: "Detroit", name: "Lions", conference: "NFC", division: "North" },
  { teamCode: "GB",  city: "Green Bay", name: "Packers", conference: "NFC", division: "North" },
  { teamCode: "MIN", city: "Minnesota", name: "Vikings", conference: "NFC", division: "North" },

  // NFC South
  { teamCode: "ATL", city: "Atlanta", name: "Falcons", conference: "NFC", division: "South" },
  { teamCode: "CAR", city: "Carolina", name: "Panthers", conference: "NFC", division: "South" },
  { teamCode: "NO",  city: "New Orleans", name: "Saints", conference: "NFC", division: "South" },
  { teamCode: "TB",  city: "Tampa Bay", name: "Buccaneers", conference: "NFC", division: "South" },

  // NFC West
  { teamCode: "ARI", city: "Arizona", name: "Cardinals", conference: "NFC", division: "West" },
  { teamCode: "LAR", city: "Los Angeles", name: "Rams", conference: "NFC", division: "West" },
  { teamCode: "SF",  city: "San Francisco", name: "49ers", conference: "NFC", division: "West" },
  { teamCode: "SEA", city: "Seattle", name: "Seahawks", conference: "NFC", division: "West" }
];

const DIVISION_NAMES = ["East", "North", "South", "West"];

function getTeamMeta(teamCode) {
  return TEAM_META.find((t) => t.teamCode === teamCode) || null;
}

function getDivisionTeams(conference, division) {
  return TEAM_META
    .filter(
      (t) =>
        t.conference === conference &&
        t.division === division
    )
    .map((t) => t.teamCode);
}

function getTeamDisplayName(teamCode) {
  const meta = getTeamMeta(teamCode);
  if (!meta) return teamCode || "Unknown Team";
  return `${meta.city} ${meta.name}`;
}

// ---------------------------------------------------------------------------
// NFL-style rotation helpers (16-game era style)
// ---------------------------------------------------------------------------

// 3-year intra-conference division rotation for each conference.
// Example (yearIdx = 0 is an arbitrary anchor):
//   - Year 0: East vs West, North vs South
//   - Year 1: East vs North, South vs West
//   - Year 2: East vs South, North vs West
const SAME_CONF_ROTATION = {
  AFC: [
    { East: "West", West: "East", North: "South", South: "North" },
    { East: "North", North: "East", South: "West", West: "South" },
    { East: "South", South: "East", North: "West", West: "North" }
  ],
  NFC: [
    { East: "West", West: "East", North: "South", South: "North" },
    { East: "North", North: "East", South: "West", West: "South" },
    { East: "South", South: "East", North: "West", West: "North" }
  ]
};

// 4-year cross-conference rotation. We compute this algorithmically:
// treat divisions as indices 0..3 and rotate.
function getCrossConferenceDivision(conference, division, seasonYear) {
  const baseYear = 2022; // arbitrary anchor
  const offsetRaw = (seasonYear - baseYear) % 4;
  const offset = offsetRaw < 0 ? offsetRaw + 4 : offsetRaw;

  const divIndex = DIVISION_NAMES.indexOf(division);
  if (divIndex < 0) return "East";

  const oppIndex = (divIndex + offset) % 4;
  return DIVISION_NAMES[oppIndex];
}

function getSameConferenceOppDivision(conference, division, seasonYear) {
  const rotations = SAME_CONF_ROTATION[conference];
  if (!rotations) return "East";
  const baseYear = 2023;
  const rawIdx = (seasonYear - baseYear) % rotations.length;
  const idx = rawIdx < 0 ? rawIdx + rotations.length : rawIdx;
  const config = rotations[idx];
  return config[division] || division;
}

// ---------------------------------------------------------------------------
// Schedule generation (per team, 16 games)
// ---------------------------------------------------------------------------

/**
 * Generate a 16-game NFL-style schedule for a single team.
 * This does NOT currently coordinate opponents across the entire league;
 * it's deterministic for the given teamCode + seasonYear and structurally
 * realistic enough for front-office use.
 *
 * @param {string} teamCode
 * @param {number} seasonYear
 * @returns {TeamGame[]}
 */
function generateTeamSchedule(teamCode, seasonYear) {
  const meta = getTeamMeta(teamCode);
  if (!meta) {
    console.warn("[Franchise GM] generateTeamSchedule: unknown team", teamCode);
    return [];
  }

  const conference = meta.conference;
  const division = meta.division;

  const divTeams = getDivisionTeams(conference, division);
  const selfIndex = divTeams.indexOf(teamCode);

  if (selfIndex < 0) {
    console.warn("[Franchise GM] generateTeamSchedule: team not found in division", teamCode);
    return [];
  }

  /** @type {TeamGame[]} */
  const games = [];

  // --- 1) Division games (home & away vs each rival) – 6 games
  divTeams.forEach((opCode, idx) => {
    if (opCode === teamCode) return;
    const homeFirst = selfIndex <= idx;

    games.push({
      index: -1,
      seasonWeek: 0,
      teamCode,
      opponentCode: opCode,
      isHome: homeFirst,
      type: "division",
      kickoffIso: null,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
    games.push({
      index: -1,
      seasonWeek: 0,
      teamCode,
      opponentCode: opCode,
      isHome: !homeFirst,
      type: "division",
      kickoffIso: null,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
  });

  // --- 2) Same-conference rotation division – 4 games
  const sameConfDivision = getSameConferenceOppDivision(
    conference,
    division,
    seasonYear
  );
  const sameConfTeams = getDivisionTeams(conference, sameConfDivision);

  sameConfTeams.forEach((opCode, idx) => {
    const isHome = ((seasonYear + selfIndex + idx) & 1) === 0;
    games.push({
      index: -1,
      seasonWeek: 0,
      teamCode,
      opponentCode: opCode,
      isHome,
      type: "conference",
      kickoffIso: null,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
  });

  // --- 3) Cross-conference rotation division – 4 games
  const otherConference = conference === "AFC" ? "NFC" : "AFC";
  const crossDivision = getCrossConferenceDivision(
    conference,
    division,
    seasonYear
  );
  const crossTeams = getDivisionTeams(otherConference, crossDivision);

  crossTeams.forEach((opCode, idx) => {
    const isHome = ((seasonYear + idx) & 1) === 0;
    games.push({
      index: -1,
      seasonWeek: 0,
      teamCode,
      opponentCode: opCode,
      isHome,
      type: "nonconference",
      kickoffIso: null,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
  });

  // --- 4) Extra same-conference games vs the remaining two divisions – 2 games
  const remainingDivisions = DIVISION_NAMES.filter(
    (d) => d !== division && d !== sameConfDivision
  );
  remainingDivisions.forEach((otherDiv, idx) => {
    const otherDivTeams = getDivisionTeams(conference, otherDiv);
    if (!otherDivTeams.length) return;
    const opIdx = selfIndex % otherDivTeams.length;
    const opCode = otherDivTeams[opIdx];
    const isHome = ((seasonYear + idx + selfIndex) & 1) === 0;

    games.push({
      index: -1,
      seasonWeek: 0,
      teamCode,
      opponentCode: opCode,
      isHome,
      type: "extra",
      kickoffIso: null,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
  });

  // Should have 16 total games
  if (games.length !== 16) {
    console.warn(
      "[Franchise GM] Unexpected game count for schedule",
      teamCode,
      "season",
      seasonYear,
      "count=",
      games.length
    );
  }

  // --- Order games into a plausible weekly flow, then assign weeks & dates ---

  const divisionGames = games.filter((g) => g.type === "division");
  const confGames = games.filter((g) => g.type === "conference");
  const nonConfGames = games.filter((g) => g.type === "nonconference");
  const extraGames = games.filter((g) => g.type === "extra");

  /** @type {TeamGame[]} */
  const ordered = [];

  // Basic pattern:
  //   Weeks 1–4: mix non-conf + conference
  //   Weeks 5–8: division-heavy
  //   Weeks 9–12: mix all types
  //   Weeks 13–16: division & conference
  function pull(list) {
    return list.length ? list.shift() : null;
  }

  // We keep things deterministic by sorting each bucket by opponentCode.
  divisionGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
  confGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
  nonConfGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
  extraGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));

  // Weeks 1–4
  for (let i = 0; i < 4; i++) {
    let g = pull(nonConfGames) || pull(confGames) || pull(extraGames) || pull(divisionGames);
    if (g) ordered.push(g);
  }
  // Weeks 5–8
  for (let i = 0; i < 4; i++) {
    let g = pull(divisionGames) || pull(confGames) || pull(nonConfGames) || pull(extraGames);
    if (g) ordered.push(g);
  }
  // Weeks 9–12
  for (let i = 0; i < 4; i++) {
    let g =
      pull(confGames) ||
      pull(nonConfGames) ||
      pull(divisionGames) ||
      pull(extraGames);
    if (g) ordered.push(g);
  }
  // Weeks 13–16
  while (divisionGames.length || confGames.length || nonConfGames.length || extraGames.length) {
    let g = pull(divisionGames) || pull(confGames) || pull(nonConfGames) || pull(extraGames);
    if (g) ordered.push(g);
  }

  // Assign week indices and simple kickoff times:
  // Approx: Week 1 is second Sunday of September at 1:00 PM.
  const baseDate = new Date(seasonYear, 8, 10, 13, 0, 0, 0); // Sept ~10 at 1 PM

  ordered.forEach((g, idx) => {
    g.index = idx;
    g.seasonWeek = idx + 1;

    const d = new Date(baseDate.getTime());
    d.setDate(baseDate.getDate() + idx * 7);
    g.kickoffIso = d.toISOString();
  });

  return ordered;
}

// ---------------------------------------------------------------------------
// LeagueState schedule integration
// ---------------------------------------------------------------------------

/**
 * Ensure that leagueState.schedule exists and matches the current season.
 * Returns an updated schedule object (mutates leagueState in place).
 *
 * @param {LeagueState} leagueState
 * @param {FranchiseSave} save
 * @returns {LeagueSchedule}
 */
function ensureLeagueSchedule(leagueState, save) {
  const year = save.seasonYear;
  if (!leagueState.schedule || leagueState.schedule.seasonYear !== year) {
    leagueState.schedule = {
      seasonYear: year,
      byTeam: {}
    };
  } else if (!leagueState.schedule.byTeam) {
    leagueState.schedule.byTeam = {};
  }
  return leagueState.schedule;
}

/**
 * Ensure we have a schedule for the user's team in leagueState.schedule.byTeam.
 *
 * @param {LeagueState} leagueState
 * @param {FranchiseSave} save
 * @returns {TeamGame[]}
 */
function ensureTeamSchedule(leagueState, save) {
  const schedule = ensureLeagueSchedule(leagueState, save);
  const teamCode = save.teamCode;
  if (!schedule.byTeam[teamCode]) {
    schedule.byTeam[teamCode] = generateTeamSchedule(teamCode, schedule.seasonYear);
    saveLeagueState(leagueState);
  }
  return schedule.byTeam[teamCode];
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

function formatIsoToNice(iso) {
  if (!iso) return "Date TBA";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date TBA";
  const dayPart = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  return `${dayPart} • ${timePart}`;
}

function parseRecord(recordStr) {
  if (!recordStr || typeof recordStr !== "string") {
    return { wins: 0, losses: 0 };
  }
  const m = recordStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return { wins: 0, losses: 0 };
  return { wins: Number(m[1]) || 0, losses: Number(m[2]) || 0 };
}

function getTeamNameFromSave(save) {
  if (save.teamName) return save.teamName;
  if (save.franchiseName) return save.franchiseName;
  return getTeamDisplayName(save.teamCode || "");
}

function formatSeasonSubline(save) {
  const year = save.seasonYear || "";
  const phase = save.phase || "Regular Season";
  return `${year} • ${phase} • Schedule`;
}

// ---------------------------------------------------------------------------
// Page state (for this view)
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;
/** @type {TeamGame[]} */
let currentTeamSchedule = [];
/** @type {"team"|"league"} */
let currentScope = "team";
/** @type {number} */
let selectedWeekIndex = 0;

// ---------------------------------------------------------------------------
// Rendering – header, week list, detail
// ---------------------------------------------------------------------------

function renderHeader(save) {
  const teamNameEl = getEl("team-name-heading");
  const sublineEl = getEl("season-phase-line");

  if (teamNameEl) {
    teamNameEl.textContent = getTeamNameFromSave(save);
  }
  if (sublineEl) {
    sublineEl.textContent = formatSeasonSubline(save);
  }
}

function renderScopeToggle() {
  const myBtn = getEl("btn-scope-my-team");
  const leagueBtn = getEl("btn-scope-league");
  const labelEl = getEl("schedule-view-mode-label");

  if (myBtn) {
    myBtn.setAttribute("aria-pressed", currentScope === "team" ? "true" : "false");
  }
  if (leagueBtn) {
    leagueBtn.setAttribute("aria-pressed", currentScope === "league" ? "true" : "false");
  }
  if (labelEl) {
    labelEl.textContent =
      currentScope === "team" ? "Viewing: Your team schedule" : "Viewing: League (stubbed)";
  }
}

/**
 * Render left-hand week list based on currentScope.
 * For now, league scope is a stub: we keep showing the team schedule but indicate the mode.
 */
function renderWeekList() {
  const listEl = getEl("week-list");
  if (!listEl) return;

  listEl.innerHTML = "";

  if (currentScope === "league") {
    // Stub: reuse team schedule but label as league view.
    const infoRow = document.createElement("div");
    infoRow.className = "week-list-info-row";
    infoRow.textContent = "League-wide schedule view is not implemented yet. Showing your team instead.";
    listEl.appendChild(infoRow);
  }

  currentTeamSchedule.forEach((game) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "week-row";
    row.dataset.weekIndex = String(game.index);

    if (game.index === selectedWeekIndex) {
      row.classList.add("week-row--selected");
    }

    const topLine = document.createElement("div");
    topLine.className = "week-row-top";
    topLine.textContent = `Week ${game.seasonWeek} • ${
      game.isHome ? "vs" : "at"
    } ${getTeamDisplayName(game.opponentCode)}`;

    const bottomLine = document.createElement("div");
    bottomLine.className = "week-row-bottom";

    const timeText = formatIsoToNice(game.kickoffIso);
    const typeText =
      game.type === "division"
        ? "Division"
        : game.type === "conference"
        ? "Conference"
        : game.type === "nonconference"
        ? "Interconference"
        : "Conference (extra)";

    if (game.status === "final" && game.teamScore != null && game.opponentScore != null) {
      const isWin = game.teamScore > game.opponentScore;
      const resLetter = isWin ? "W" : "L";
      bottomLine.textContent = `${timeText} • ${resLetter} ${game.teamScore}–${game.opponentScore} • ${typeText}`;
    } else {
      bottomLine.textContent = `${timeText} • Scheduled • ${typeText}`;
    }

    row.appendChild(topLine);
    row.appendChild(bottomLine);

    row.addEventListener("click", () => {
      selectedWeekIndex = game.index;
      renderWeekList();
      renderWeekDetail();
    });

    listEl.appendChild(row);
  });
}

function renderWeekDetail() {
  const titleEl = getEl("week-detail-title");
  const oppEl = getEl("week-detail-opponent");
  const metaEl = getEl("week-detail-meta");
  const resultEl = getEl("week-detail-result");
  const recordLineEl = getEl("week-detail-record-line");
  const gameDayBtn = getEl("btn-week-gameday");
  const boxBtn = getEl("btn-week-boxscore");

  const game = currentTeamSchedule.find((g) => g.index === selectedWeekIndex);
  if (!game) {
    if (titleEl) titleEl.textContent = "No week selected";
    if (oppEl) oppEl.textContent = "";
    if (metaEl) metaEl.textContent = "";
    if (resultEl) resultEl.textContent = "";
    if (recordLineEl) recordLineEl.textContent = "";
    if (gameDayBtn) gameDayBtn.disabled = true;
    if (boxBtn) boxBtn.disabled = true;
    return;
  }

  const oppName = getTeamDisplayName(game.opponentCode);
  if (titleEl) {
    titleEl.textContent = `Week ${game.seasonWeek}`;
  }
  if (oppEl) {
    oppEl.textContent = game.isHome ? `Home vs ${oppName}` : `Road at ${oppName}`;
  }

  const kickoffText = formatIsoToNice(game.kickoffIso);
  const typeText =
    game.type === "division"
      ? "Division matchup"
      : game.type === "conference"
      ? "Conference game"
      : game.type === "nonconference"
      ? "Interconference game"
      : "Conference matchup";
  if (metaEl) {
    metaEl.textContent = `${kickoffText} • ${typeText}`;
  }

  // Result line
  if (resultEl) {
    if (game.status === "final" && game.teamScore != null && game.opponentScore != null) {
      const isWin = game.teamScore > game.opponentScore;
      const resLetter = isWin ? "W" : "L";
      resultEl.textContent = `${resLetter} ${game.teamScore}–${game.opponentScore}`;
    } else {
      resultEl.textContent = "Game not yet played.";
    }
  }

  // Record line – uses current franchise record from save.
  if (recordLineEl && currentFranchiseSave) {
    const { wins, losses } = parseRecord(currentFranchiseSave.record || "0-0");
    recordLineEl.textContent = `Current record: ${wins}-${losses}`;
  }

  if (gameDayBtn) {
    gameDayBtn.disabled = false;
    gameDayBtn.onclick = function () {
      // For now, send back to hub or game-day page placeholder.
      window.location.href = "franchise.html";
    };
  }

  if (boxBtn) {
    const isFinal = game.status === "final";
    boxBtn.disabled = !isFinal;
    boxBtn.onclick = function () {
      if (!isFinal) {
        window.alert("Box score will be available after this game is played.");
        return;
      }
      // Future: navigate to a dedicated game results / box score page,
      // e.g. `game_result.html?season=YEAR&week=X&team=...`
      window.alert("Box score view not implemented yet.");
    };
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindScopeToggle() {
  const myBtn = getEl("btn-scope-my-team");
  const leagueBtn = getEl("btn-scope-league");

  if (myBtn) {
    myBtn.addEventListener("click", () => {
      if (currentScope === "team") return;
      currentScope = "team";
      renderScopeToggle();
      renderWeekList();
      renderWeekDetail();
    });
  }

  if (leagueBtn) {
    leagueBtn.addEventListener("click", () => {
      if (currentScope === "league") return;
      currentScope = "league";
      renderScopeToggle();
      renderWeekList();
      renderWeekDetail();
    });
  }
}

function bindBackButton() {
  const backBtn = getEl("btn-back-hub");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "franchise.html";
    });
  }
}

// ---------------------------------------------------------------------------
// No-franchise fallback
// ---------------------------------------------------------------------------

function renderNoFranchiseScheduleState() {
  // If schedule.html already has a no-franchise section we could toggle it.
  // For now, we hard-replace the body with a simple message.
  document.body.innerHTML = `
    <div class="no-franchise-state">
      <div class="no-franchise-title">No active franchise found</div>
      <div class="no-franchise-text">
        There’s no active franchise in this slot. Return to the main menu to start a new franchise or continue an existing one.
      </div>
      <div class="no-franchise-actions">
        <button type="button" class="btn-primary" id="btn-go-main-menu">Back to main menu</button>
      </div>
    </div>
  `;

  const mainBtn = document.getElementById("btn-go-main-menu");
  if (mainBtn) {
    mainBtn.addEventListener("click", () => {
      window.location.href = "main_page.html";
    });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initSchedulePage() {
  const save = loadLastFranchise();
  if (!save) {
    renderNoFranchiseScheduleState();
    return;
  }

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = {
      franchiseId: save.franchiseId,
      seasonYear: save.seasonYear
    };
  }

  // Ensure schedule exists and we have this team's schedule.
  const teamSchedule = ensureTeamSchedule(leagueState, save);

  currentFranchiseSave = save;
  currentLeagueState = leagueState;
  currentTeamSchedule = teamSchedule.slice(); // shallow copy

  // Select current week if within range; otherwise week 1.
  const rawWeekIndex = typeof save.weekIndex === "number" ? save.weekIndex : 0;
  if (rawWeekIndex >= 0 && rawWeekIndex < currentTeamSchedule.length) {
    selectedWeekIndex = rawWeekIndex;
  } else {
    selectedWeekIndex = 0;
  }

  renderHeader(save);
  renderScopeToggle();
  renderWeekList();
  renderWeekDetail();
  bindScopeToggle();
  bindBackButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSchedulePage);
} else {
  initSchedulePage();
}
