// league_schedule.js
// -----------------------------------------------------------------------------
// Shared schedule engine (no DOM, no localStorage).
// Used by: schedule.js, schedule_gameday.js, schedule_grid.js, franchise.js.
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

// Bump this any time the schedule structure / algorithm changes
export const SCHEDULE_SCHEMA_VERSION = 4;

// Set true while developing to log detailed schedule summaries to console
const SCHEDULE_DEBUG = false;


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
  { teamCode: "GB",  teamCodeAlt: "GB",    city: "Green Bay",  name: "Packers",   conference: "NFC", division: "North" }, // teamCodeAlt is harmless; keep teamCode primary
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
const INTRA_CONF_PAIRS = [
  ["East", "North"],
  ["South", "West"]
];

// Cross-conference “helper” for other modules (not used directly by the builder)
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

// Rotation helpers kept for compatibility / future use
export function getSameConferenceOppDivision(_conference, division, _seasonYear) {
  for (const [a, b] of INTRA_CONF_PAIRS) {
    if (division === a) return b;
    if (division === b) return a;
  }
  return "East";
}

export function getCrossConferenceDivision(conference, division, _seasonYear) {
  const confMap = CROSS_CONF_ROTATION[conference];
  if (!confMap) return "East";
  return confMap[division] || "East";
}


// -----------------------------------------------------------------------------
// Time helpers (kickoff slotting, unchanged from your good “timing” logic)
// -----------------------------------------------------------------------------

function getSeasonStartDateLocal(seasonYear) {
  const d = new Date(seasonYear, 8, 1, 0, 0, 0, 0); // month 8 = September
  const THURSDAY = 4; // 0 = Sun ... 4 = Thu
  const firstDow = d.getDay();

  const offsetToFirstThu = (THURSDAY - firstDow + 7) % 7;
  const firstThuDate = 1 + offsetToFirstThu;
  const secondThuDate = firstThuDate + 7;

  d.setDate(secondThuDate);
  return d; // local midnight of the second Thursday in September
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

  for (const conf of ["AFC", "NFC"]) {
    for (const div of DIVISION_NAMES) {
      map[conf][div].sort();
    }
  }

  return map;
}


// -----------------------------------------------------------------------------
// Base matchup generation (type & opponent formula, no home/away, no weeks)
// -----------------------------------------------------------------------------
//
// This is the same “opponent math” you had before; we’ll only use it to build
// per-team opponent lists, then layer home/away + weeks on top.
// -----------------------------------------------------------------------------

/**
 * Create all 272 matchups (no weeks / times yet), based on the same formula:
 *
 * - 6 division games (home/away vs 3 rivals)
 * - 4 same-conference division rotation games
 * - 2 same-conference "extra" rank-based games
 * - 4 cross-conference rotation games
 * - 1 17th cross-conference rank-based game
 *
 * Home/away here is just a temporary placeholder; we will recompute
 * home/away later via the team-first algorithm.
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

  // 1) Division home/away (6 per team, 96 games total)
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

  // 2) Same-conference 4-game division rotation (4 per team, 64 games total)
  for (const conf of ["AFC", "NFC"]) {
    for (const [divA, divB] of INTRA_CONF_PAIRS) {
      const teamsA = divisions[conf][divA];
      const teamsB = divisions[conf][divB];
      if (!teamsA || !teamsB || teamsA.length !== 4 || teamsB.length !== 4) continue;

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

  // 3) Cross-conference 4-game rotation (4 per team, 64 games total)
  //
  //   AFC East  vs NFC North
  //   AFC North vs NFC South
  //   AFC South vs NFC West
  //   AFC West  vs NFC East
  //
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

  // 4) Same-conference "extra" rank-based (2 per team, 32 games total)
  for (const conf of ["AFC", "NFC"]) {
    for (const divA of DIVISION_NAMES) {
      const teamsA = divisions[conf][divA];
      if (!teamsA || teamsA.length !== 4) continue;

      const rotB = getSameConferenceOppDivision(conf, divA);
      const remainingDivs = DIVISION_NAMES.filter(
        (d) => d !== divA && d !== rotB
      );
      if (remainingDivs.length !== 2) continue;

      const [divBName, divCName] = remainingDivs;
      const teamsB = divisions[conf][divBName];
      const teamsC = divisions[conf][divCName];
      if (!teamsB || !teamsC) continue;

      // divA vs divB
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

      // divA vs divC
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

  // 5) 17th game cross-conference (1 per team, 16 games total)
  //
  //   AFC East  vs NFC South
  //   AFC North vs NFC West
  //   AFC South vs NFC East
  //   AFC West  vs NFC North
  //
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
 * This is derived directly from buildLeagueMatchups (ignoring weeks/home/away).
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
// Bye week allocation (Weeks 5–14, even counts where > 0)
// -----------------------------------------------------------------------------

/**
 * Assigns one bye per team between Weeks 5–14 (NFL-like window).
 * Pattern: [4,2,2,6,4,4,2,4,0,4] → 32 byes total.
 * All non-zero entries are even.
 *
 * @returns {Object.<string, number>} teamCode -> byeWeek
 */
