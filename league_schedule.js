// league_schedule.js
// -----------------------------------------------------------------------------
// Shared schedule engine (no DOM, no localStorage).
// Used by: schedule.js, franchise_gameday.js, franchise.js (season rollover).
//
// This version builds a *league-wide* 17-game / 18-week schedule:
// - No duplicate or missing matchups.
// - Each team plays exactly 17 games.
// - Exactly 1 bye week per team (Weeks 5–14 window).
// - League-wide week view (byWeek) plus per-team view (byTeam).
// - Realistic dates/times with unique TNF/SNF/MNF per week.
// - Late windows biased toward West/Mountain hosts.
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
// Rotations
// -----------------------------------------------------------------------------
// 3-year same-conference division rotation per conference.
// For each entry, keys are division → the division they play the 4-game set vs.
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

function getSameConfRotationIndex(seasonYear) {
  const baseYear = 2023;
  const rotationsLen = SAME_CONF_ROTATION.AFC.length;
  const raw = (seasonYear - baseYear) % rotationsLen;
  return raw < 0 ? raw + rotationsLen : raw;
}

export function getSameConferenceOppDivision(conference, division, seasonYear) {
  const rotations = SAME_CONF_ROTATION[conference];
  if (!rotations) return "East";
  const idx = getSameConfRotationIndex(seasonYear);
  const config = rotations[idx];
  return config[division] || division;
}

// 4-year cross-conference rotation (AFC division ↔ NFC division).
function getCrossConfOffset(seasonYear) {
  const baseYear = 2022;
  const raw = (seasonYear - baseYear) % 4;
  return raw < 0 ? raw + 4 : raw;
}

export function getCrossConferenceDivision(conference, division, seasonYear) {
  // This returns the *name* of the NFC division that the given division would face
  // in a cross-conference 4-game set, using a simple offset pattern.
  const offset = getCrossConfOffset(seasonYear);
  const divIndex = DIVISION_NAMES.indexOf(division);
  if (divIndex < 0) return "East";
  const oppIndex = (divIndex + offset) % 4;
  return DIVISION_NAMES[oppIndex];
}

// -----------------------------------------------------------------------------
// Time helpers
// -----------------------------------------------------------------------------

/**
 * Compute the *second Thursday of September* (UTC) for a given season.
 * Treated as Week 1 Thursday (TNF opener).
 */
