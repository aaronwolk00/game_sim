// league_schedule.js
// -----------------------------------------------------------------------------
// Shared schedule engine (no DOM, no localStorage).
// Used by: schedule.js, franchise_gameday.js, franchise.js (season rollover).
//
// League-wide 17-game / 18-week schedule:
//
// - 32 teams, 272 games.
// - Each team plays exactly 17 games.
// - Exactly 1 bye week per team (Weeks 5–14).
// - No duplicate or missing matchups at the league level.
// - Late-season division clustering (Weeks 15–18).
// - Realistic dates/times with TNF / SNF / MNF + Sunday windows.
// - London / early Sunday game occasionally in Weeks 5–8.
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} TeamGame
 * @property {number} index            // 0-based index in that team's schedule
 * @property {number} seasonWeek       // 1–18
 * @property {string} teamCode
 * @property {string} opponentCode     // "BYE" for bye weeks
 * @property {boolean} isHome          // false for bye weeks
 * @property {"division"|"conference"|"nonconference"|"extra"|"bye"} type
 * @property {string|null} kickoffIso
 * @property {"scheduled"|"final"} status
 * @property {number|null} teamScore
 * @property {number|null} opponentScore
 */

/**
 * @typedef {Object} LeagueGame
 * @property {number} week
 * @property {string} homeTeam
 * @property {string} awayTeam
 * @property {"division"|"conference"|"nonconference"|"extra"} type
 * @property {string|null} kickoffIso
 * @property {"scheduled"|"final"} status
 * @property {number|null} homeScore
 * @property {number|null} awayScore
 * @property {string} [slotId]         // internal: TNF / SNF / etc
 */

/**
 * @typedef {Object} LeagueSchedule
 * @property {number} seasonYear
 * @property {number} schemaVersion
 * @property {Object.<string, TeamGame[]>} byTeam
 * @property {Object.<number, LeagueGame[]>} byWeek
 */

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const REGULAR_SEASON_WEEKS = 18;
export const GAMES_PER_TEAM = 17;
export const SCHEDULE_SCHEMA_VERSION = 2;
// Set true while developing to log detailed schedule summaries to console
const SCHEDULE_DEBUG = true;

// -----------------------------------------------------------------------------
// Team metadata
// -----------------------------------------------------------------------------

export const TEAM_META = [
  // AFC East
  { teamCode: "BUF", city: "Buffalo",      name: "Bills",       conference: "AFC", division: "East" },
  { teamCode: "MIA", city: "Miami",        name: "Dolphins",    conference: "AFC", division: "East" },
  { teamCode: "NE",  city: "New England",  name: "Patriots",    conference: "AFC", division: "East" },
  { teamCode: "NYJ", city: "New York",     name: "Jets",        conference: "AFC", division: "East" },

  // AFC North
  { teamCode: "BAL", city: "Baltimore",    name: "Ravens",      conference: "AFC", division: "North" },
  { teamCode: "CIN", city: "Cincinnati",   name: "Bengals",     conference: "AFC", division: "North" },
  { teamCode: "CLE", city: "Cleveland",    name: "Browns",      conference: "AFC", division: "North" },
  { teamCode: "PIT", city: "Pittsburgh",   name: "Steelers",    conference: "AFC", division: "North" },

  // AFC South
  { teamCode: "HOU", city: "Houston",      name: "Texans",      conference: "AFC", division: "South" },
  { teamCode: "IND", city: "Indianapolis", name: "Colts",       conference: "AFC", division: "South" },
  { teamCode: "JAX", city: "Jacksonville", name: "Jaguars",     conference: "AFC", division: "South" },
  { teamCode: "TEN", city: "Tennessee",    name: "Titans",      conference: "AFC", division: "South" },

  // AFC West
  { teamCode: "DEN", city: "Denver",       name: "Broncos",     conference: "AFC", division: "West" },
  { teamCode: "KC",  city: "Kansas City",  name: "Chiefs",      conference: "AFC", division: "West" },
  { teamCode: "LV",  city: "Las Vegas",    name: "Raiders",     conference: "AFC", division: "West" },
  { teamCode: "LAC", city: "Los Angeles",  name: "Chargers",    conference: "AFC", division: "West" },

  // NFC East
  { teamCode: "DAL", city: "Dallas",       name: "Cowboys",     conference: "NFC", division: "East" },
  { teamCode: "NYG", city: "New York",     name: "Giants",      conference: "NFC", division: "East" },
  { teamCode: "PHI", city: "Philadelphia", name: "Eagles",      conference: "NFC", division: "East" },
  { teamCode: "WAS", city: "Washington",   name: "Commanders",  conference: "NFC", division: "East" },

  // NFC North
  { teamCode: "CHI", city: "Chicago",      name: "Bears",       conference: "NFC", division: "North" },
  { teamCode: "DET", city: "Detroit",      name: "Lions",       conference: "NFC", division: "North" },
  { teamCode: "GB",  city: "Green Bay",    name: "Packers",     conference: "NFC", division: "North" },
  { teamCode: "MIN", city: "Minnesota",    name: "Vikings",     conference: "NFC", division: "North" },

  // NFC South
  { teamCode: "ATL", city: "Atlanta",      name: "Falcons",     conference: "NFC", division: "South" },
  { teamCode: "CAR", city: "Carolina",     name: "Panthers",    conference: "NFC", division: "South" },
  { teamCode: "NO",  city: "New Orleans",  name: "Saints",      conference: "NFC", division: "South" },
  { teamCode: "TB",  city: "Tampa Bay",    name: "Buccaneers",  conference: "NFC", division: "South" },

  // NFC West
  { teamCode: "ARI", city: "Arizona",      name: "Cardinals",   conference: "NFC", division: "West" },
  { teamCode: "LAR", city: "Los Angeles",  name: "Rams",        conference: "NFC", division: "West" },
  { teamCode: "SF",  city: "San Francisco",name: "49ers",       conference: "NFC", division: "West" },
  { teamCode: "SEA", city: "Seattle",      name: "Seahawks",    conference: "NFC", division: "West" }
];