function createRandomByeWeeks() {
  const teams = getAllTeamCodes();
  const byeWeeks = {};

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

  // Safety: any unassigned teams (shouldn't happen) get a random 5–14 slot.
  for (const t of teams) {
    if (!byeWeeks[t]) {
      byeWeeks[t] = baseWeeks[Math.floor(Math.random() * baseWeeks.length)];
    }
  }

  return byeWeeks;
}


// -----------------------------------------------------------------------------
// Week assignment helper (reused core, but fed by team-first iteration)
// -----------------------------------------------------------------------------

/**
 * Pick an appropriate week for a game.
 * Ensures: no bye conflict, no team double-bookings, and balanced weekly load.
 *
 * @param {LeagueGame & { homeTeam: string, awayTeam: string }} game
 * @param {number[]} candidateWeeks - preferred range to try first
 * @param {Object.<string, number>} byeWeeks - team → bye week
 * @param {Object.<string, Set<number>>} bookedWeeks - team → played weeks
 * @param {Object.<number, number>} weeklyGameCount - week → total games already scheduled
 * @returns {number} chosen week (1–18)
 */
function pickWeekForGame(game, candidateWeeks, byeWeeks, bookedWeeks, weeklyGameCount) {
  const home = game.homeTeam;
  const away = game.awayTeam;

  const primary = candidateWeeks.slice();
  shuffleInPlace(primary);

  // Preferred range
  for (const w of primary) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    if (bookedWeeks[home].has(w) || bookedWeeks[away].has(w)) continue;
    if ((weeklyGameCount[w] ?? 0) >= 16) continue; // avoid >16 games in any week
    return w;
  }

  // Broader search (1–18)
  const allWeeks = Array.from({ length: REGULAR_SEASON_WEEKS }, (_, i) => i + 1);
  shuffleInPlace(allWeeks);
  for (const w of allWeeks) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    if (bookedWeeks[home].has(w) || bookedWeeks[away].has(w)) continue;
    if ((weeklyGameCount[w] ?? 0) >= 16) continue;
    return w;
  }

  // Emergency fallback – avoid bye conflicts at least
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    if (w !== byeWeeks[home] && w !== byeWeeks[away]) return w;
  }

  console.warn("[league_schedule] Emergency week assignment for", game);
  return 1;
}


// -----------------------------------------------------------------------------
// Step 1+2: From per-team opponent lists → league games with home/away
// -----------------------------------------------------------------------------

/**
 * Build a league-wide game list from per-team opponent lists:
 *  - First, create canonical pairs (teamA < teamB) with correct multiplicity
 *    (2x for divisional, 1x otherwise).
 *  - Then assign home/away:
 *      • For division pairs with 2 games → one home each.
 *      • For others → balance to target 8/9 home games using conference parity.
 *
 * @param {number} seasonYear
 * @returns {LeagueGame[]} games with homeTeam, awayTeam, type, week=0
 */
