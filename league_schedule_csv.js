// league_schedule_csv.js
// -----------------------------------------------------------------------------
// Schedule engine backed by a historical NFL CSV schedule.
//
// Uses the CSV at:
//   https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/schedule.csv
//
// Exports exactly what schedule.js expects:
//
//   - getTeamDisplayName(teamCode)
//   - ensureTeamSchedule(leagueState, teamCode, seasonYear)
//   - ensureAllTeamSchedules(leagueState, seasonYear)
//
// LeagueState.schedule will look like:
//
//   {
//     seasonYear: <franchise seasonYear>,
//     schemaVersion: 3,
//     source: "csv",
//     csvSeason: <actual NFL year the schedule came from>,
//     byTeam: { [teamCode]: TeamGame[] },
//     byWeek: { [weekNumber]: LeagueGame[] }
//   }
//
// TeamGame objects are compatible with schedule.js:
//   {
//     index, seasonWeek, teamCode, opponentCode,
//     isHome, type, kickoffIso, status,
//     teamScore, opponentScore
//   }
//
// For now we ignore points in the CSV and treat every game as "scheduled".
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const REGULAR_SEASON_WEEKS = 18;        // UI expects 1–18
export const GAMES_PER_TEAM = 17;             // target era, but CSV may differ
export const SCHEDULE_SCHEMA_VERSION = 3;     // bump so old schedules are ignored

const CSV_URL =
  "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/schedule.csv";

// -----------------------------------------------------------------------------
// Team metadata + helpers
// -----------------------------------------------------------------------------

/**
 * TEAM_META is just enough to:
 *  - render display names
 *  - know conference / division for type classification
 */
const TEAM_META = [
  // AFC East
  { code: "BUF", city: "Buffalo",   name: "Bills",       conference: "AFC", division: "East" },
  { code: "MIA", city: "Miami",     name: "Dolphins",    conference: "AFC", division: "East" },
  { code: "NE",  city: "New England", name: "Patriots", conference: "AFC", division: "East" },
  { code: "NYJ", city: "New York",  name: "Jets",        conference: "AFC", division: "East" },

  // AFC North
  { code: "BAL", city: "Baltimore", name: "Ravens",      conference: "AFC", division: "North" },
  { code: "CIN", city: "Cincinnati", name: "Bengals",    conference: "AFC", division: "North" },
  { code: "CLE", city: "Cleveland", name: "Browns",      conference: "AFC", division: "North" },
  { code: "PIT", city: "Pittsburgh", name: "Steelers",   conference: "AFC", division: "North" },

  // AFC South
  { code: "HOU", city: "Houston",   name: "Texans",      conference: "AFC", division: "South" },
  { code: "IND", city: "Indianapolis", name: "Colts",   conference: "AFC", division: "South" },
  { code: "JAX", city: "Jacksonville", name: "Jaguars", conference: "AFC", division: "South" },
  { code: "TEN", city: "Tennessee", name: "Titans",     conference: "AFC", division: "South" },

  // AFC West
  { code: "DEN", city: "Denver",    name: "Broncos",     conference: "AFC", division: "West" },
  { code: "KC",  city: "Kansas City", name: "Chiefs",   conference: "AFC", division: "West" },
  { code: "LV",  city: "Las Vegas", name: "Raiders",    conference: "AFC", division: "West" },
  { code: "LAC", city: "Los Angeles", name: "Chargers", conference: "AFC", division: "West" },

  // NFC East
  { code: "DAL", city: "Dallas",    name: "Cowboys",     conference: "NFC", division: "East" },
  { code: "NYG", city: "New York",  name: "Giants",      conference: "NFC", division: "East" },
  { code: "PHI", city: "Philadelphia", name: "Eagles",  conference: "NFC", division: "East" },
  { code: "WAS", city: "Washington", name: "Commanders", conference: "NFC", division: "East" },

  // NFC North
  { code: "CHI", city: "Chicago",   name: "Bears",       conference: "NFC", division: "North" },
  { code: "DET", city: "Detroit",   name: "Lions",       conference: "NFC", division: "North" },
  { code: "GB",  city: "Green Bay", name: "Packers",     conference: "NFC", division: "North" },
  { code: "MIN", city: "Minnesota", name: "Vikings",     conference: "NFC", division: "North" },

  // NFC South
  { code: "ATL", city: "Atlanta",   name: "Falcons",     conference: "NFC", division: "South" },
  { code: "CAR", city: "Carolina",  name: "Panthers",    conference: "NFC", division: "South" },
  { code: "NO",  city: "New Orleans", name: "Saints",   conference: "NFC", division: "South" },
  { code: "TB",  city: "Tampa Bay", name: "Buccaneers",  conference: "NFC", division: "South" },

  // NFC West
  { code: "ARI", city: "Arizona",   name: "Cardinals",   conference: "NFC", division: "West" },
  { code: "LAR", city: "Los Angeles", name: "Rams",     conference: "NFC", division: "West" },
  { code: "SEA", city: "Seattle",   name: "Seahawks",    conference: "NFC", division: "West" },
  { code: "SF",  city: "San Francisco", name: "49ers",  conference: "NFC", division: "West" }
];