export const DIVISION_NAMES = ["East", "North", "South", "West"];

// Intra-conference division pairs used for 4-game rotation and "extra" games.
// Matches your Python INTRA_CONF_PAIRS.
const INTRA_CONF_PAIRS = [
  ["East", "North"],
  ["South", "West"]
];

// Cross-conference 4-game rotation mapping, per division, per conference.
// This matches the Python logic:
//   AFC East  vs NFC North
//   AFC North vs NFC South
//   AFC South vs NFC West
//   AFC West  vs NFC East
// And the inverse for NFC.
const CROSS_CONF_ROTATION = {
  AFC: {
    East: "North",
    North: "South",
    South: "West",
    West: "East"
  },
  NFC: {
    East: "West",
    North: "East",
    South: "North",
    West: "South"
  }
};

// -----------------------------------------------------------------------------
// Public team meta helpers
// -----------------------------------------------------------------------------

export function getTeamMeta(teamCode) {
  return TEAM_META.find((t) => t.teamCode === teamCode) || null;
}

export function getTeamDisplayName(teamCode) {
  const meta = getTeamMeta(teamCode);
  if (!meta) return teamCode || "Unknown Team";
  return `${meta.city} ${meta.name}`;
}

export function getDivisionTeams(conference, division) {
  return TEAM_META
    .filter((t) => t.conference === conference && t.division === division)
    .map((t) => t.teamCode);
}

export function getAllTeamCodes() {
  return TEAM_META.map((t) => t.teamCode);
}

// -----------------------------------------------------------------------------
// Rotation helpers (now aligned with the Python schedule logic)
// -----------------------------------------------------------------------------

/**
 * Same-conference division rotation for the 4-game block.
 * East <-> North, South <-> West — fixed, seasonYear ignored.
 */
export function getSameConferenceOppDivision(_conference, division, _seasonYear) {
  for (const [a, b] of INTRA_CONF_PAIRS) {
    if (division === a) return b;
    if (division === b) return a;
  }
  return "East";
}

/**
 * Cross-conference division rotation for the 4-game block.
 * Matches CROSS_CONF_ROTATION and buildLeagueMatchups.
 */
export function getCrossConferenceDivision(conference, division, _seasonYear) {
  const confMap = CROSS_CONF_ROTATION[conference];
  if (!confMap) return "East";
  return confMap[division] || "East";
}

// -----------------------------------------------------------------------------
// Time helpers
// -----------------------------------------------------------------------------

// Compute the second Thursday of September in LOCAL time.
// This is treated as the Week 1 Thursday night opener.
function getSeasonStartDateLocal(seasonYear) {
  const d = new Date(seasonYear, 8, 1, 0, 0, 0, 0); // month 8 = September
  const THURSDAY = 4; // 0 = Sun, 1 = Mon, ... 4 = Thu
  const firstDow = d.getDay();

  const offsetToFirstThu = (THURSDAY - firstDow + 7) % 7;
  const firstThuDate = 1 + offsetToFirstThu;
  const secondThuDate = firstThuDate + 7;

  d.setDate(secondThuDate);
  return d; // second Thursday in September, local midnight
}

const SLOT_DEFS = {
  THU:      { dayOffset: 0, hour: 20, minute: 20 }, // Thu 8:20 PM
  SUN_930:  { dayOffset: 3, hour: 9,  minute: 30 }, // Sun 9:30 AM (London)
  SUN_1:    { dayOffset: 3, hour: 13, minute: 0  }, // Sun 1:00 PM
  SUN_415:  { dayOffset: 3, hour: 16, minute: 15 }, // Sun 4:15 PM
  SUN_425:  { dayOffset: 3, hour: 16, minute: 25 }, // Sun 4:25 PM
  SUN_820:  { dayOffset: 3, hour: 20, minute: 20 }, // SNF
  MON_700:  { dayOffset: 4, hour: 19, minute: 0  }, // MNF early
  MON_1000: { dayOffset: 4, hour: 22, minute: 0  }  // MNF late
};

