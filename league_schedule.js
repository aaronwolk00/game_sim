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
// - No duplicate or missing matchups.
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
// Rotation helpers (simple deterministic mapping – NFL-style but not exact)
// -----------------------------------------------------------------------------

// Two-year cycle for intra-conference division rotations.
const SAME_CONF_ROTATION = {
  AFC: [
    { East: "North", North: "West", South: "East", West: "South" },
    { East: "West",  North: "South", South: "North", West: "East" }
  ],
  NFC: [
    { East: "North", North: "West", South: "East", West: "South" },
    { East: "West",  North: "South", South: "North", West: "East" }
  ]
};

function getSameConfRotationIndex(seasonYear) {
  // 2022 -> 0, 2023 -> 1, 2024 -> 0, ...
  return Math.abs(seasonYear - 2022) % 2;
}

// 3-step cycle for cross-conference rotations.
function getCrossConfOffset(seasonYear) {
  // Cycle through 1,2,3,1,2,3,...
  const diff = seasonYear - 2022;
  const mod = ((diff % 3) + 3) % 3; // 0..2
  return mod + 1; // 1..3
}

// Used by UI to describe rotations; matches the generator logic.
export function getSameConferenceOppDivision(conference, division, seasonYear) {
  const idx = getSameConfRotationIndex(seasonYear);
  const confMap = SAME_CONF_ROTATION[conference];
  if (!confMap) return "East";
  return confMap[idx][division] || "East";
}

export function getCrossConferenceDivision(conference, division, seasonYear) {
  const baseIdx = DIVISION_NAMES.indexOf(division);
  if (baseIdx === -1) return "East";
  const offset = getCrossConfOffset(seasonYear);
  const targetIdx = (baseIdx + offset) % DIVISION_NAMES.length;
  return DIVISION_NAMES[targetIdx];
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
 * Each week has exactly 3–4 bye teams; total = 32 teams.
 * Ensures fully random distribution without repeats.
 *
 * @returns {Object.<string, number>} teamCode -> byeWeek
 */
 function createRandomByeWeeks() {
    const teams = getAllTeamCodes();
    const byeWeeks = {};
  
    // Weeks 5–14 inclusive → 10 possible bye weeks
    const byeSlots = [];
    const baseWeeks = [5,6,7,8,9,10,11,12,13,14];
  
    const byePattern = [4,2,2,6,4,4,2,4,0,4];
    const shuffledTeams = [...teams];
    shuffleInPlace(shuffledTeams);
  
    let cursor = 0;
    for (let i = 0; i < baseWeeks.length; i++) {
      const w = baseWeeks[i];
      const count = byePattern[i];
      for (let j = 0; j < count; j++) {
        if (cursor >= shuffledTeams.length) break;
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
 * Create all 272 games (no weeks / times yet), based on:
 * - 6 division games (home/away vs 3 rivals)
 * - 4 same-conference division rotation games
 * - 2 same-conference "extra" games (vs remaining divisions, rank-based-ish)
 * - 4 cross-conference rotation games
 * - 1 cross-conference 17th game (rank-based-ish, alternating host conference)
 *
 * @param {number} seasonYear
 * @returns {LeagueGame[]}
 */
 function buildLeagueMatchups(seasonYear) {
    const divisions = groupTeamsByConfAndDiv();
    /** @type {LeagueGame[]} */
    const games = [];
  
    // ---------------------------------------------------------------------------
    // 1) Division home/away (6 per team, 96 games total)
    // ---------------------------------------------------------------------------
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
  
    // ---------------------------------------------------------------------------
    // 2) Same-conference 4-game division rotation (4 per team, 64 games total)
    // ---------------------------------------------------------------------------
    const sameIdx = getSameConfRotationIndex(seasonYear);
    const crossOffset = getCrossConfOffset(seasonYear);
  
    for (const conf of ["AFC", "NFC"]) {
      const config = SAME_CONF_ROTATION[conf][sameIdx];
      if (!config) continue;
  
      const seenPairs = new Set();
      /** @type {[string, string][]} */
      const divisionPairs = [];
  
      for (const div of DIVISION_NAMES) {
        const oppDiv = config[div];
        if (!oppDiv) continue;
        const key = sortedPairKey(div, oppDiv);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        divisionPairs.push([div, oppDiv]);
      }
  
      // Expect 2 unique pairs per conference.
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
  
    // ---------------------------------------------------------------------------
    // 3) Same-conference 2 "extra" games per team (32 games total)
    //
    // We use a fixed, symmetric pairing of divisions inside each conference:
    //   East ↔ South, East ↔ West, North ↔ South, North ↔ West
    // This gives each division exactly two extra-opponent divisions and
    // therefore each team exactly 2 extra intra-conference games.
    // ---------------------------------------------------------------------------
    const EXTRA_DIV_PAIRS = [
      ["East", "South"],
      ["East", "West"],
      ["North", "South"],
      ["North", "West"]
    ];
  
    for (const conf of ["AFC", "NFC"]) {
      for (const [divA, divB] of EXTRA_DIV_PAIRS) {
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
            type: "extra",
            kickoffIso: null,
            status: "scheduled",
            homeScore: null,
            awayScore: null
          });
        }
      }
    }
  
    // ---------------------------------------------------------------------------
    // 4) Cross-conference 4-game rotation (4 per team, 64 games total)
    // ---------------------------------------------------------------------------
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
  
    // ---------------------------------------------------------------------------
    // 5) Cross-conference 17th game (1 per team, 16 games total)
    // ---------------------------------------------------------------------------
    const seventeenthOffset = (crossOffset + 2) % 4;
    const hostConference = seasonYear % 2 === 0 ? "AFC" : "NFC"; // alternate host
  
    for (let idx = 0; idx < DIVISION_NAMES.length; idx++) {
      const afcDivName = DIVISION_NAMES[idx];
      const nfcDivName = DIVISION_NAMES[(idx + seventeenthOffset) % 4];
  
      const afcTeams = divisions.AFC[afcDivName];
      const nfcTeams = divisions.NFC[nfcDivName];
      if (!afcTeams || !nfcTeams || afcTeams.length !== 4 || nfcTeams.length !== 4) continue;
  
      for (let i = 0; i < 4; i++) {
        const homeTeam = hostConference === "AFC" ? afcTeams[i] : nfcTeams[i];
        const awayTeam = hostConference === "AFC" ? nfcTeams[i] : afcTeams[i];
  
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
  
    // Sanity: should now be 272 games total; each team will later get 17 games.
    return games;
  }
  

// -----------------------------------------------------------------------------
// Week assignment helper
// -----------------------------------------------------------------------------

/**
 * Pick a week for a game, respecting byes and avoiding double-booking teams.
 * Tries the primary week set first (shuffled), then all weeks. If no
 * non-conflicting week exists (extremely rare), falls back to any non-bye
 * week and logs a warning – this may put one team in a doubleheader.
 *
 * @param {LeagueGame} game
 * @param {number[]} primaryWeeks
 * @param {Object.<string, number>} byeWeeks
 * @param {Object.<string, Set<number>>} canPlay
 * @returns {number} chosen week (1–18)
 */
function pickWeekForGame(game, primaryWeeks, byeWeeks, canPlay) {
  const home = game.homeTeam;
  const away = game.awayTeam;

  // 1) Try primary weeks (shuffled)
  const primary = primaryWeeks.slice();
  shuffleInPlace(primary);

  for (const w of primary) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    if (canPlay[home].has(w) || canPlay[away].has(w)) continue;
    return w;
  }

  // 2) Try any week 1–18
  const allWeeks = [];
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    allWeeks.push(w);
  }
  shuffleInPlace(allWeeks);

  for (const w of allWeeks) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    if (canPlay[home].has(w) || canPlay[away].has(w)) continue;
    return w;
  }

  // 3) Emergency fallback: allow double-booking but never on bye.
  const emergency = [];
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    if (w === byeWeeks[home] || w === byeWeeks[away]) continue;
    emergency.push(w);
  }
  console.warn("[league_schedule] emergency double-booking for game", game);
  return emergency.length ? emergency[0] : 1;
}