const TEAM_INFO_BY_CODE = {};
for (const meta of TEAM_META) {
  TEAM_INFO_BY_CODE[meta.code] = meta;
}

// Map of full CSV team names -> our codes
const TEAM_NAME_TO_CODE = {
  "Arizona Cardinals": "ARI",
  "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",
  "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN",
  "Detroit Lions": "DET",
  "Green Bay Packers": "GB",
  "Houston Texans": "HOU",
  "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",
  "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR",
  "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",
  "New England Patriots": "NE",
  "New Orleans Saints": "NO",
  "New York Giants": "NYG",
  "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",
  "Washington Commanders": "WAS"
};

// Public helper used by schedule.js
export function getTeamDisplayName(teamCode) {
  const meta = TEAM_INFO_BY_CODE[teamCode];
  if (!meta) return teamCode || "Unknown Team";
  return `${meta.city} ${meta.name}`;
}

// -----------------------------------------------------------------------------
// CSV loading (top-level await, so imports block until CSV is ready)
// -----------------------------------------------------------------------------

/**
 * Lightweight CSV parser tailored to the schedule.csv format.
 * Expects header:
 *   row_id,game_id,season,season_type,week,date,team,opp,home_away,points_for,points_against
 */
function parseScheduleCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];

  // Remove BOM if present
  const headerLine = lines[0].replace(/^\uFEFF/, "");
  const headers = headerLine.split(",");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const cols = raw.split(",");
    if (cols.length !== headers.length) {
      console.warn(
        "[league_schedule_csv] Skipping malformed CSV row:",
        raw
      );
      continue;
    }
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j];
    }
    row.season = Number(row.season);
    row.week = Number(row.week);
    // points_* may be empty strings; we don't use them anyway
    rows.push(row);
  }
  return rows;
}

function groupRowsBySeason(rows) {
  const bySeason = new Map();
  for (const row of rows) {
    if (row.season_type && row.season_type !== "REG") continue; // just in case
    const season = row.season;
    if (!bySeason.has(season)) bySeason.set(season, []);
    bySeason.get(season).push(row);
  }
  return bySeason;
}

/** @type {Map<number, any[]>} */
let CSV_ROWS_BY_SEASON = new Map();
/** @type {number[]} */
let CSV_SEASON_YEARS = [];