function getSeasonStartDateUTC(seasonYear) {
  const d = new Date(Date.UTC(seasonYear, 8, 1, 0, 0, 0, 0)); // Sept 1
  const THURSDAY = 4; // 0=Sun..4=Thu
  const firstDow = d.getUTCDay();
  const offsetToFirstThu = (THURSDAY - firstDow + 7) % 7;
  const firstThuDate = 1 + offsetToFirstThu;
  const secondThuDate = firstThuDate + 7;
  d.setUTCDate(secondThuDate);
  return d;
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

function sortedPairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

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
  // Ensure stable order within divisions
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
 * Assign each team exactly one bye week between 5 and 14.
 * Roughly 3–4 byes per week.
 *
 * @returns {Object.<string, number>} teamCode -> byeWeek
 */
function createRandomByeWeeks() {
  const teams = getAllTeamCodes();
  const byeWeeksPool = [];

  // Base: each week 5–14 appears 3 times (30 slots).
  for (let w = 5; w <= 14; w++) {
    byeWeeksPool.push(w, w, w);
  }
  // Add two extra slots to reach 32 teams.
  byeWeeksPool.push(5, 6);

  shuffleInPlace(byeWeeksPool);

  /** @type {Object.<string, number>} */
  const byeWeeks = {};
  teams.forEach((teamCode, idx) => {
    byeWeeks[teamCode] = byeWeeksPool[idx % byeWeeksPool.length];
  });

  return byeWeeks;
}

// -----------------------------------------------------------------------------
// Matchup generation – full league (272 games)
// -----------------------------------------------------------------------------

/**
 * Create all 272 real games (no weeks / times yet), based on:
 * - 6 division games (home/away vs 3 rivals)
 * - 4 same-conference division rotation games
 * - 2 same-conference extra games (vs remaining divisions, rank-based)
 * - 4 cross-conference rotation games
 * - 1 cross-conference 17th game (rank-based, alternating host conference)
 *
 * @param {number} seasonYear
 * @returns {LeagueGame[]}
 */
function buildLeagueMatchups(seasonYear) {
  const divisions = groupTeamsByConfAndDiv();
  /** @type {LeagueGame[]} */
  const games = [];

  // 1) Division home/away (6 per team)
  for (const conf of ["AFC", "NFC"]) {
    for (const div of DIVISION_NAMES) {
      const teams = divisions[conf][div];
      if (!teams || teams.length !== 4) continue;
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const teamA = teams[i];
          const teamB = teams[j];
          games.push({
            week: 0,
            homeTeam: teamA,
            awayTeam: teamB,
            type: "division",
            kickoffIso: null,
            status: "scheduled",
            homeScore: null,
            awayScore: null
          });
          games.push({
            week: 0,
            homeTeam: teamB,
            awayTeam: teamA,
            type: "division",
            kickoffIso: null,
            status: "scheduled",
            homeScore: null,
            awayScore: null
          });
        }
      }
    }
  }

  const sameIdx = getSameConfRotationIndex(seasonYear);
  const crossOffset = getCrossConfOffset(seasonYear);

  // 2) Same-conference 4-game division rotation (4 per team)
  for (const conf of ["AFC", "NFC"]) {
    const config = SAME_CONF_ROTATION[conf][sameIdx];
    if (!config) continue;

    const seenPairs = new Set();
    /** @type {[string,string][]} */
    const divisionPairs = [];

    for (const div of DIVISION_NAMES) {
      const oppDiv = config[div];
      if (!oppDiv) continue;
      const key = sortedPairKey(div, oppDiv);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      divisionPairs.push([div, oppDiv]);
    }

    // Should be 2 unique pairs per conference.
    for (const [divA, divB] of divisionPairs) {
      const teamsA = divisions[conf][divA];
      const teamsB = divisions[conf][divB];
      if (!teamsA || !teamsB || teamsA.length !== 4 || teamsB.length !== 4) continue;

      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const parityEven = ((i + j) & 1) === 0;
          const homeTeam = parityEven ? teamsA[i] : teamsB[j];
          const awayTeam = parityEven ? teamsB[j] : teamsA[i];
          games.push({
            week: 0,
            homeTeam,
            awayTeam,
            type: "conference",
            kickoffIso: null,
            status: "scheduled",
            homeScore: null,
            awayScore: null
          });
        }
      }
    }
  }

  // 3) Same-conference 2 extra games based on "remaining" divisions (2 per team)
  for (const conf of ["AFC", "NFC"]) {
    const config = SAME_CONF_ROTATION[conf][sameIdx];
    if (!config) continue;

    const extraPairKeys = new Set();
    /** @type {[string,string][]} */
    const extraPairs = [];

    for (const div of DIVISION_NAMES) {
      const rotOpp = config[div];
      if (!rotOpp) continue;
      const remaining = DIVISION_NAMES.filter((d) => d !== div && d !== rotOpp);
      for (const other of remaining) {
        const key = sortedPairKey(div, other);
        if (extraPairKeys.has(key)) continue;
        extraPairKeys.add(key);
        extraPairs.push([div, other]);
      }
    }

    // extraPairs should now contain exactly 4 unique division pairs.
    for (const [divA, divB] of extraPairs) {
      const teamsA = divisions[conf][divA];
      const teamsB = divisions[conf][divB];
      if (!teamsA || !teamsB || teamsA.length !== 4 || teamsB.length !== 4) continue;

      for (let i = 0; i < 4; i++) {
        // Approximate "same rank" by index within division.
        const hostIsA = ((seasonYear + i) & 1) === 0;
        const homeTeam = hostIsA ? teamsA[i] : teamsB[i];
        const awayTeam = hostIsA ? teamsB[i] : teamsA[i];
        games.push({
          week: 0,
          homeTeam,
          awayTeam,
          type: "extra", // same-conference "extra" game
          kickoffIso: null,
          status: "scheduled",
          homeScore: null,
          awayScore: null
        });
      }
    }
  }

  // 4) Cross-conference 4-game rotation (4 per team)
  for (let idx = 0; idx < DIVISION_NAMES.length; idx++) {
    const afcDivName = DIVISION_NAMES[idx];
    const nfcDivName = DIVISION_NAMES[(idx + crossOffset) % 4];

    const afcTeams = divisions.AFC[afcDivName];
    const nfcTeams = divisions.NFC[nfcDivName];
    if (!afcTeams || !nfcTeams || afcTeams.length !== 4 || nfcTeams.length !== 4) {
      continue;
    }

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const parityEven = ((i + j) & 1) === 0;
        const homeTeam = parityEven ? afcTeams[i] : nfcTeams[j];
        const awayTeam = parityEven ? nfcTeams[j] : afcTeams[i];
        games.push({
          week: 0,
          homeTeam,
          awayTeam,
          type: "nonconference",
          kickoffIso: null,
          status: "scheduled",
          homeScore: null,
          awayScore: null
        });
      }
    }
  }

  // 5) Cross-conference 17th game (1 per team)
  // Use a different division pairing offset so it's not the same as the 4-game set.
  const seventeenthOffset = (crossOffset + 2) % 4;
  const hostConference = seasonYear % 2 === 0 ? "AFC" : "NFC"; // alternate who hosts

  for (let idx = 0; idx < DIVISION_NAMES.length; idx++) {
    const afcDivName = DIVISION_NAMES[idx];
    const nfcDivName = DIVISION_NAMES[(idx + seventeenthOffset) % 4];

    const afcTeams = divisions.AFC[afcDivName];
    const nfcTeams = divisions.NFC[nfcDivName];
    if (!afcTeams || !nfcTeams || afcTeams.length !== 4 || nfcTeams.length !== 4) continue;

    for (let i = 0; i < 4; i++) {
      let homeTeam, awayTeam;
      if (hostConference === "AFC") {
        homeTeam = afcTeams[i];
        awayTeam = nfcTeams[i];
      } else {
        homeTeam = nfcTeams[i];
        awayTeam = afcTeams[i];
      }
      games.push({
        week: 0,
        homeTeam,
        awayTeam,
        type: "nonconference", // still interconference, but it's the 17th
        kickoffIso: null,
        status: "scheduled",
        homeScore: null,
        awayScore: null
      });
    }
  }

  return games;
}