// West / Mountain hosts heavily favored in late windows.
const LATE_HOSTS = new Set(["SEA", "SF", "LAR", "LAC", "ARI", "LV", "DEN"]);

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Group teams by conference and division:
 * { AFC: { East: [BUF,...], ... }, NFC: { ... } }
 */
function groupTeamsByConfAndDiv() {
  /** @type {{[conf: string]: {[div: string]: string[]}}} */
  const map = { AFC: {}, NFC: {} };

  for (const conf of ["AFC", "NFC"]) {
    map[conf] = {};
    for (const div of DIVISION_NAMES) {
      map[conf][div] = [];
    }
  }

  for (const t of TEAM_META) {
    if (!map[t.conference]) map[t.conference] = {};
    if (!map[t.conference][t.division]) map[t.conference][t.division] = [];
    map[t.conference][t.division].push(t.teamCode);
  }

  // Make ordering deterministic inside each division
  for (const conf of ["AFC", "NFC"]) {
    for (const div of DIVISION_NAMES) {
      map[conf][div].sort();
    }
  }

  return map;
}

// -----------------------------------------------------------------------------
// Bye week allocation (Weeks 5–14)
// -----------------------------------------------------------------------------

/**
 * Assigns one bye per team between Weeks 5–14 (NFL-accurate window).
 * Pattern: [4,2,2,6,4,4,2,4,0,4] → 32 byes total.
 *
 * @returns {Object.<string, number>} teamCode -> byeWeek
 */
function createRandomByeWeeks() {
  const teams = getAllTeamCodes();
  const byeWeeks = {};

  // Weeks 5–14 inclusive → 10 possible bye weeks
  const baseWeeks = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const byePattern = [4, 2, 2, 6, 4, 4, 2, 4, 0, 4];

  const shuffledTeams = [...teams];
  shuffleInPlace(shuffledTeams);

  let cursor = 0;
  for (let i = 0; i < baseWeeks.length; i++) {
    const w = baseWeeks[i];
    const count = byePattern[i];
    for (let j = 0; j < count && cursor < shuffledTeams.length; j++) {
      const team = shuffledTeams[cursor++];
      byeWeeks[team] = w;
    }
  }

  return byeWeeks;
}

// -----------------------------------------------------------------------------
// Matchup generation – full league (272 games, week-agnostic)
// -----------------------------------------------------------------------------

/**
 * Create all 272 games (no weeks / times yet), based on the same formula
 * as your working Python script:
 *
 * - 6 division games (home/away vs 3 rivals)
 * - 4 same-conference division rotation games
 * - 2 same-conference "extra" rank-based games
 * - 4 cross-conference rotation games
 * - 1 17th cross-conference rank-based game (host conf alternates by year)
 *
 * @param {number} seasonYear
 * @returns {LeagueGame[]}
 */
