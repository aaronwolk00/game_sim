// league_schedule.js
// -----------------------------------------------------------------------------
// Shared schedule engine (no DOM, no localStorage).
// Used by: schedule.js, franchise_gameday.js, franchise.js (season rollover).
//
// 32 teams, 18 weeks, 17 games per team, single bye between weeks 5–14.
// Matchup formula + week layout driven by an annealing-based NFLScheduler,
// ported from your standalone HTML scheduling tool.
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
 * @property {string} [slotId]         // "THU", "SUN_1", "SUN_425", "SUN_820", "MON_700", etc.
 */

/**
 * @typedef {Object} LeagueSchedule
 * @property {number} seasonYear
 * @property {number} schemaVersion
 * @property {Object.<string, TeamGame[]>} byTeam
 * @property {Object.<number, LeagueGame[]>} byWeek
 */

// -----------------------------------------------------------------------------
// Constants & config
// -----------------------------------------------------------------------------

export const REGULAR_SEASON_WEEKS = 18;
export const GAMES_PER_TEAM = 17;
export const SCHEDULE_SCHEMA_VERSION = 3; // bump so old stored schedules regenerate
const SCHEDULE_DEBUG = false;

// -----------------------------------------------------------------------------
// Team metadata (unchanged)
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

// Derived team lists / mappings
export const TEAM_CODES = TEAM_META.map((t) => t.teamCode);
const TEAM_CODE_TO_INDEX = Object.fromEntries(
  TEAM_CODES.map((code, idx) => [code, idx])
);
const TEAM_INDEX_TO_CODE = TEAM_CODES.slice();
const TOTAL_TEAMS = TEAM_CODES.length;

// West / Mountain hosts for late window bias (matches your HTML tool)
const LATE_HOSTS = new Set(
  ["SEA", "SF", "LAR", "LAC", "LV", "DEN", "ARI"].map((c) => TEAM_CODE_TO_INDEX[c])
);

// Thanksgiving anchors
const COWBOYS_IDX = TEAM_CODE_TO_INDEX["DAL"];
const LIONS_IDX   = TEAM_CODE_TO_INDEX["DET"];

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
  return TEAM_CODES.slice();
}

// -----------------------------------------------------------------------------
// Division index structure (to mirror the HTML DIVISIONS order)
// -----------------------------------------------------------------------------

// Order is important: 0..7 used for pairing logic.
const DIVISION_KEYS = [
  "AFC East",
  "AFC North",
  "AFC South",
  "AFC West",
  "NFC East",
  "NFC North",
  "NFC South",
  "NFC West"
];

// For each division key, get the list of team indices (0–31)
const DIVISION_INDICES = DIVISION_KEYS.map((key) => {
  const [conf, div] = key.split(" ");
  return TEAM_META
    .filter((t) => t.conference === conf && t.division === div)
    .map((t) => TEAM_CODE_TO_INDEX[t.teamCode]);
});

// -----------------------------------------------------------------------------
// Time helpers – convert slot labels -> ISO kickoff times
// -----------------------------------------------------------------------------

// Second Thursday in September of seasonYear, local time
function getSeasonStartDateLocal(seasonYear) {
  const d = new Date(seasonYear, 8, 1, 0, 0, 0, 0); // month 8 = September
  const THURSDAY = 4; // 0 = Sun, 1 = Mon, ... 4 = Thu
  const firstDow = d.getDay();
  const offsetToFirstThu = (THURSDAY - firstDow + 7) % 7;
  const firstThuDate = 1 + offsetToFirstThu;
  const secondThuDate = firstThuDate + 7;
  d.setDate(secondThuDate);
  return d;
}

function mapLabelToSlotId(label) {
  switch (label) {
    case "TNF":
    case "THU 8:20":
    case "THU 12:30":
    case "THU 4:30":
      return "THU";
    case "SNF":
      return "SUN_820";
    case "MNF":
      return "MON_700";
    case "4:25 PM":
      return "SUN_425";
    case "1:00 PM":
    default:
      return "SUN_1";
  }
}