function buildLeagueGamesFromTeamOpponents(seasonYear) {
  const opponentsByTeam = getTeamOpponents(seasonYear);
  const teams = getAllTeamCodes().slice().sort(); // alphabetical (starts with ARI)

  /** @type {LeagueGame[]} */
  const games = [];

  // 1) Build canonical pairs with multiplicity
  const pairToIndices = new Map(); // "A-B" -> [indices into games]

  for (const team of teams) {
    const oppEntries = opponentsByTeam[team] || [];
    /** @type {Map<string, {count: number, type: string}>} */
    const counts = new Map();

    for (const { opponentCode, type } of oppEntries) {
      if (!opponentCode) continue;
      const existing = counts.get(opponentCode);
      if (!existing) {
        counts.set(opponentCode, { count: 1, type });
      } else {
        existing.count += 1;
        if (existing.type !== type) {
          console.warn(
            "[league_schedule] Mixed game types for pair",
            team,
            opponentCode,
            existing.type,
            type
          );
        }
      }
    }

    for (const [opp, info] of counts.entries()) {
      const a = team;
      const b = opp;
      if (a >= b) continue; // only process canonical pair once

      const type = info.type || "nonconference";
      const count = info.count || 1;

      for (let i = 0; i < count; i++) {
        const index = games.length;
        games.push({
          week: 0,
          homeTeam: "",   // filled later
          awayTeam: "",
          type,
          kickoffIso: null,
          status: "scheduled",
          homeScore: null,
          awayScore: null
        });

        const key = `${a}-${b}`;
        if (!pairToIndices.has(key)) pairToIndices.set(key, []);
        pairToIndices.get(key).push(index);
      }
    }
  }

  // 2) Assign home/away
  const homeCount = {};
  const desiredHomeCount = {};
  const hostConference = seasonYear % 2 === 0 ? "AFC" : "NFC";

  for (const t of teams) {
    const meta = getTeamMeta(t);
    const conf = meta ? meta.conference : "AFC";
    homeCount[t] = 0;
    desiredHomeCount[t] = (conf === hostConference) ? 9 : 8;
  }

  // 2a) Division pairs with 2 games → one home each
  for (const [key, idxList] of pairToIndices.entries()) {
    const [a, b] = key.split("-");
    const indices = idxList.slice();
    const firstGame = games[indices[0]];
    if (!firstGame) continue;

    const isDivision = firstGame.type === "division";
    if (!isDivision) continue;
    if (indices.length !== 2) {
      console.warn(
        "[league_schedule] Division pair with != 2 games:",
        key,
        "count=",
        indices.length
      );
      // fall through and let generic logic handle it
      continue;
    }

    const g1 = games[indices[0]];
    const g2 = games[indices[1]];

    g1.homeTeam = a; g1.awayTeam = b;
    g2.homeTeam = b; g2.awayTeam = a;

    homeCount[a] += 1;
    homeCount[b] += 1;
  }

  // 2b) All remaining games (non-division + any weird leftovers)
  for (const [key, idxList] of pairToIndices.entries()) {
    const [a, b] = key.split("-");
    for (const idx of idxList) {
      const g = games[idx];
      if (!g) continue;
      if (g.homeTeam && g.awayTeam) continue; // already assigned

      const needA = (desiredHomeCount[a] ?? 8) - (homeCount[a] ?? 0);
      const needB = (desiredHomeCount[b] ?? 8) - (homeCount[b] ?? 0);

      let home;
      if (needA > 0 && needB <= 0) {
        home = a;
      } else if (needB > 0 && needA <= 0) {
        home = b;
      } else if (needA > needB) {
        home = a;
      } else if (needB > needA) {
        home = b;
      } else {
        // tie-breaker: alphabetical
        home = a < b ? a : b;
      }

      const away = home === a ? b : a;
      g.homeTeam = home;
      g.awayTeam = away;
      homeCount[home] = (homeCount[home] ?? 0) + 1;
    }
  }

  // Sanity check: every game must now have home/away
  for (const g of games) {
    if (!g.homeTeam || !g.awayTeam) {
      console.warn("[league_schedule] Game without home/away after assignment:", g);
    }
  }

  return games;
}


// -----------------------------------------------------------------------------
// Step 3+4: assign byes, then weeks via team-by-team iteration
// -----------------------------------------------------------------------------