// -----------------------------------------------------------------------------
// Week assignment (1–18) – respects byes & prevents overlaps
// -----------------------------------------------------------------------------

const WEEK_PREFERENCES = {
  nonconference: { min: 1, max: 14 },
  conference:    { min: 2, max: 17 },
  extra:         { min: 4, max: 15 },
  division:      { min: 5, max: 18 }
};

const MAX_GAMES_PER_WEEK_SOFT = 16;

/**
 * Assign each LeagueGame to a week (1–18) such that:
 * - Each team has at most 1 game per week.
 * - Each team never plays on its assigned bye week.
 *
 * @param {LeagueGame[]} games
 * @param {Object.<string, number>} teamByeWeek
 * @returns {LeagueGame[][]} weeks[weekIndex] -> LeagueGame[]
 */
function assignWeeksToGames(games, teamByeWeek) {
  /** @type {LeagueGame[][]} */
  const weeks = Array.from({ length: REGULAR_SEASON_WEEKS }, () => []);
  /** @type {Object.<string, Set<number>>} */
  const teamWeekSets = {};
  for (const t of TEAM_META) {
    teamWeekSets[t.teamCode] = new Set();
  }

  // Partition by type and shuffle within each for variety.
  const divisionGames   = games.filter((g) => g.type === "division");
  const conferenceGames = games.filter((g) => g.type === "conference");
  const extraGames      = games.filter((g) => g.type === "extra");
  const nonConfGames    = games.filter((g) => g.type === "nonconference");

  shuffleInPlace(divisionGames);
  shuffleInPlace(conferenceGames);
  shuffleInPlace(extraGames);
  shuffleInPlace(nonConfGames);

  const queue = [
    ...nonConfGames,    // interconference first
    ...conferenceGames, // then conference
    ...extraGames,      // then extra conference
    ...divisionGames    // division games tend to land late
  ];

  for (const game of queue) {
    const home = game.homeTeam;
    const away = game.awayTeam;
    const pref = WEEK_PREFERENCES[game.type] || { min: 1, max: REGULAR_SEASON_WEEKS };

    let chosenWeek = 0;

    // First pass: honour preferred window + soft cap.
    outer: for (let week = pref.min; week <= pref.max; week++) {
      if (week === teamByeWeek[home] || week === teamByeWeek[away]) continue;
      if (teamWeekSets[home].has(week) || teamWeekSets[away].has(week)) continue;
      if (weeks[week - 1].length >= MAX_GAMES_PER_WEEK_SOFT) continue;
      chosenWeek = week;
      break outer;
    }

    // Second pass: full 1–18, ignore preferred window, keep bye + overlap constraints.
    if (!chosenWeek) {
      outer2: for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
        if (week === teamByeWeek[home] || week === teamByeWeek[away]) continue;
        if (teamWeekSets[home].has(week) || teamWeekSets[away].has(week)) continue;
        chosenWeek = week;
        break outer2;
      }
    }

    // Last resort: if something went wrong, allow ignoring bye (should be extremely rare).
    if (!chosenWeek) {
      chosenWeek = 1;
    }

    game.week = chosenWeek;
    weeks[chosenWeek - 1].push(game);
    teamWeekSets[home].add(chosenWeek);
    teamWeekSets[away].add(chosenWeek);
  }

  return weeks;
}