/**
 * Compute an Eastern-time ISO string for a given week and label.
 *
 * Week is 1–18. Label is one of:
 * "TNF", "SNF", "MNF", "1:00 PM", "4:25 PM",
 * "THU 12:30", "THU 4:30", "THU 8:20".
 */
function computeKickoffIso(seasonYear, weekNum, label) {
  const base = getSeasonStartDateLocal(seasonYear);
  const kickoff = new Date(base);
  // Thursday of this week
  kickoff.setDate(base.getDate() + (weekNum - 1) * 7);

  let dayOffset = 0;
  let hour = 13;
  let minute = 0;

  switch (label) {
    case "TNF":
    case "THU 8:20":
      dayOffset = 0; hour = 20; minute = 20; break; // Thu 8:20 PM
    case "THU 12:30":
      dayOffset = 0; hour = 12; minute = 30; break; // Thanksgiving 12:30
    case "THU 4:30":
      dayOffset = 0; hour = 16; minute = 30; break; // Thanksgiving 4:30
    case "SNF":
      dayOffset = 3; hour = 20; minute = 20; break; // Sunday night
    case "MNF":
      dayOffset = 4; hour = 20; minute = 15; break; // Monday night
    case "4:25 PM":
      dayOffset = 3; hour = 16; minute = 25; break; // Sunday late
    case "1:00 PM":
    default:
      dayOffset = 3; hour = 13; minute = 0; break;  // Sunday early
  }

  kickoff.setDate(kickoff.getDate() + dayOffset);
  kickoff.setHours(hour, minute, 0, 0);

  const eastern = new Date(
    kickoff.toLocaleString("en-US", { timeZone: "America/New_York" })
  );

  return eastern.toISOString();
}

// -----------------------------------------------------------------------------
// NFLScheduler – port of your HTML annealing scheduler (adapted for codes)
// -----------------------------------------------------------------------------

class NFLScheduler {
  constructor() {
    this.games = [];                      // { h, a, id, week, locked, type, time? }
    this.weeks = REGULAR_SEASON_WEEKS;    // 18
    this.byeWeeks = new Int8Array(TOTAL_TEAMS).fill(-1);      // teamIdx -> weekIdx (0–17)
    this.weekCapacities = new Int8Array(REGULAR_SEASON_WEEKS).fill(0); // weekIdx -> game slots
    this.matrix = [];                     // [week][teamIdx] games for conflict checking
  }