function buildLeagueMatchups(seasonYear) {
  const divisions = groupTeamsByConfAndDiv();
  /** @type {LeagueGame[]} */
  const games = [];

  const hostConference = seasonYear % 2 === 0 ? "AFC" : "NFC";

  function makeGame(homeTeam, awayTeam, type) {
    return {
      week: 0,
      homeTeam,
      awayTeam,
      type,                 // "division" | "conference" | "nonconference" | "extra"
      kickoffIso: null,
      status: "scheduled",
      homeScore: null,
      awayScore: null
    };
  }

  // ---------------------------------------------------------------------------
  // 1) Division home/away (6 per team, 96 games total)
  // ---------------------------------------------------------------------------
  for (const conf of ["AFC", "NFC"]) {
    for (const div of DIVISION_NAMES) {
      const teams = divisions[conf][div];
      if (!teams || teams.length !== 4) continue;

      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const teamA = teams[i];
          const teamB = teams[j];

          games.push(makeGame(teamA, teamB, "division"));
          games.push(makeGame(teamB, teamA, "division"));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2) Same-conference 4-game division rotation (4 per team, 64 games total)
  // ---------------------------------------------------------------------------
  for (const conf of ["AFC", "NFC"]) {
    for (const [divA, divB] of INTRA_CONF_PAIRS) {
      const teamsA = divisions[conf][divA];
      const teamsB = divisions[conf][divB];
      if (!teamsA || !teamsB || teamsA.length !== 4 || teamsB.length !== 4) continue;

      // 4x4 matrix of matchups
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const parityEven = ((i + j) & 1) === 0;
          const homeTeam = parityEven ? teamsA[i] : teamsB[j];
          const awayTeam = parityEven ? teamsB[j] : teamsA[i];
          games.push(makeGame(homeTeam, awayTeam, "conference"));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3) Cross-conference 4-game rotation (4 per team, 64 games total)
  //
  //   AFC East  vs NFC North
  //   AFC North vs NFC South
  //   AFC South vs NFC West
  //   AFC West  vs NFC East
  // ---------------------------------------------------------------------------
  for (let idx = 0; idx < DIVISION_NAMES.length; idx++) {
    const afcDivName = DIVISION_NAMES[idx];
    const nfcDivName = DIVISION_NAMES[(idx + 1) % 4];

    const afcTeams = divisions.AFC[afcDivName];
    const nfcTeams = divisions.NFC[nfcDivName];
    if (!afcTeams || !nfcTeams || afcTeams.length !== 4 || nfcTeams.length !== 4) {
      continue;
    }

    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        const parityEven = ((j + k) & 1) === 0;
        const homeTeam = parityEven ? afcTeams[j] : nfcTeams[k];
        const awayTeam = parityEven ? nfcTeams[k] : afcTeams[j];
        games.push(makeGame(homeTeam, awayTeam, "nonconference"));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4) Same-conference "extra" rank-based (2 per team, 32 games total)
  //
  //   East ↔ South, East ↔ West, North ↔ South, North ↔ West
  //   Rank-matched inside each pair; host alternates by rank index.
  // ---------------------------------------------------------------------------
  for (const conf of ["AFC", "NFC"]) {
    for (const divA of DIVISION_NAMES) {
      const teamsA = divisions[conf][divA];
      if (!teamsA || teamsA.length !== 4) continue;

      // Division partnered in the 4-game rotation
      const rotB = getSameConferenceOppDivision(conf, divA);
      const remainingDivs = DIVISION_NAMES.filter(
        (d) => d !== divA && d !== rotB
      );
      if (remainingDivs.length !== 2) continue;

      const [divBName, divCName] = remainingDivs;
      const teamsB = divisions[conf][divBName];
      const teamsC = divisions[conf][divCName];
      if (!teamsB || !teamsC) continue;

      // Match 1: divA vs divB (rank matched)
      if (divA < divBName) {
        for (let r = 0; r < 4; r++) {
          const teamA = teamsA[r];
          const teamB = teamsB[r];
          const hostIsA = (r % 2 === 0);
          const homeTeam = hostIsA ? teamA : teamB;
          const awayTeam = hostIsA ? teamB : teamA;
          games.push(makeGame(homeTeam, awayTeam, "extra"));
        }
      }

      // Match 2: divA vs divC (rank matched)
      if (divA < divCName) {
        for (let r = 0; r < 4; r++) {
          const teamA = teamsA[r];
          const teamC = teamsC[r];
          const hostIsA = (r % 2 === 0);
          const homeTeam = hostIsA ? teamA : teamC;
          const awayTeam = hostIsA ? teamC : teamA;
          games.push(makeGame(homeTeam, awayTeam, "extra"));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5) 17th game cross-conference (1 per team, 16 games total)
  //
  //   AFC East  vs NFC South
  //   AFC North vs NFC West
  //   AFC South vs NFC East
  //   AFC West  vs NFC North
  //
  // Host conference alternates by seasonYear parity.
  // ---------------------------------------------------------------------------
  for (let idx = 0; idx < DIVISION_NAMES.length; idx++) {
    const afcDivName = DIVISION_NAMES[idx];
    const nfcDivName = DIVISION_NAMES[(idx + 2) % 4];

    const afcTeams = divisions.AFC[afcDivName];
    const nfcTeams = divisions.NFC[nfcDivName];
    if (!afcTeams || !nfcTeams || afcTeams.length !== 4 || nfcTeams.length !== 4) {
      continue;
    }

    for (let r = 0; r < 4; r++) {
      const afcTeam = afcTeams[r];
      const nfcTeam = nfcTeams[r];

      const homeTeam = hostConference === "AFC" ? afcTeam : nfcTeam;
      const awayTeam = hostConference === "AFC" ? nfcTeam : afcTeam;

      games.push(makeGame(homeTeam, awayTeam, "nonconference"));
    }
  }

  if (games.length !== 272) {
    console.warn(
      `[league_schedule] buildLeagueMatchups produced ${games.length} games (expected 272)`
    );
  }

  return games;
}

/**
 * getTeamOpponents(seasonYear)
 *
 * Returns a dictionary:
 *   { teamCode: [ { opponentCode, type } ... 17 entries ... ] }
 *
 * This is derived directly from buildLeagueMatchups, ignoring weeks,
 * byes and home/away perspective, so it always matches the formula
 * used by the actual schedule generation.
 */
export function getTeamOpponents(seasonYear = new Date().getFullYear()) {
  const games = buildLeagueMatchups(seasonYear);

  /** @type {Record<string, {opponentCode: string, type: string}[]>} */
  const byTeam = {};
  for (const { teamCode } of TEAM_META) {
    byTeam[teamCode] = [];
  }

  for (const g of games) {
    const { homeTeam, awayTeam, type } = g;
    byTeam[homeTeam].push({ opponentCode: awayTeam, type });
    byTeam[awayTeam].push({ opponentCode: homeTeam, type });
  }

  // Validation: each team should have exactly 17 game entries
  for (const [team, opps] of Object.entries(byTeam)) {
    if (opps.length !== GAMES_PER_TEAM) {
      console.warn(
        `⚠️ getTeamOpponents: ${team} has ${opps.length} games (expected ${GAMES_PER_TEAM}).`
      );
    }
  }

  return byTeam;
}

// -----------------------------------------------------------------------------
// Week assignment helper (improved realism)
// -----------------------------------------------------------------------------

/**
 * Pick an appropriate week for a game.
 * Ensures: no bye conflict, no team double-bookings, and balanced weekly load.
 *
 * @param {LeagueGame} game
 * @param {number[]} candidateWeeks - preferred range to try first
 * @param {Object.<string, number>} byeWeeks - team → bye week
 * @param {Object.<string, Set<number>>} bookedWeeks - team → played weeks
 * @param {Object.<number, number>} weeklyGameCount - week → total games already scheduled
 * @returns {number} chosen week (1–18)
 */
function pickWeekForGame(game, candidateWeeks, byeWeeks, bookedWeeks, weeklyGameCount) {
  const home = game.homeTeam;
  const away = game.awayTeam;

  // 1. Shuffle candidates for organic variety
  const primary = candidateWeeks.slice();
  shuffleInPlace(primary);

  // 2. Try preferred range (keeping weekly load even)
  for (const w of primary) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    if (bookedWeeks[home].has(w) || bookedWeeks[away].has(w)) continue;
    if ((weeklyGameCount[w] ?? 0) >= 16) continue; // avoid >16 games per week
    return w;
  }

  // 3. Broaden search (weeks 1–18)
  const allWeeks = Array.from({ length: REGULAR_SEASON_WEEKS }, (_, i) => i + 1);
  shuffleInPlace(allWeeks);
  for (const w of allWeeks) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    if (bookedWeeks[home].has(w) || bookedWeeks[away].has(w)) continue;
    if ((weeklyGameCount[w] ?? 0) >= 16) continue;
    return w;
  }

  // 4. Emergency fallback – avoid bye conflicts at least
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    if (w !== byeWeeks[home] && w !== byeWeeks[away]) return w;
  }

  console.warn("[league_schedule] Emergency week assignment for", game);
  return 1;
}

// -----------------------------------------------------------------------------
// Perfect NFL-style schedule builder (robust)
// -----------------------------------------------------------------------------

export function generatePerfectLeagueSchedule(seasonYear) {
  // Step 1: Build the raw matchup list (272 total)
  const allGames = buildLeagueMatchups(seasonYear);

  // Step 2: Assign byes (Weeks 5–14, NFL-like pattern)
  const byeWeeks = createRandomByeWeeks();

  // Step 3: Initialize week containers and trackers
  /** @type {LeagueGame[][]} */
  const weeks = Array.from({ length: REGULAR_SEASON_WEEKS }, () => []);
  /** @type {Object.<string, Set<number>>} */
  const bookedWeeks = {};
  /** @type {Object.<number, number>} */
  const weeklyGameCount = {};
  for (const t of getAllTeamCodes()) bookedWeeks[t] = new Set();

  const earlyWeeks = [1, 2, 3, 4];
  const midWeeks   = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const lateWeeks  = [15, 16, 17, 18];

  // Step 4: Split by type for better distribution
  const divisionGames = allGames.filter((g) => g.type === "division");
  const others        = allGames.filter((g) => g.type !== "division");
  shuffleInPlace(divisionGames);
  shuffleInPlace(others);

  // Step 5: Place division-heavy games later
  for (const g of divisionGames) {
    const preferLate = Math.random() < 0.65;
    const candidates = preferLate ? lateWeeks : midWeeks;
    const week = pickWeekForGame(g, candidates, byeWeeks, bookedWeeks, weeklyGameCount);
    g.week = week;
    weeks[week - 1].push(g);
    bookedWeeks[g.homeTeam].add(week);
    bookedWeeks[g.awayTeam].add(week);
    weeklyGameCount[week] = (weeklyGameCount[week] ?? 0) + 1;
  }

  // Step 6: Fill early & mid weeks with remaining matchups
  for (const g of others) {
    const earlyBias = g.type === "nonconference" || g.type === "conference";
    const pool = earlyBias ? earlyWeeks.concat(midWeeks) : midWeeks;
    const week = pickWeekForGame(g, pool, byeWeeks, bookedWeeks, weeklyGameCount);
    g.week = week;
    weeks[week - 1].push(g);
    bookedWeeks[g.homeTeam].add(week);
    bookedWeeks[g.awayTeam].add(week);
    weeklyGameCount[week] = (weeklyGameCount[week] ?? 0) + 1;
  }

  // Step 7: Assign realistic kickoff times
  assignTimesToWeeks(weeks, seasonYear);

  // Step 8: Construct byWeek / byTeam structures
  /** @type {Record<number, LeagueGame[]>} */
  const byWeek = {};
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    byWeek[w] = weeks[w - 1].map((g) => ({ ...g, week: w }));
  }

  /** @type {Record<string, TeamGame[]>} */
  const byTeam = {};
  for (const team of getAllTeamCodes()) byTeam[team] = [];

  // Populate per-team schedules
  for (const [weekStr, games] of Object.entries(byWeek)) {
    const w = Number(weekStr);
    for (const g of games) {
      const { homeTeam, awayTeam } = g;
      byTeam[homeTeam].push({
        index: 0,
        seasonWeek: w,
        teamCode: homeTeam,
        opponentCode: awayTeam,
        isHome: true,
        type: g.type,
        kickoffIso: g.kickoffIso,
        status: g.status,
        teamScore: g.homeScore,
        opponentScore: g.awayScore
      });
      byTeam[awayTeam].push({
        index: 0,
        seasonWeek: w,
        teamCode: awayTeam,
        opponentCode: homeTeam,
        isHome: false,
        type: g.type,
        kickoffIso: g.kickoffIso,
        status: g.status,
        teamScore: g.awayScore,
        opponentScore: g.homeScore
      });
    }
  }

  // Step 9: Add bye placeholders properly (team-level view only)
  for (const team of getAllTeamCodes()) {
    const byeW = byeWeeks[team];
    byTeam[team].push({
      index: 0,
      seasonWeek: byeW,
      teamCode: team,
      opponentCode: "BYE",
      isHome: false,
      type: "bye",
      kickoffIso: null,
      status: "scheduled",
      teamScore: null,
      opponentScore: null
    });
  }

  // Step 10: Sort and index each team’s schedule
  for (const team of getAllTeamCodes()) {
    const arr = byTeam[team].sort((a, b) => a.seasonWeek - b.seasonWeek);
    arr.forEach((g, i) => (g.index = i));
  }

  const schedule = {
    seasonYear,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    byTeam,
    byWeek
  };

  // Optional: detailed debug summary + validation
  if (SCHEDULE_DEBUG) {
    debugPrintScheduleSummary(schedule);
    validateLeagueSchedule(schedule);
  }

  return schedule;
}

// -----------------------------------------------------------------------------
// Assign kickoff times (TNF / SNF / MNF + Sunday windows + occasional London)
// -----------------------------------------------------------------------------

function assignTimesToWeeks(weeks, seasonYear) {
  const baseDate = getSeasonStartDateLocal(seasonYear);

  // Track which teams have already appeared in each PRIME slot type
  const primeUsage = {
    THU: new Set(), // Thursday night
    SNF: new Set(), // Sunday night
    MNF: new Set()  // Monday night
  };

  // Helper: stamp a game with slot + Eastern time ISO
  function scheduleGameAtSlot(game, weekIndex, slotDef, slotId) {
    if (!game) return;

    const kickoff = new Date(baseDate);
    kickoff.setDate(baseDate.getDate() + weekIndex * 7 + slotDef.dayOffset);
    kickoff.setHours(slotDef.hour, slotDef.minute, 0, 0);

    // Convert to Eastern for display, then serialize
    const eastern = new Date(
      kickoff.toLocaleString("en-US", { timeZone: "America/New_York" })
    );

    game.kickoffIso = eastern.toISOString();
    game.slotId = slotId;
    if (!game.status) game.status = "scheduled";
  }

  // Prefer teams who haven’t been in this prime slot yet
  function pickPrimeGame(pool, usageSet) {
    for (let i = 0; i < pool.length; i++) {
      const g = pool[i];
      if (!usageSet.has(g.homeTeam) && !usageSet.has(g.awayTeam)) {
        pool.splice(i, 1);
        usageSet.add(g.homeTeam);
        usageSet.add(g.awayTeam);
        return g;
      }
    }
    // Fallback if everyone has been used: just pop one
    const g = pool.pop();
    if (!g) return null;
    usageSet.add(g.homeTeam);
    usageSet.add(g.awayTeam);
    return g;
  }

  for (let week = 1; week <= weeks.length; week++) {
    const games = weeks[week - 1];
    if (!games.length) continue;

    // Work on a shuffled copy so we don't bias any particular team
    const pool = games.slice();
    shuffleInPlace(pool);

    // Optional London / international game (Weeks 5–8)
    let londonGame = null;
    if (week >= 5 && week <= 8 && pool.length && Math.random() < 0.25) {
      // Prefer a non–West-coast host for the London 9:30 AM ET kick
      let idx = -1;
      for (let i = 0; i < pool.length; i++) {
        const g = pool[i];
        if (!LATE_HOSTS.has(g.homeTeam)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) idx = 0; // fallback
      londonGame = pool.splice(idx, 1)[0];
      scheduleGameAtSlot(londonGame, week - 1, SLOT_DEFS.SUN_930, "SUN_930");
    }

    // Prime-time selection: TNF, SNF, MNF
    const tnf = pickPrimeGame(pool, primeUsage.THU); // Thursday
    const snf = pickPrimeGame(pool, primeUsage.SNF); // Sunday night
    const mnf = pickPrimeGame(pool, primeUsage.MNF); // Monday night

    // Thursday night – fixed slot
    scheduleGameAtSlot(tnf, week - 1, SLOT_DEFS.THU, "THU");

    // Sunday night – fixed slot
    scheduleGameAtSlot(snf, week - 1, SLOT_DEFS.SUN_820, "SUN_820");

    // Monday night – randomly early or late
    if (mnf) {
      const mondayDef =
        Math.random() < 0.5 ? SLOT_DEFS.MON_700 : SLOT_DEFS.MON_1000;
      const mondayId =
        mondayDef === SLOT_DEFS.MON_700 ? "MON_700" : "MON_1000";
      scheduleGameAtSlot(mnf, week - 1, mondayDef, mondayId);
    }

    // Remaining Sunday games (1:00 and late windows)
    const remaining = games.filter((g) => !g.kickoffIso);

    for (const g of remaining) {
      let slotDef;
      let slotId;

      // West/Mountain hosts lean heavily toward the late window
      const isLateHost = LATE_HOSTS.has(g.homeTeam) && Math.random() < 0.7;
      if (isLateHost) {
        const lateChoices = [
          { def: SLOT_DEFS.SUN_415, id: "SUN_415" },
          { def: SLOT_DEFS.SUN_425, id: "SUN_425" }
        ];
        const choice = lateChoices[Math.floor(Math.random() * lateChoices.length)];
        slotDef = choice.def;
        slotId  = choice.id;
      } else {
        slotDef = SLOT_DEFS.SUN_1;
        slotId  = "SUN_1";
      }

      scheduleGameAtSlot(g, week - 1, slotDef, slotId);
    }
  }
}

// -----------------------------------------------------------------------------
// Public helpers for other modules
// -----------------------------------------------------------------------------

/**
 * Ensure a league schedule exists on the leagueState object for the given season.
 * If seasonYear changes or schema version is outdated, a new schedule is generated.
 *
 * @param {Object} leagueState
 * @param {number} seasonYear
 * @returns {LeagueSchedule}
 */
export function ensureLeagueScheduleObject(leagueState, seasonYear) {
  if (!leagueState) {
    throw new Error("leagueState is required for ensureLeagueScheduleObject");
  }

  const existing = leagueState.schedule;
  if (
    !existing ||
    existing.seasonYear !== seasonYear ||
    existing.schemaVersion !== SCHEDULE_SCHEMA_VERSION
  ) {
    const fresh = generatePerfectLeagueSchedule(seasonYear);
    leagueState.schedule = fresh;
    return fresh;
  }

  return existing;
}

/**
 * Return the per-team schedule (TeamGame[]) for a given team & season.
 *
 * @param {Object} leagueState
 * @param {string} teamCode
 * @param {number} seasonYear
 * @returns {TeamGame[]}
 */
export function ensureTeamSchedule(leagueState, teamCode, seasonYear) {
  const schedule = ensureLeagueScheduleObject(leagueState, seasonYear);
  if (!schedule.byTeam[teamCode]) {
    schedule.byTeam[teamCode] = [];
  }
  return schedule.byTeam[teamCode];
}

/**
 * Ensure the league schedule exists and is fully populated for all teams.
 *
 * @param {Object} leagueState
 * @param {number} seasonYear
 * @returns {LeagueSchedule}
 */
export function ensureAllTeamSchedules(leagueState, seasonYear) {
  const schedule = ensureLeagueScheduleObject(leagueState, seasonYear);
  return schedule;
}

/**
 * Recompute a team's record from its schedule (wins/losses/ties).
 *
 * @param {Object} leagueState
 * @param {string} teamCode
 * @returns {string} record string, e.g. "10-7" or "9-7-1"
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

/**
 * Debug helper: logs bye distribution, weekly game counts, and team-level checks.
 * Only runs when SCHEDULE_DEBUG === true.
 *
 * @param {LeagueSchedule} schedule
 */
export function debugPrintScheduleSummary(schedule) {
  if (!schedule || !schedule.byWeek || !schedule.byTeam) {
    console.warn("[league_schedule] debugPrintScheduleSummary: invalid schedule object");
    return;
  }

  const teams = getAllTeamCodes();

  console.groupCollapsed(
    `[league_schedule] Schedule summary – season ${schedule.seasonYear}`
  );

  // ----------------------------
  // Per-week summary
  // ----------------------------
  console.groupCollapsed("By week (games & byes)");
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    const games = schedule.byWeek[w] || [];
    const playingTeams = new Set();

    for (const g of games) {
      if (g.homeTeam) playingTeams.add(g.homeTeam);
      if (g.awayTeam) playingTeams.add(g.awayTeam);
    }

    const byeTeams = teams.filter((t) => !playingTeams.has(t));
    const byeLabel = byeTeams.length
      ? ` | byes=${byeTeams.length} [${byeTeams.join(", ")}]`
      : "";
    console.log(
      `Week ${w}: games=${games.length}, teamsPlaying=${playingTeams.size}${byeLabel}`
    );
  }
  console.groupEnd();

  // ----------------------------
  // Per-team summary
  // ----------------------------
  console.groupCollapsed("By team (game counts, bye, doubleheaders)");
  for (const team of teams) {
    const games = schedule.byTeam[team] || [];
    const bye = games.find((g) => g.type === "bye") || null;
    const nonBye = games.filter((g) => g.type !== "bye");

    // Track how many non-bye games in each week for this team
    const perWeekCounts = new Map();
    for (const g of nonBye) {
      const w = g.seasonWeek;
      perWeekCounts.set(w, (perWeekCounts.get(w) || 0) + 1);
    }
    const doubleWeeks = [];
    for (const [w, count] of perWeekCounts.entries()) {
      if (count > 1) doubleWeeks.push(`W${w} x${count}`);
    }

    const byeWeekStr = bye ? bye.seasonWeek : "none";
    const issueParts = [];
    if (nonBye.length !== GAMES_PER_TEAM) {
      issueParts.push(`non-bye=${nonBye.length} (expected ${GAMES_PER_TEAM})`);
    }
    if (!bye) {
      issueParts.push("no bye");
    }

    const issues = issueParts.length ? ` | ISSUES: ${issueParts.join("; ")}` : "";
    const doubles = doubleWeeks.length ? ` | doubleheaders: ${doubleWeeks.join(", ")}` : "";

    console.log(
      `${team}: totalGames=${games.length}, nonBye=${nonBye.length}, byeWeek=${byeWeekStr}${doubles}${issues}`
    );
  }
  console.groupEnd();

  console.groupEnd();
}

export function validateLeagueSchedule(schedule) {
  const teams = getAllTeamCodes();
  const seenMatchups = new Set();
  let totalGames = 0;

  // Per team: 17 non-bye games + exactly 1 bye between 5–14
  for (const team of teams) {
    const games = schedule.byTeam[team] || [];
    const nonBye = games.filter((g) => g.type !== "bye");
    const byes   = games.filter((g) => g.type === "bye");

    if (nonBye.length !== GAMES_PER_TEAM) {
      console.warn(
        `Team ${team} has ${nonBye.length} non-bye games (expected ${GAMES_PER_TEAM}).`
      );
    }
    if (byes.length !== 1) {
      console.warn(`Team ${team} has ${byes.length} byes (expected 1).`);
    } else if (byes[0].seasonWeek < 5 || byes[0].seasonWeek > 14) {
      console.warn(
        `Team ${team} bye in week ${byes[0].seasonWeek} (expected 5–14).`
      );
    }
  }

  // League-wide: total games and duplicate matchups
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    const games = schedule.byWeek[w] || [];
    for (const g of games) {
      totalGames++;
      const key = `${g.homeTeam}@${g.awayTeam}`;
      if (seenMatchups.has(key)) {
        console.warn(`Duplicate matchup detected: ${key} in week ${w}`);
      }
      seenMatchups.add(key);
    }
  }

  if (totalGames !== 272) {
    console.warn(`Total league games = ${totalGames} (expected 272).`);
  }
}

export function getByeWeekForTeam(schedule, teamCode) {
  const games = schedule.byTeam[teamCode] || [];
  const byeGame = games.find((g) => g.type === "bye");
  return byeGame ? byeGame.seasonWeek : null;
}

export function getTeamPrimeTimeCount(schedule, teamCode) {
  let count = 0;
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    const games = schedule.byWeek[w] || [];
    for (const g of games) {
      const isPrime =
        g.slotId === "THU" ||
        g.slotId === "SUN_820" ||
        g.slotId === "MON_700" ||
        g.slotId === "MON_1000";
      if (
        isPrime &&
        (g.homeTeam === teamCode || g.awayTeam === teamCode)
      ) {
        count++;
      }
    }
  }
  return count;
}

// Backwards compatibility: if anything imports generateLeagueSchedule, give them
// the perfect schedule builder.
export { generatePerfectLeagueSchedule as generateLeagueSchedule };