// Load & parse CSV once at module load
try {
  const response = await fetch(CSV_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching schedule CSV`);
  }
  const text = await response.text();
  const rows = parseScheduleCsv(text);
  CSV_ROWS_BY_SEASON = groupRowsBySeason(rows);
  CSV_SEASON_YEARS = Array.from(CSV_ROWS_BY_SEASON.keys()).sort((a, b) => a - b);
  console.log(
    "[league_schedule_csv] Loaded schedule CSV seasons:",
    CSV_SEASON_YEARS.join(", ")
  );
} catch (err) {
  console.error("[league_schedule_csv] Failed to load schedule CSV:", err);
  CSV_ROWS_BY_SEASON = new Map();
  CSV_SEASON_YEARS = [];
}

// -----------------------------------------------------------------------------
// Core schedule builder from CSV
// -----------------------------------------------------------------------------

function classifyGameType(homeCode, awayCode) {
  const home = TEAM_INFO_BY_CODE[homeCode];
  const away = TEAM_INFO_BY_CODE[awayCode];
  if (!home || !away) return "nonconference";

  if (home.conference === away.conference) {
    if (home.division === away.division) return "division";
    return "conference";
  }
  return "nonconference";
}

function makeKickoffIso(dateStr) {
  // Treat as 18:00 UTC on that date (~1–2pm Eastern depending on DST).
  // No need to construct a Date object; ISO string is enough.
  return `${dateStr}T18:00:00.000Z`;
}

/**
 * Choose which NFL season from the CSV we’ll use for a given sim season.
 * If the exact year exists, use it. Otherwise clamp to [min, max] in the CSV.
 */
function resolveCsvSeason(targetSeasonYear) {
  if (!CSV_SEASON_YEARS.length) {
    throw new Error(
      "[league_schedule_csv] No CSV seasons loaded; cannot build schedule."
    );
  }
  if (CSV_SEASON_YEARS.includes(targetSeasonYear)) {
    return targetSeasonYear;
  }
  const min = CSV_SEASON_YEARS[0];
  const max = CSV_SEASON_YEARS[CSV_SEASON_YEARS.length - 1];
  if (targetSeasonYear < min) return min;
  if (targetSeasonYear > max) return max;

  // Between min & max but not present (future-proofing)
  let closest = CSV_SEASON_YEARS[0];
  let minDiff = Math.abs(targetSeasonYear - closest);
  for (const year of CSV_SEASON_YEARS) {
    const diff = Math.abs(targetSeasonYear - year);
    if (diff < minDiff) {
      minDiff = diff;
      closest = year;
    }
  }
  return closest;
}

/**
 * Build a LeagueSchedule object from the CSV rows for one NFL season.
 *
 * @param {number} csvSeason  The actual NFL year in the CSV (2016–2024)
 * @param {number} targetSeasonYear The in-game seasonYear for the franchise
 */
function buildLeagueScheduleFromCsv(csvSeason, targetSeasonYear) {
  const rows = CSV_ROWS_BY_SEASON.get(csvSeason) || [];
  if (!rows.length) {
    throw new Error(
      `[league_schedule_csv] No schedule rows found for CSV season ${csvSeason}`
    );
  }

  // Group by game_id. Each game_id has 2 rows: one per team.
  const gamesById = new Map();
  for (const row of rows) {
    const gid = row.game_id;
    if (!gamesById.has(gid)) gamesById.set(gid, []);
    gamesById.get(gid).push(row);
  }

  /** @type {Record<number, any[]>} */
  const byWeek = {};
  /** @type {Record<string, any[]>} */
  const byTeam = {};

  for (const code of Object.keys(TEAM_INFO_BY_CODE)) {
    byTeam[code] = [];
  }

  let maxCsvWeek = 0;

  for (const [gameId, gameRows] of gamesById.entries()) {
    const base = gameRows[0];
    const week = Number(base.week) || 0;
    const dateStr = base.date;

    if (week > maxCsvWeek) maxCsvWeek = week;

    const homeRow =
      gameRows.find((r) => r.home_away === "H") || gameRows[0];
    const awayRow =
      gameRows.find((r) => r.home_away === "A") ||
      gameRows.find((r) => r !== homeRow) ||
      gameRows[0];

    const homeName = homeRow.team;
    const awayName = awayRow.team;

    const homeCode = TEAM_NAME_TO_CODE[homeName];
    const awayCode = TEAM_NAME_TO_CODE[awayName];

    if (!homeCode || !awayCode) {
      console.warn(
        "[league_schedule_csv] Unknown team name(s) in CSV row:",
        homeName,
        awayName,
        "for game_id",
        gameId
      );
      continue;
    }

    const type = classifyGameType(homeCode, awayCode);
    const kickoffIso = makeKickoffIso(dateStr);

    // League-wide view (byWeek)
    const leagueGame = {
      gameId,
      week,
      homeTeam: homeCode,
      awayTeam: awayCode,
      type,
      kickoffIso,
      status: "scheduled",
      homeScore: null,
      awayScore: null
    };

    if (!byWeek[week]) byWeek[week] = [];
    byWeek[week].push(leagueGame);

    // Team-centric entries
    byTeam[homeCode].push({
      index: 0, // filled in later
      seasonWeek: week,
      teamCode: homeCode,
      opponentCode: awayCode,
      isHome: true,
      type,
      kickoffIso,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });

    byTeam[awayCode].push({
      index: 0,
      seasonWeek: week,
      teamCode: awayCode,
      opponentCode: homeCode,
      isHome: false,
      type,
      kickoffIso,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
  }

  // Ensure weeks 1–18 exist in byWeek (UI loops 1..18)
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    if (!byWeek[w]) byWeek[w] = [];
  }

  // Add BYE placeholders per team when there's exactly one missing week.
  const allCsvWeeks = [];
  for (let w = 1; w <= maxCsvWeek; w++) allCsvWeeks.push(w);

  for (const teamCode of Object.keys(byTeam)) {
    const games = byTeam[teamCode];
    const playedWeeks = new Set(games.map((g) => g.seasonWeek));
    const missingWeeks = allCsvWeeks.filter((w) => !playedWeeks.has(w));

    if (missingWeeks.length === 1) {
      const byeWeek = missingWeeks[0];
      games.push({
        index: 0,
        seasonWeek: byeWeek,
        teamCode,
        opponentCode: "BYE",
        isHome: false,
        type: "bye",
        kickoffIso: null,
        status: "scheduled",
        teamScore: null,
        opponentScore: null
      });
    } else if (missingWeeks.length > 1) {
      // This happens, for example, with BUF/CIN in 2022 because of the canceled game.
      console.warn(
        `[league_schedule_csv] Team ${teamCode} has ${missingWeeks.length} missing weeks in CSV season ${csvSeason}:`,
        missingWeeks.join(", ")
      );
    }

    // Normalize ordering and fill in index per team
    games.sort((a, b) => (a.seasonWeek || 0) - (b.seasonWeek || 0));
    games.forEach((g, idx) => {
      g.index = idx;
    });
  }

  return {
    seasonYear: targetSeasonYear,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    source: "csv",
    csvSeason,
    byTeam,
    byWeek
  };
}

// Cache built schedules per *sim* seasonYear
const SCHEDULE_CACHE = new Map();

// -----------------------------------------------------------------------------
// Public helpers for other modules (schedule.js uses these three)
// -----------------------------------------------------------------------------

/**
 * Ensure a league schedule exists on leagueState for the given seasonYear,
 * loaded from the CSV. If the seasonYear changes or schema/version mismatch,
 * a new schedule is built and attached.
 *
 * @param {Object} leagueState
 * @param {number} seasonYear
 * @returns {{ seasonYear: number, schemaVersion: number, byTeam: Object, byWeek: Object }}
 */
export function ensureLeagueScheduleObject(leagueState, seasonYear) {
  if (!leagueState) {
    throw new Error("leagueState is required for ensureLeagueScheduleObject");
  }

  const existing = leagueState.schedule;
  if (
    existing &&
    existing.seasonYear === seasonYear &&
    existing.schemaVersion === SCHEDULE_SCHEMA_VERSION
  ) {
    return existing;
  }

  const csvSeason = resolveCsvSeason(seasonYear);

  let schedule = SCHEDULE_CACHE.get(seasonYear);
  if (!schedule) {
    schedule = buildLeagueScheduleFromCsv(csvSeason, seasonYear);
    SCHEDULE_CACHE.set(seasonYear, schedule);
  }

  leagueState.schedule = schedule;
  return schedule;
}

/**
 * Return the per-team schedule (TeamGame[]) for a given team & season.
 *
 * @param {Object} leagueState
 * @param {string} teamCode
 * @param {number} seasonYear
 * @returns {Array<Object>} TeamGame[]
 */
export function ensureTeamSchedule(leagueState, teamCode, seasonYear) {
  const schedule = ensureLeagueScheduleObject(leagueState, seasonYear);
  if (!schedule.byTeam[teamCode]) {
    console.warn(
      `[league_schedule_csv] No games found for team ${teamCode} in season ${seasonYear}`
    );
    schedule.byTeam[teamCode] = [];
  }
  return schedule.byTeam[teamCode];
}

/**
 * Ensure the league schedule exists and is fully populated for all teams.
 *
 * @param {Object} leagueState
 * @param {number} seasonYear
 * @returns {Object} LeagueSchedule
 */
export function ensureAllTeamSchedules(leagueState, seasonYear) {
  return ensureLeagueScheduleObject(leagueState, seasonYear);
}

// -----------------------------------------------------------------------------
// Optional: record recompute helper (matches old API if you want to use it)
// -----------------------------------------------------------------------------

/**
 * Recompute a team's record from its schedule (wins/losses/ties).
 *
 * @param {Object} leagueState
 * @param {string} teamCode
 * @returns {string} record like "10-7" or "9-7-1"
 */
export function recomputeRecordFromSchedule(leagueState, teamCode) {
  const schedule = leagueState.schedule;
  if (!schedule || !schedule.byTeam || !schedule.byTeam[teamCode]) {
    return "0-0";
  }
  const games = schedule.byTeam[teamCode];

  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (const g of games) {
    if (g.type === "bye") continue;
    if (g.status !== "final") continue;
    const us = Number(g.teamScore);
    const them = Number(g.opponentScore);
    if (!Number.isFinite(us) || !Number.isFinite(them)) continue;

    if (us > them) wins++;
    else if (them > us) losses++;
    else ties++;
  }

  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}