  // Build the 272-game manifest with types (division / conference / nonconference / extra)
  generateManifest() {
    this.games = [];
    const divs = DIVISION_INDICES;

    const add = (hIdx, aIdx, type) => {
      this.games.push({
        h: hIdx,
        a: aIdx,
        id: this.games.length,
        week: -1,
        locked: false,
        type,     // "division" | "conference" | "nonconference" | "extra"
        time: null
      });
    };

    // 1) Division home/away (6 per team, 96 games)
    divs.forEach((d) => {
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          add(d[i], d[j], "division");
          add(d[j], d[i], "division");
        }
      }
    });

    // helper for 4x4 division blocks
    const pair = (A, B, type) => {
      const dA = divs[A];
      const dB = divs[B];
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const parityEven = ((i + j) & 1) === 0;
          if (parityEven) {
            add(dA[i], dB[j], type);
          } else {
            add(dB[j], dA[i], type);
          }
        }
      }
    };

    // 2a) Cross-conference 4-game rotation (AFC div i vs NFC div i) – 64 games
    [0, 1, 2, 3].forEach((i) => pair(i, i + 4, "nonconference"));

    // 2b) Same-conference division rotation (East<->North, South<->West in each conf) – 64 games
    [[0, 1], [2, 3], [4, 5], [6, 7]].forEach(([a, b]) => pair(a, b, "conference"));

    // Rank-based helper (4 games per pair)
    const rank = (A, B, type) => {
      const dA = divs[A];
      const dB = divs[B];
      for (let i = 0; i < 4; i++) {
        const parityEven = ((A + B) & 1) === 0;
        if (parityEven) {
          add(dA[i], dB[i], type);
        } else {
          add(dB[i], dA[i], type);
        }
      }
    };

    // 3a) Same-conference extra (2 per team, 32 games total, type "extra")
    [[0, 2], [1, 3], [4, 6], [5, 7], [0, 3], [1, 2], [4, 7], [5, 6]]
      .forEach(([a, b]) => rank(a, b, "extra"));

    // 3b) 17th cross-conference rank-based game (1 per team, 16 games, type "nonconference")
    [[0, 5], [1, 4], [2, 7], [3, 6]]
      .forEach(([a, b]) => rank(a, b, "nonconference"));

    if (this.games.length !== 272) {
      console.warn(
        `[league_schedule] NFLScheduler.generateManifest produced ${this.games.length} games (expected 272)`
      );
    }
  }

  // Assign byes: weeks 5–14 (0-based 4–13), distribution 4,4,4,4,4,4,2,2,2,2
  assignByes() {
    const valid = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // week indices (0-based)
    const slots = [];

    // first 6 weeks: 4 byes each
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < 4; k++) slots.push(valid[i]);
    }
    // last 4 weeks: 2 byes each
    for (let i = 6; i < 10; i++) {
      for (let k = 0; k < 2; k++) slots.push(valid[i]);
    }

    // Shuffle slots & teams
    slots.sort(() => Math.random() - 0.5);
    const teams = Array.from({ length: TOTAL_TEAMS }, (_, i) => i)
      .sort(() => Math.random() - 0.5);

    teams.forEach((t, i) => {
      let w = slots[i];
      // Keep DAL/DET from both landing on week 11 if possible
      if (w === 11 && (t === COWBOYS_IDX || t === LIONS_IDX)) {
        const swapIdx = slots.findIndex((s) => s !== 11);
        if (swapIdx !== -1) {
          w = slots[swapIdx];
          slots[swapIdx] = 11;
        }
      }
      this.byeWeeks[t] = w;
    });

    // Compute game capacity per week: 16 games minus half the bye teams
    for (let w = 0; w < this.weeks; w++) {
      let byeCount = 0;
      for (let t = 0; t < TOTAL_TEAMS; t++) {
        if (this.byeWeeks[t] === w) byeCount++;
      }
      this.weekCapacities[w] = 16 - (byeCount / 2);
    }
  }

  // Initial random week assignment + Thanksgiving locking
  initialize() {
    this.matrix = Array.from(
      { length: this.weeks },
      () => new Int8Array(TOTAL_TEAMS).fill(0)
    );

    const lockHomeGame = (teamIdx, weekIdx) => {
      const g = this.games.find((game) => game.h === teamIdx && !game.locked);
      if (!g) return;
      g.week = weekIdx;
      g.locked = true;
      this.matrix[weekIdx][g.h]++;
      this.matrix[weekIdx][g.a]++;
      this.weekCapacities[weekIdx]--;
    };

    // Lock Lions and Cowboys home games into Thanksgiving week (index 11 => Week 12)
    lockHomeGame(COWBOYS_IDX, 11);
    lockHomeGame(LIONS_IDX, 11);

    const remaining = this.games
      .filter((g) => !g.locked)
      .sort(() => Math.random() - 0.5);

    let ptr = 0;
    for (let w = 0; w < this.weeks; w++) {
      let cap = this.weekCapacities[w];
      while (cap > 0 && ptr < remaining.length) {
        const g = remaining[ptr++];
        g.week = w;
        this.matrix[w][g.h]++;
        this.matrix[w][g.a]++;
        cap--;
      }
    }
  }

  toggle(g, w, v) {
    this.matrix[w][g.h] += v;
    this.matrix[w][g.a] += v;
  }

  score(g, w) {
    return (this.matrix[w][g.h] > 1 ? 10 : 0) +
           (this.matrix[w][g.a] > 1 ? 10 : 0);
  }

  conflicts() {
    let c = 0;
    for (let w = 0; w < this.weeks; w++) {
      for (let t = 0; t < TOTAL_TEAMS; t++) {
        if (this.matrix[w][t] > 1) c++;
      }
    }
    return c;
  }

  // Simulated annealing – synchronous version of your solveAsync
  solve(maxSteps = 300000) {
    let temp = 2.0;

    for (let i = 0; i < maxSteps; i++) {
      const g1 = this.games[Math.floor(Math.random() * this.games.length)];
      if (!g1 || g1.locked) continue;

      const g2 = this.games[Math.floor(Math.random() * this.games.length)];
      if (!g2 || g2.locked || g2.week === g1.week) continue;

      // Don't move games into a team's bye week
      if (this.byeWeeks[g1.h] === g2.week || this.byeWeeks[g1.a] === g2.week) continue;
      if (this.byeWeeks[g2.h] === g1.week || this.byeWeeks[g2.a] === g1.week) continue;

      const w1 = g1.week;
      const w2 = g2.week;

      const pre = this.score(g1, w1) + this.score(g2, w2);

      this.toggle(g1, w1, -1);
      this.toggle(g2, w2, -1);
      this.toggle(g1, w2, 1);
      this.toggle(g2, w1, 1);

      const post = this.score(g1, w2) + this.score(g2, w1);

      if (post < pre || Math.random() < Math.exp(-(post - pre) / temp)) {
        g1.week = w2;
        g2.week = w1;
      } else {
        // revert
        this.toggle(g1, w2, -1);
        this.toggle(g2, w1, -1);
        this.toggle(g1, w1, 1);
        this.toggle(g2, w2, 1);
      }

      temp *= 0.99998;

      if (i % 2500 === 0) {
        const c = this.conflicts();
        if (c === 0) break;
      }
    }

    const finalConf = this.conflicts();
    if (finalConf > 0) {
      console.warn(
        `[league_schedule] NFLScheduler.solve ended with ${finalConf} conflicts`
      );
    }
  }

  // Assign TNF / SNF / MNF / Thanksgiving + early/late Sunday windows
  assignTimes() {
    const slots = {
      TNF: { L: "TNF",       C: "time-tnf"  },
      MNF: { L: "MNF",       C: "time-mnf"  },
      SNF: { L: "SNF",       C: "time-snf"  },
      LATE:{ L: "4:25 PM",   C: "time-late" },
      EARLY:{L: "1:00 PM",   C: "time-early"},
      THX1:{L: "THU 12:30",  C: "time-thx"  },
      THX2:{L: "THU 4:30",   C: "time-thx"  },
      THX3:{L: "THU 8:20",   C: "time-thx"  }
    };

    for (let w = 0; w < this.weeks; w++) {
      const games = this.games.filter((g) => g.week === w);
      const taken = new Set();

      // Thanksgiving week triple-header (week index 11 => Week 12)
      if (w === 11 && games.length) {
        const lionsGame = games.find((g) => g.h === LIONS_IDX);
        if (lionsGame) {
          lionsGame.time = slots.THX1;
          taken.add(lionsGame.id);
        }

        const cowboysGame = games.find((g) => g.h === COWBOYS_IDX && !taken.has(g.id));
        if (cowboysGame) {
          cowboysGame.time = slots.THX2;
          taken.add(cowboysGame.id);
        }

        const remainingTG = games.filter((g) => !taken.has(g.id));
        if (remainingTG.length) {
          const g = remainingTG[0];
          g.time = slots.THX3;
          taken.add(g.id);
        }
      } else {
        // Normal week: TNF, SNF, MNF
        const remaining = games.filter((g) => !taken.has(g.id));
        const primeOrder = ["TNF", "SNF", "MNF"];

        const pool = remaining.slice();
        for (const key of primeOrder) {
          if (!pool.length) break;
          const idx = Math.floor(Math.random() * pool.length);
          const g = pool[idx];
          g.time = slots[key];
          taken.add(g.id);
          pool.splice(idx, 1);
        }
      }

      // Remaining Sunday games – early or late window
      for (const g of games) {
        if (taken.has(g.id)) continue;
        const isLateHost = LATE_HOSTS.has(g.h) || Math.random() < 0.2;
        g.time = isLateHost ? slots.LATE : slots.EARLY;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Perfect NFL-style schedule builder using NFLScheduler
// -----------------------------------------------------------------------------

export function generatePerfectLeagueSchedule(seasonYear) {
  const scheduler = new NFLScheduler();
  scheduler.generateManifest();
  scheduler.assignByes();
  scheduler.initialize();
  scheduler.solve();
  scheduler.assignTimes();

  /** @type {Record<number, LeagueGame[]>} */
  const byWeek = {};
  for (let w = 1; w <= REGULAR_SEASON_WEEKS; w++) {
    byWeek[w] = [];
  }

  // Convert scheduler games -> LeagueGame objects
  for (const g of scheduler.games) {
    const weekIdx = g.week;     // 0-based
    const weekNum = weekIdx + 1;
    const homeCode = TEAM_INDEX_TO_CODE[g.h];
    const awayCode = TEAM_INDEX_TO_CODE[g.a];
    const label = g.time && g.time.L ? g.time.L : "1:00 PM";

    const slotId = mapLabelToSlotId(label);
    const kickoffIso = computeKickoffIso(seasonYear, weekNum, label);

    const leagueGame = {
      week: weekNum,
      homeTeam: homeCode,
      awayTeam: awayCode,
      type: g.type,
      kickoffIso,
      status: "scheduled",
      homeScore: null,
      awayScore: null,
      slotId
    };

    byWeek[weekNum].push(leagueGame);
  }

  /** @type {Record<string, TeamGame[]>} */
  const byTeam = {};
  for (const code of TEAM_CODES) {
    byTeam[code] = [];
  }

  // Build per-team schedules from byWeek
  for (const [weekStr, games] of Object.entries(byWeek)) {
    const w = Number(weekStr);
    for (const g of games) {
      const { homeTeam, awayTeam, type, kickoffIso, status, homeScore, awayScore } = g;

      byTeam[homeTeam].push({
        index: 0,
        seasonWeek: w,
        teamCode: homeTeam,
        opponentCode: awayTeam,
        isHome: true,
        type,
        kickoffIso,
        status,
        teamScore: homeScore,
        opponentScore: awayScore
      });

      byTeam[awayTeam].push({
        index: 0,
        seasonWeek: w,
        teamCode: awayTeam,
        opponentCode: homeTeam,
        isHome: false,
        type,
        kickoffIso,
        status,
        teamScore: awayScore,
        opponentScore: homeScore
      });
    }
  }

  // Add bye placeholders (team-level only)
  for (let t = 0; t < TOTAL_TEAMS; t++) {
    const code = TEAM_INDEX_TO_CODE[t];
    const byeWeekIdx = scheduler.byeWeeks[t]; // 0-based
    if (byeWeekIdx >= 0) {
      const weekNum = byeWeekIdx + 1;
      byTeam[code].push({
        index: 0,
        seasonWeek: weekNum,
        teamCode: code,
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

  // Sort per-team schedules and assign indices
  for (const code of TEAM_CODES) {
    const arr = byTeam[code];
    arr.sort((a, b) => a.seasonWeek - b.seasonWeek);
    arr.forEach((g, idx) => {
      g.index = idx;
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
 * Get bye week (1–18) for a team from a schedule.
 *
 * @param {LeagueSchedule} schedule
 * @param {string} teamCode
 * @returns {number|null}
 */
export function getByeWeekForTeam(schedule, teamCode) {
  const games = schedule.byTeam[teamCode] || [];
  const byeGame = games.find((g) => g.type === "bye");
  return byeGame ? byeGame.seasonWeek : null;
}

/**
 * Count prime-time appearances (TNF / SNF / MNF) for a team.
 *
 * @param {LeagueSchedule} schedule
 * @param {string} teamCode
 * @returns {number}
 */
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

// -----------------------------------------------------------------------------
// Debug helpers (only used when SCHEDULE_DEBUG === true)
// -----------------------------------------------------------------------------

export function debugPrintScheduleSummary(schedule) {
  if (!schedule || !schedule.byWeek || !schedule.byTeam) {
    console.warn("[league_schedule] debugPrintScheduleSummary: invalid schedule object");
    return;
  }

  const teams = getAllTeamCodes();

  console.groupCollapsed(
    `[league_schedule] Schedule summary – season ${schedule.seasonYear}`
  );

  // Per-week summary
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

  // Per-team summary
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

// Backwards compatibility: anything importing generateLeagueSchedule
// gets the new annealing-based builder.
export { generatePerfectLeagueSchedule as generateLeagueSchedule };