// -----------------------------------------------------------------------------
// Time slot assignment
// -----------------------------------------------------------------------------

/**
 * Assign realistic time slots + kickoffIso to each game in each week:
 * - 1 TNF, 1 SNF, 1 MNF per week (when possible).
 * - Occasional London game (Weeks 5–8).
 * - 2–3 games at 4:15, 1–2 at 4:25.
 * - Rest at 1:00.
 * - Late windows heavily biased to West/Mountain hosts.
 * - No team has both a TNF and a MNF during the season.
 *
 * @param {LeagueGame[][]} weeks
 * @param {number} seasonYear
 */
function assignTimesToGames(weeks, seasonYear) {
  const seasonStartUtc = getSeasonStartDateUTC(seasonYear);

  /** @type {Object.<string, {thu:boolean, mon:boolean, sunNight:boolean}>} */
  const primeUsage = {};
  for (const t of TEAM_META) {
    primeUsage[t.teamCode] = { thu: false, mon: false, sunNight: false };
  }

  const possibleLondonWeeks = [5, 6, 7, 8];
  let londonGamesUsed = 0;
  const maxLondonGames = 3;

  for (let idx = 0; idx < weeks.length; idx++) {
    const calendarWeek = idx + 1;
    const games = weeks[idx];
    if (!games || games.length === 0) continue;

    // Use a Set so we can remove games as they're assigned slots.
    const unassigned = new Set(games);

    const popGame = (predicate) => {
      for (const g of unassigned) {
        if (predicate(g)) {
          unassigned.delete(g);
          return g;
        }
      }
      return null;
    };

    // ---- Thursday Night Football (TNF) ----
    const tnfGame =
      popGame((g) => {
        const puH = primeUsage[g.homeTeam];
        const puA = primeUsage[g.awayTeam];
        return !puH.thu && !puA.thu && !puH.mon && !puA.mon;
      }) ||
      popGame((g) => {
        const puH = primeUsage[g.homeTeam];
        const puA = primeUsage[g.awayTeam];
        return !puH.thu && !puA.thu;
      });

    if (tnfGame) {
      tnfGame.slotId = "THU";
      primeUsage[tnfGame.homeTeam].thu = true;
      primeUsage[tnfGame.awayTeam].thu = true;
    }

    // ---- Sunday Night Football (SNF) ----
    const snfGame =
      popGame((g) => {
        const puH = primeUsage[g.homeTeam];
        const puA = primeUsage[g.awayTeam];
        return !puH.sunNight && !puA.sunNight;
      }) || popGame(() => true);

    if (snfGame) {
      snfGame.slotId = "SUN_820";
      primeUsage[snfGame.homeTeam].sunNight = true;
      primeUsage[snfGame.awayTeam].sunNight = true;
    }

    // ---- Monday Night Football (MNF) ----
    const mnfGame =
      popGame((g) => {
        const puH = primeUsage[g.homeTeam];
        const puA = primeUsage[g.awayTeam];
        return !puH.mon && !puA.mon && !puH.thu && !puA.thu;
      }) ||
      popGame((g) => {
        const puH = primeUsage[g.homeTeam];
        const puA = primeUsage[g.awayTeam];
        return !puH.mon && !puA.mon;
      });

    if (mnfGame) {
      // Choose early/late based on host being late-window friendly.
      const hostLate = LATE_HOSTS.has(mnfGame.homeTeam);
      mnfGame.slotId = hostLate ? "MON_1000" : "MON_700";
      primeUsage[mnfGame.homeTeam].mon = true;
      primeUsage[mnfGame.awayTeam].mon = true;
    }

    // ---- Potential London game (Sun 9:30) ----
    if (
      possibleLondonWeeks.includes(calendarWeek) &&
      londonGamesUsed < maxLondonGames &&
      unassigned.size > 0
    ) {
      const londonGame =
        popGame((g) => !LATE_HOSTS.has(g.homeTeam)) || // prefer East/Central hosts
        null;
      if (londonGame) {
        londonGame.slotId = "SUN_930";
        londonGamesUsed++;
      }
    }

    // ---- Late windows (4:15 / 4:25) ----
    const totalGames = games.length;
    let remainingForLate = unassigned.size;

    let late415Count = Math.min(3, Math.max(2, Math.round(totalGames * 0.2)));
    let late425Count = Math.min(2, Math.max(1, Math.round(totalGames * 0.1)));

    if (late415Count + late425Count > remainingForLate) {
      let diff = late415Count + late425Count - remainingForLate;
      while (diff > 0 && late415Count > 1) {
        late415Count--;
        diff--;
      }
      while (diff > 0 && late425Count > 0) {
        late425Count--;
        diff--;
      }
      if (late415Count + late425Count > remainingForLate) {
        late415Count = Math.min(late415Count, remainingForLate);
        late425Count = 0;
      }
    }

    const assignLateSlot = (slotId, count) => {
      for (let i = 0; i < count; i++) {
        if (unassigned.size === 0) break;
        const preferred =
          popGame((g) => LATE_HOSTS.has(g.homeTeam)) ||
          popGame(() => true);
        if (preferred) preferred.slotId = slotId;
      }
    };

    assignLateSlot("SUN_415", late415Count);
    assignLateSlot("SUN_425", late425Count);

    // ---- Remaining games: Sunday 1:00 ----
    for (const g of unassigned) {
      g.slotId = "SUN_1";
    }

    // ---- Convert slots to kickoffIso ----
    for (const g of games) {
      const slotKey = g.slotId || "SUN_1";
      const slot = SLOT_DEFS[slotKey] || SLOT_DEFS.SUN_1;

      const kickoff = new Date(seasonStartUtc.getTime());
      kickoff.setUTCDate(
        seasonStartUtc.getUTCDate() +
          (g.week - 1) * 7 +
          slot.dayOffset
      );
      kickoff.setUTCHours(slot.hour, slot.minute, 0, 0);
      g.kickoffIso = kickoff.toISOString();
    }
  }
}