// -----------------------------------------------------------------------------
// PERFECT NFL-STYLE LEAGUE SCHEDULE BUILDER
// -----------------------------------------------------------------------------

import { generateNFLPerfectSchedule } from "./league_schedule_generator.js";

/**
 * Wrapper around the new generator that builds full league-wide byTeam / byWeek
 * and stays compatible with all existing Franchise GM pages.
 */
export function generatePerfectLeagueSchedule(seasonYear) {
  const scheduleGrid = generateNFLPerfectSchedule();
  const byTeam = {};
  const byWeek = {};

  // Build structures expected by the rest of the app
  for (const [teamCode, games] of Object.entries(scheduleGrid)) {
    byTeam[teamCode] = [];
    for (const g of games) {
      const gameObj = {
        index: g.week - 1,
        seasonWeek: g.week,
        teamCode,
        opponentCode: g.opponent,
        isHome: g.isHome,
        type: g.type,
        kickoffIso: null,
        status: "scheduled",
        teamScore: null,
        opponentScore: null
      };
      byTeam[teamCode].push(gameObj);

      if (g.type !== "bye") {
        if (!byWeek[g.week]) byWeek[g.week] = [];
        const homeTeam = g.isHome ? teamCode : g.opponent;
        const awayTeam = g.isHome ? g.opponent : teamCode;
        if (!byWeek[g.week].some(m => (m.homeTeam === homeTeam && m.awayTeam === awayTeam))) {
          byWeek[g.week].push({
            week: g.week,
            homeTeam,
            awayTeam,
            type: g.type,
            kickoffIso: null,
            status: "scheduled",
            homeScore: null,
            awayScore: null
          });
        }
      }
    }

    // Sort team schedule by week
    byTeam[teamCode].sort((a, b) => a.seasonWeek - b.seasonWeek);
  }

  return {
    seasonYear,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    byTeam,
    byWeek
  };
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