/**
 * Assign weeks to each game:
 *  - One bye per team (precomputed).
 *  - No team doubleheaders.
 *  - Uses candidate week ranges based on game type:
 *      • division → late + mid
 *      • nonconference → early + mid
 *      • conference/extra → mid-biased
 *
 * Games are processed team-by-team in alphabetical order (starting with ARI).
 *
 * @param {LeagueGame[]} games
 * @param {Object.<string, number>} byeWeeks
 * @returns {LeagueGame[][]} weeks[0..17] each an array of LeagueGame
 */
function assignWeeksTeamFirst(games, byeWeeks) {
  const teams = getAllTeamCodes();
  const teamsSorted = teams.slice().sort(); // starts with ARI

  /** @type {LeagueGame[][]} */
  const weeks = Array.from({ length: REGULAR_SEASON_WEEKS }, () => []);

  /** @type {Object.<string, Set<number>>} */
  const bookedWeeks = {};
  /** @type {Object.<number, number>} */
  const weeklyGameCount = {};

  for (const t of teams) {
    bookedWeeks[t] = new Set();
  }

  // Index games by team for quick team-first iteration
  /** @type {Record<string, number[]>} */
  const gamesByTeam = {};
  for (const t of teams) gamesByTeam[t] = [];

  games.forEach((g, idx) => {
    gamesByTeam[g.homeTeam].push(idx);
    gamesByTeam[g.awayTeam].push(idx);
  });

  const earlyWeeks = [1, 2, 3, 4];
  const midWeeks   = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const lateWeeks  = [15, 16, 17, 18];

  for (const team of teamsSorted) {
    const idxList = gamesByTeam[team] || [];
    const seen = new Set();

    for (const idx of idxList) {
      if (seen.has(idx)) continue;
      seen.add(idx);

      const g = games[idx];
      if (g.week && g.week !== 0) continue; // opponent already assigned this

      let candidateWeeks;
      if (g.type === "division") {
        candidateWeeks = lateWeeks.concat(midWeeks);
      } else if (g.type === "nonconference") {
        candidateWeeks = earlyWeeks.concat(midWeeks);
      } else {
        candidateWeeks = midWeeks.concat(earlyWeeks, lateWeeks);
      }

      const week = pickWeekForGame(
        g,
        candidateWeeks,
        byeWeeks,
        bookedWeeks,
        weeklyGameCount
      );

      g.week = week;
      weeks[week - 1].push(g);
      bookedWeeks[g.homeTeam].add(week);
      bookedWeeks[g.awayTeam].add(week);
      weeklyGameCount[week] = (weeklyGameCount[week] ?? 0) + 1;
    }
  }

  return weeks;
}


// -----------------------------------------------------------------------------
// Assign kickoff times (TNF / SNF / MNF + Sunday windows + occasional London)
// -----------------------------------------------------------------------------