// -----------------------------------------------------------------------------
// League schedule builder (byWeek + byTeam)
// -----------------------------------------------------------------------------

/**
 * Generate the full league schedule (272 games) for a given season year.
 *
 * @param {number} seasonYear
 * @returns {LeagueSchedule}
 */
function generateLeagueSchedule(seasonYear) {
  // 1) Build all matchups (no weeks / times)
  const matchups = buildLeagueMatchups(seasonYear);

  // 2) Assign a bye week for each team, then weeks for each game
  const teamByeWeek = createRandomByeWeeks();
  const weeks = assignWeeksToGames(matchups, teamByeWeek);

  // 3) Assign realistic time slots and kickoffIso
  assignTimesToGames(weeks, seasonYear);

  // 4) Build byWeek & byTeam views
  /** @type {Object.<number, LeagueGame[]>} */
  const byWeek = {};
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    const gamesThisWeek = weeks[w - 1] || [];
    byWeek[w] = gamesThisWeek.map((g) => ({
      week: g.week,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      type: g.type,
      kickoffIso: g.kickoffIso,
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore
    }));
  }

  /** @type {Object.<string, TeamGame[]>} */
  const byTeam = {};
  for (const t of TEAM_META) {
    byTeam[t.teamCode] = [];
  }

  // Fill team schedules from week view
  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    const gamesThisWeek = byWeek[week] || [];
    for (const g of gamesThisWeek) {
      const home = g.homeTeam;
      const away = g.awayTeam;

      byTeam[home].push({
        index: 0, // temporary, fix later
        seasonWeek: week,
        teamCode: home,
        opponentCode: away,
        isHome: true,
        type: g.type === "extra" ? "extra" : g.type,
        kickoffIso: g.kickoffIso,
        status: g.status,
        teamScore: g.homeScore,
        opponentScore: g.awayScore
      });

      byTeam[away].push({
        index: 0, // temporary, fix later
        seasonWeek: week,
        teamCode: away,
        opponentCode: home,
        isHome: false,
        type: g.type === "extra" ? "extra" : g.type,
        kickoffIso: g.kickoffIso,
        status: g.status,
        teamScore: g.awayScore,
        opponentScore: g.homeScore
      });
    }
  }

  // Insert explicit BYE weeks for each team so they have 18 entries.
  for (const team of getAllTeamCodes()) {
    const arr = byTeam[team] || [];
    const weeksWithGame = new Set(arr.map((g) => g.seasonWeek));

    for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
      if (!weeksWithGame.has(week)) {
        arr.push({
          index: 0, // temp
          seasonWeek: week,
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
    }

    // Sort by week and fix indices so index = seasonWeek - 1
    arr.sort((a, b) => a.seasonWeek - b.seasonWeek);
    arr.forEach((g, idx) => {
      g.index = idx;
    });

    byTeam[team] = arr;
  }

  return {
    seasonYear,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    byTeam,
    byWeek
  };
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
    const fresh = generateLeagueSchedule(seasonYear);
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
    // Should not happen because generateLeagueSchedule populates all teams,
    // but fall back gracefully.
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