function assignTimesToWeeks(weeks, seasonYear) {
  const baseDate = getSeasonStartDateLocal(seasonYear);

  const primeUsage = {
    THU: new Set(), // Thursday night
    SNF: new Set(), // Sunday night
    MNF: new Set()  // Monday night
  };

  function scheduleGameAtSlot(game, weekIndex, slotDef, slotId) {
    if (!game) return;

    const kickoff = new Date(baseDate);
    kickoff.setDate(baseDate.getDate() + weekIndex * 7 + slotDef.dayOffset);
    kickoff.setHours(slotDef.hour, slotDef.minute, 0, 0);

    const eastern = new Date(
      kickoff.toLocaleString("en-US", { timeZone: "America/New_York" })
    );

    game.kickoffIso = eastern.toISOString();
    game.slotId = slotId;
    if (!game.status) game.status = "scheduled";
  }

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
    const g = pool.pop();
    if (!g) return null;
    usageSet.add(g.homeTeam);
    usageSet.add(g.awayTeam);
    return g;
  }

  for (let week = 1; week <= weeks.length; week++) {
    const games = weeks[week - 1];
    if (!games.length) continue;

    const pool = games.slice();
    shuffleInPlace(pool);

    // Optional London / international game (Weeks 5–8)
    let londonGame = null;
    if (week >= 5 && week <= 8 && pool.length && Math.random() < 0.25) {
      let idx = -1;
      for (let i = 0; i < pool.length; i++) {
        const g = pool[i];
        if (!LATE_HOSTS.has(g.homeTeam)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) idx = 0;
      londonGame = pool.splice(idx, 1)[0];
      scheduleGameAtSlot(londonGame, week - 1, SLOT_DEFS.SUN_930, "SUN_930");
    }

    const tnf = pickPrimeGame(pool, primeUsage.THU);
    const snf = pickPrimeGame(pool, primeUsage.SNF);
    const mnf = pickPrimeGame(pool, primeUsage.MNF);

    scheduleGameAtSlot(tnf, week - 1, SLOT_DEFS.THU, "THU");
    scheduleGameAtSlot(snf, week - 1, SLOT_DEFS.SUN_820, "SUN_820");

    if (mnf) {
      const mondayDef =
        Math.random() < 0.5 ? SLOT_DEFS.MON_700 : SLOT_DEFS.MON_1000;
      const mondayId =
        mondayDef === SLOT_DEFS.MON_700 ? "MON_700" : "MON_1000";
      scheduleGameAtSlot(mnf, week - 1, mondayDef, mondayId);
    }

    const remaining = games.filter((g) => !g.kickoffIso);

    for (const g of remaining) {
      let slotDef;
      let slotId;

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
// Perfect NFL-style schedule builder (new pipeline)
// -----------------------------------------------------------------------------

export function generatePerfectLeagueSchedule(seasonYear) {
  // Step 1+2: build league games from per-team opponent lists, with home/away
  const games = buildLeagueGamesFromTeamOpponents(seasonYear);

  // Step 3: assign byes
  const byeWeeks = createRandomByeWeeks();

  // Step 4: assign weeks team-by-team (alphabetical)
  const weeks = assignWeeksTeamFirst(games, byeWeeks);

  // Step 5: assign kickoff times / slots
  assignTimesToWeeks(weeks, seasonYear);

  // Step 6: build byWeek / byTeam structures expected by schedule.js & grid
  /** @type {Record<number, LeagueGame[]>} */
  const byWeek = {};
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    const weekGames = weeks[w - 1] || [];
    byWeek[w] = weekGames.map((g) => ({
      week: w,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      type: g.type,
      kickoffIso: g.kickoffIso,
      status: g.status || "scheduled",
      homeScore: g.homeScore ?? null,
      awayScore: g.awayScore ?? null,
      slotId: g.slotId
    }));
  }

  /** @type {Record<string, TeamGame[]>} */
  const byTeam = {};
  for (const t of getAllTeamCodes()) byTeam[t] = [];

  for (const [weekStr, gamesForWeek] of Object.entries(byWeek)) {
    const w = Number(weekStr);
    for (const g of gamesForWeek) {
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

  // Step 7: insert explicit bye objects into team schedules
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

  // Step 8: sort each team’s schedule and set index
  for (const team of getAllTeamCodes()) {
    const arr = byTeam[team].sort((a, b) => (a.seasonWeek || 0) - (b.seasonWeek || 0));
    arr.forEach((g, i) => {
      g.index = i;
    });
  }

  const schedule = {
    seasonYear,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    byTeam,
    byWeek
  };

  if (SCHEDULE_DEBUG) {
    debugPrintScheduleSummary(schedule);
    validateLeagueSchedule(schedule);
  }

  return schedule;
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
    existing &&
    existing.seasonYear === seasonYear &&
    existing.schemaVersion === SCHEDULE_SCHEMA_VERSION
  ) {
    return existing;
  }

  const fresh = generatePerfectLeagueSchedule(seasonYear);
  leagueState.schedule = fresh;
  return fresh;
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
  return ensureLeagueScheduleObject(leagueState, seasonYear);
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

  // Per-week
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

  // Per-team
  console.groupCollapsed("By team (game counts, bye, doubleheaders)");
  for (const team of teams) {
    const games = schedule.byTeam[team] || [];
    const bye = games.find((g) => g.type === "bye") || null;
    const nonBye = games.filter((g) => g.type !== "bye");

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
// the “perfect” schedule builder.
export { generatePerfectLeagueSchedule as generateLeagueSchedule };
