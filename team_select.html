// team_select.js
//
// Franchise GM – Team selection & GM contract screen.
// This page is the first step after the landing page:
// - Choose an open GM job.
// - Propose a contract (years + salary).
// - If the owner accepts, build a FranchiseSave object and go to franchise.html.
//
// Future systems (job market, interviews, multi-career meta, age/retirement)
// will hook into the structures defined here.

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} teamName      // compat / display helper
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {number} weekIndex
 * @property {string} phase
 * @property {string} record
 * @property {string} lastPlayedISO
 *
 * @property {Object} accolades
 * @property {number} accolades.seasons
 * @property {number} accolades.playoffAppearances
 * @property {number} accolades.divisionTitles
 * @property {number} accolades.championships
 *
 * @property {Object} gmJob
 * @property {number} gmJob.contractYears
 * @property {number} gmJob.currentYear
 * @property {number} gmJob.salaryPerYearMillions
 * @property {number} gmJob.contractTotalMillions
 * @property {string} gmJob.status
 * @property {number} gmJob.ageYears
 * @property {number} gmJob.birthYear
 *
 * @property {Object} leagueSummary
 * @property {number} leagueSummary.teams
 * @property {number} leagueSummary.seasonsSimmed
 *
 * @property {Object} realismOptions
 * @property {boolean} realismOptions.injuriesOn
 * @property {string} realismOptions.capMode
 * @property {string} realismOptions.difficulty
 * @property {boolean} realismOptions.ironman
 *
 * @property {Object} ownerExpectation
 * @property {string} ownerExpectation.patience
 * @property {number} ownerExpectation.targetYear
 * @property {number} ownerExpectation.baselineWins
 *
 * @property {number} gmCredibility // hidden meta scale, 0–100
 */

// ---------------------------
// Constants / team data
// ---------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";

/**
 * 32-team league data.
 * Stubbed context (last season record, 3-year record, etc.) will eventually be
 * replaced by real sim-generated history.
 *
 * ownerPatience: "patient" | "average" | "impatient"
 * marketProfile: text used both for flavor and to infer pressure level.
 */
const TEAMS = [
  // AFC East
  {
    teamCode: "BUF",
    city: "Buffalo",
    name: "Bills",
    conference: "AFC",
    division: "East",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "27-24",
    lastPlayoffAppearance: 2023,
    allPros: 2,
    ownerProfile: "Average patience; expects regular playoff contention.",
    ownerPatience: "average",
    marketProfile: "Small-to-mid market; strong local pressure.",
    rosterSnapshot: "Roster: playoff-caliber core, aging pieces on defense."
  },
  {
    teamCode: "MIA",
    city: "Miami",
    name: "Dolphins",
    conference: "AFC",
    division: "East",
    lastSeasonRecord: "10-7",
    lastThreeYearsRecord: "28-23",
    lastPlayoffAppearance: 2023,
    allPros: 1,
    ownerProfile: "Impatient; expects deep playoff runs soon.",
    ownerPatience: "impatient",
    marketProfile: "Big market feel; media expects fireworks.",
    rosterSnapshot: "Roster: explosive offense, questions in the trenches."
  },
  {
    teamCode: "NE",
    city: "New England",
    name: "Patriots",
    conference: "AFC",
    division: "East",
    lastSeasonRecord: "5-12",
    lastThreeYearsRecord: "18-33",
    lastPlayoffAppearance: 2021,
    allPros: 0,
    ownerProfile: "Average patience; expects modernized roster build.",
    ownerPatience: "average",
    marketProfile: "Legacy brand; regional pressure remains high.",
    rosterSnapshot: "Roster: transition phase, no clear long-term QB."
  },
  {
    teamCode: "NYJ",
    city: "New York",
    name: "Jets",
    conference: "AFC",
    division: "East",
    lastSeasonRecord: "6-11",
    lastThreeYearsRecord: "19-30",
    lastPlayoffAppearance: 2010,
    allPros: 1,
    ownerProfile: "Impatient; wants visible progress quickly.",
    ownerPatience: "impatient",
    marketProfile: "Big market; intense media and fan scrutiny.",
    rosterSnapshot: "Roster: strong defense, volatile offense and health questions."
  },

  // AFC North
  {
    teamCode: "BAL",
    city: "Baltimore",
    name: "Ravens",
    conference: "AFC",
    division: "North",
    lastSeasonRecord: "12-5",
    lastThreeYearsRecord: "33-18",
    lastPlayoffAppearance: 2023,
    allPros: 3,
    ownerProfile: "Patient but demanding; expects consistent contention.",
    ownerPatience: "patient",
    marketProfile: "Smaller market; football-centric expectations.",
    rosterSnapshot: "Roster: franchise QB in place, physical identity intact."
  },
  {
    teamCode: "CIN",
    city: "Cincinnati",
    name: "Bengals",
    conference: "AFC",
    division: "North",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "32-19",
    lastPlayoffAppearance: 2023,
    allPros: 2,
    ownerProfile: "Average patience; expects playoff contention while QB is in his prime.",
    ownerPatience: "average",
    marketProfile: "Smaller market with heightened expectations.",
    rosterSnapshot: "Roster: high-end passing game, cap decisions looming."
  },
  {
    teamCode: "CLE",
    city: "Cleveland",
    name: "Browns",
    conference: "AFC",
    division: "North",
    lastSeasonRecord: "8-9",
    lastThreeYearsRecord: "24-27",
    lastPlayoffAppearance: 2023,
    allPros: 1,
    ownerProfile: "Impatient; short leash if results stall.",
    ownerPatience: "impatient",
    marketProfile: "Long-suffering fanbase; emotional swings tied to performance.",
    rosterSnapshot: "Roster: strong defense, offense in flux."
  },
  {
    teamCode: "PIT",
    city: "Pittsburgh",
    name: "Steelers",
    conference: "AFC",
    division: "North",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "26-25",
    lastPlayoffAppearance: 2023,
    allPros: 1,
    ownerProfile: "Patient; values stability and discipline.",
    ownerPatience: "patient",
    marketProfile: "Traditional market; expects tough, competitive football.",
    rosterSnapshot: "Roster: physical defense, offense searching for identity."
  },

  // AFC South
  {
    teamCode: "HOU",
    city: "Houston",
    name: "Texans",
    conference: "AFC",
    division: "South",
    lastSeasonRecord: "10-7",
    lastThreeYearsRecord: "20-31",
    lastPlayoffAppearance: 2023,
    allPros: 1,
    ownerProfile: "Patient; embracing long-term build around young core.",
    ownerPatience: "patient",
    marketProfile: "Large market; expectations rising quickly.",
    rosterSnapshot: "Roster: ascending QB and weapons, defense still maturing."
  },
  {
    teamCode: "IND",
    city: "Indianapolis",
    name: "Colts",
    conference: "AFC",
    division: "South",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "21-30",
    lastPlayoffAppearance: 2020,
    allPros: 1,
    ownerProfile: "Average patience; wants meaningful games in December.",
    ownerPatience: "average",
    marketProfile: "Mid-market; engaged fanbase, moderate media pressure.",
    rosterSnapshot: "Roster: upside at QB, trenches need reinforcement."
  },
  {
    teamCode: "JAX",
    city: "Jacksonville",
    name: "Jaguars",
    conference: "AFC",
    division: "South",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "23-28",
    lastPlayoffAppearance: 2022,
    allPros: 0,
    ownerProfile: "Patient; focused on building a sustainable winner.",
    ownerPatience: "patient",
    marketProfile: "Small market; patience exists but interest swings with wins.",
    rosterSnapshot: "Roster: young QB, skill talent present, defense uneven."
  },
  {
    teamCode: "TEN",
    city: "Tennessee",
    name: "Titans",
    conference: "AFC",
    division: "South",
    lastSeasonRecord: "6-11",
    lastThreeYearsRecord: "20-31",
    lastPlayoffAppearance: 2021,
    allPros: 0,
    ownerProfile: "Average patience; open to reset with the right plan.",
    ownerPatience: "average",
    marketProfile: "Smaller market; expectations tied to toughness and identity.",
    rosterSnapshot: "Roster: transitioning core, decisions coming at key positions."
  },

  // AFC West
  {
    teamCode: "DEN",
    city: "Denver",
    name: "Broncos",
    conference: "AFC",
    division: "West",
    lastSeasonRecord: "8-9",
    lastThreeYearsRecord: "20-31",
    lastPlayoffAppearance: 2015,
    allPros: 0,
    ownerProfile: "Impatient; wants tangible progress quickly.",
    ownerPatience: "impatient",
    marketProfile: "Passionate fanbase, national spotlight.",
    rosterSnapshot: "Roster: cap challenges, searching for long-term QB answer."
  },
  {
    teamCode: "KC",
    city: "Kansas City",
    name: "Chiefs",
    conference: "AFC",
    division: "West",
    lastSeasonRecord: "11-6",
    lastThreeYearsRecord: "37-14",
    lastPlayoffAppearance: 2023,
    allPros: 3,
    ownerProfile: "Patient; expects championship windows to stay open.",
    ownerPatience: "patient",
    marketProfile: "High expectations with global spotlight.",
    rosterSnapshot: "Roster: elite QB, retooling skill positions as cap evolves."
  },
  {
    teamCode: "LV",
    city: "Las Vegas",
    name: "Raiders",
    conference: "AFC",
    division: "West",
    lastSeasonRecord: "7-10",
    lastThreeYearsRecord: "21-30",
    lastPlayoffAppearance: 2021,
    allPros: 1,
    ownerProfile: "Impatient; wants relevance and identity quickly.",
    ownerPatience: "impatient",
    marketProfile: "Unique market; fanbase expects bold moves.",
    rosterSnapshot: "Roster: elite edge rusher, offense in flux."
  },
  {
    teamCode: "LAC",
    city: "Los Angeles",
    name: "Chargers",
    conference: "AFC",
    division: "West",
    lastSeasonRecord: "8-9",
    lastThreeYearsRecord: "25-26",
    lastPlayoffAppearance: 2022,
    allPros: 1,
    ownerProfile: "Average patience; expects contention with franchise QB.",
    ownerPatience: "average",
    marketProfile: "Crowded market; scrutiny tied to results.",
    rosterSnapshot: "Roster: high-end QB, balancing cap around core pieces."
  },

  // NFC East
  {
    teamCode: "DAL",
    city: "Dallas",
    name: "Cowboys",
    conference: "NFC",
    division: "East",
    lastSeasonRecord: "12-5",
    lastThreeYearsRecord: "34-17",
    lastPlayoffAppearance: 2023,
    allPros: 3,
    ownerProfile: "Impatient; expects contention every year.",
    ownerPatience: "impatient",
    marketProfile: "Iconic big market; constant national attention.",
    rosterSnapshot: "Roster: high-end talent, expectations sky-high."
  },
  {
    teamCode: "NYG",
    city: "New York",
    name: "Giants",
    conference: "NFC",
    division: "East",
    lastSeasonRecord: "6-11",
    lastThreeYearsRecord: "19-30",
    lastPlayoffAppearance: 2022,
    allPros: 0,
    ownerProfile: "Average patience; wants a sustainable plan.",
    ownerPatience: "average",
    marketProfile: "Big market; media focus and fan scrutiny.",
    rosterSnapshot: "Roster: questions at QB and OL, some young defensive pieces."
  },
  {
    teamCode: "PHI",
    city: "Philadelphia",
    name: "Eagles",
    conference: "NFC",
    division: "East",
    lastSeasonRecord: "11-6",
    lastThreeYearsRecord: "31-20",
    lastPlayoffAppearance: 2023,
    allPros: 2,
    ownerProfile: "Impatient; expects deep playoff runs.",
    ownerPatience: "impatient",
    marketProfile: "Intense market; aggressive expectations.",
    rosterSnapshot: "Roster: talented core, age creeping into key positions."
  },
  {
    teamCode: "WAS",
    city: "Washington",
    name: "Commanders",
    conference: "NFC",
    division: "East",
    lastSeasonRecord: "4-13",
    lastThreeYearsRecord: "16-35",
    lastPlayoffAppearance: 2020,
    allPros: 0,
    ownerProfile: "Patient; new ownership wants stability and a plan.",
    ownerPatience: "patient",
    marketProfile: "Rebuilding brand; expectations rising from a low baseline.",
    rosterSnapshot: "Roster: in reset mode, looking for long-term QB solution."
  },

  // NFC North
  {
    teamCode: "CHI",
    city: "Chicago",
    name: "Bears",
    conference: "NFC",
    division: "North",
    lastSeasonRecord: "7-10",
    lastThreeYearsRecord: "17-34",
    lastPlayoffAppearance: 2020,
    allPros: 0,
    ownerProfile: "Average patience; expects a modern offense and a clear QB plan.",
    ownerPatience: "average",
    marketProfile: "Historic franchise; big-market pressure.",
    rosterSnapshot: "Roster: young offensive core, defense still forming."
  },
  {
    teamCode: "DET",
    city: "Detroit",
    name: "Lions",
    conference: "NFC",
    division: "North",
    lastSeasonRecord: "12-5",
    lastThreeYearsRecord: "27-24",
    lastPlayoffAppearance: 2023,
    allPros: 2,
    ownerProfile: "Patient; appreciates steady culture build.",
    ownerPatience: "patient",
    marketProfile: "Revitalized fanbase; expectations now meaningful.",
    rosterSnapshot: "Roster: strong offense, defense catching up."
  },
  {
    teamCode: "GB",
    city: "Green Bay",
    name: "Packers",
    conference: "NFC",
    division: "North",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "28-23",
    lastPlayoffAppearance: 2023,
    allPros: 1,
    ownerProfile: "Average patience; expects playoff contention.",
    ownerPatience: "average",
    marketProfile: "Unique community ownership; high expectations.",
    rosterSnapshot: "Roster: transitioning at QB, focused on sustainable roster building."
  },
  {
    teamCode: "MIN",
    city: "Minnesota",
    name: "Vikings",
    conference: "NFC",
    division: "North",
    lastSeasonRecord: "7-10",
    lastThreeYearsRecord: "25-26",
    lastPlayoffAppearance: 2022,
    allPros: 1,
    ownerProfile: "Average patience; wants competitive product annually.",
    ownerPatience: "average",
    marketProfile: "Engaged fanbase; low tolerance for long rebuilds.",
    rosterSnapshot: "Roster: high-end WR talent, defensive retool underway."
  },

  // NFC South
  {
    teamCode: "ATL",
    city: "Atlanta",
    name: "Falcons",
    conference: "NFC",
    division: "South",
    lastSeasonRecord: "7-10",
    lastThreeYearsRecord: "21-30",
    lastPlayoffAppearance: 2017,
    allPros: 0,
    ownerProfile: "Patient; wants clear offensive identity and stability.",
    ownerPatience: "patient",
    marketProfile: "Mid-sized market; appetite for a true reset.",
    rosterSnapshot: "Roster: young skill talent, uncertainty at QB."
  },
  {
    teamCode: "CAR",
    city: "Carolina",
    name: "Panthers",
    conference: "NFC",
    division: "South",
    lastSeasonRecord: "2-15",
    lastThreeYearsRecord: "14-37",
    lastPlayoffAppearance: 2017,
    allPros: 0,
    ownerProfile: "Impatient; frustrated with recent results.",
    ownerPatience: "impatient",
    marketProfile: "Regional pressure; ownership expects visible progress.",
    rosterSnapshot: "Roster: young QB under pressure, roster needs talent infusion."
  },
  {
    teamCode: "NO",
    city: "New Orleans",
    name: "Saints",
    conference: "NFC",
    division: "South",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "25-26",
    lastPlayoffAppearance: 2020,
    allPros: 1,
    ownerProfile: "Average patience; values competitiveness and stability.",
    ownerPatience: "average",
    marketProfile: "Passionate fanbase; expectations tied to playoff appearances.",
    rosterSnapshot: "Roster: veteran pieces, cap tight, retool approaching."
  },
  {
    teamCode: "TB",
    city: "Tampa Bay",
    name: "Buccaneers",
    conference: "NFC",
    division: "South",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "29-22",
    lastPlayoffAppearance: 2023,
    allPros: 1,
    ownerProfile: "Average patience; expects to compete in the division.",
    ownerPatience: "average",
    marketProfile: "Mid-market; interest tied to recent success.",
    rosterSnapshot: "Roster: veteran remnants of title run, transition ongoing."
  },

  // NFC West
  {
    teamCode: "ARI",
    city: "Arizona",
    name: "Cardinals",
    conference: "NFC",
    division: "West",
    lastSeasonRecord: "4-13",
    lastThreeYearsRecord: "17-34",
    lastPlayoffAppearance: 2021,
    allPros: 0,
    ownerProfile: "Patient; understands rebuild timeline.",
    ownerPatience: "patient",
    marketProfile: "Sunbelt market; expectations moderated by rebuild.",
    rosterSnapshot: "Roster: rebuilding both lines, QB questions linger."
  },
  {
    teamCode: "LAR",
    city: "Los Angeles",
    name: "Rams",
    conference: "NFC",
    division: "West",
    lastSeasonRecord: "10-7",
    lastThreeYearsRecord: "25-26",
    lastPlayoffAppearance: 2023,
    allPros: 2,
    ownerProfile: "Average patience; comfortable with aggressive windows.",
    ownerPatience: "average",
    marketProfile: "Big market; star-driven expectations.",
    rosterSnapshot: "Roster: high-end skill talent, defense reloading post-title window."
  },
  {
    teamCode: "SF",
    city: "San Francisco",
    name: "49ers",
    conference: "NFC",
    division: "West",
    lastSeasonRecord: "12-5",
    lastThreeYearsRecord: "34-17",
    lastPlayoffAppearance: 2023,
    allPros: 3,
    ownerProfile: "Impatient; expects deep playoff runs every year.",
    ownerPatience: "impatient",
    marketProfile: "High-profile franchise; national expectations.",
    rosterSnapshot: "Roster: elite roster structure, cap decisions looming on core pieces."
  },
  {
    teamCode: "SEA",
    city: "Seattle",
    name: "Seahawks",
    conference: "NFC",
    division: "West",
    lastSeasonRecord: "9-8",
    lastThreeYearsRecord: "25-26",
    lastPlayoffAppearance: 2022,
    allPros: 1,
    ownerProfile: "Patient; values culture and competitive seasons.",
    ownerPatience: "patient",
    marketProfile: "Dedicated regional base; expectations steady.",
    rosterSnapshot: "Roster: interesting young talent, QB situation evolving."
  }
];

/**
 * Stubbed open GM jobs for this offseason.
 * TODO: Replace with logic that fires/retains GMs based on sim performance,
 *       expectations, and tenure.
 */
const OPEN_TEAMS = ["CAR", "CHI", "NYJ", "LAC"];

// ---------------------------
// App state
// ---------------------------

/**
 * Derive an initial hidden GM credibility value for a brand-new career.
 * Neutral ~50, we start a bit below with a small random band for variation.
 */
function deriveInitialCredibility() {
  const base = 45;
  const jitter = Math.round((Math.random() * 6) - 3); // -3..+3
  return Math.max(30, Math.min(60, base + jitter));
}

const appState = {
  viewMode: "league", // "league" | "conference" | "division"
  selectedTeamCode: null,
  contractYears: 2,
  salaryPerYearMillions: 1.0,
  // Hidden meta credibility for a brand new GM; neutral ~50.
  gmCredibility: deriveInitialCredibility(),
  seasonYear: new Date().getFullYear(),
  negotiationAttemptsByTeam: {} // { [teamCode]: number }
};

// ---------------------------
// Storage helpers
// ---------------------------

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch (err) {
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

function saveLastFranchise(save) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(SAVE_KEY_LAST_FRANCHISE, JSON.stringify(save));
  } catch (err) {
    console.warn("[Franchise GM] Failed to save franchise:", err);
  }
}

function generateNewFranchiseId() {
  const timePart = Date.now().toString(36);
  const randPart = Math.random().toString(36).slice(2, 8);
  return `franchise-${timePart}-${randPart}`;
}

function navigateToFranchise() {
  window.location.href = "franchise.html";
}

// ---------------------------
// Team lookup / helpers
// ---------------------------

function getTeamByCode(code) {
  return TEAMS.find((t) => t.teamCode === code) || null;
}

function isTeamOpen(teamCode) {
  return OPEN_TEAMS.includes(teamCode);
}

function parseRecord(record) {
  const str = String(record || "").trim();
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(str);
  if (!m) return { wins: 0, losses: 0 };
  const wins = Number(m[1]) || 0;
  const losses = Number(m[2]) || 0;
  return { wins, losses };
}

// ---------------------------
// Evaluate contract offer
// ---------------------------

/**
 * Evaluate a first-time GM contract proposal.
 *
 * Considers:
 * - Team desperation (bad record + playoff drought).
 * - Owner patience & market profile.
 * - GM credibility (starting slightly below neutral, with variation).
 * - Term and salary relative to first-time expectations.
 *
 * Returns { accepted: boolean, reason: string } with a bit of randomness.
 */
function evaluateContractOffer(team, proposal, gmCredibility, seasonYear) {
  const { wins, losses } = parseRecord(team.lastSeasonRecord);
  const totalGames = wins + losses;
  const winPct = totalGames > 0 ? wins / totalGames : 0.5;

  const lastPO = team.lastPlayoffAppearance;
  const droughtYears =
    lastPO == null ? 10 : Math.max(0, (seasonYear - 1) - lastPO);

  // "Desperation": bad record + long drought => more open to risk.
  const desperationScore = (1 - winPct) * 40 + Math.min(droughtYears, 10) * 3; // 0–70ish

  let baseline = 45 + desperationScore * 0.4 + (gmCredibility - 50) * 0.5;

  // Owner patience
  const patience = team.ownerPatience || "average";
  if (patience === "impatient") {
    baseline -= 6;
  } else if (patience === "patient") {
    baseline += 4;
  }

  // Market intensity (big markets are harsher on first-time GMs)
  const marketText = (team.marketProfile || "").toLowerCase();
  if (marketText.includes("big market") || marketText.includes("intense")) {
    baseline -= 4;
  }

  // Contract terms
  const years = proposal.years;
  const salary = proposal.salaryPerYearMillions;
  const salaryNormalized = (salary - 0.25) / (2.0 - 0.25); // 0..1

  const salaryPenalty = salaryNormalized * 22; // up to about -22
  baseline -= salaryPenalty;

  let yearPenalty = (years - 1) * 5;
  if (winPct > 0.55) {
    yearPenalty += (years - 1) * 3;
  } else if (winPct < 0.35) {
    yearPenalty -= (years - 1) * 1; // desperate teams tolerate length a bit more
  }
  baseline -= yearPenalty;

  // Reward for a short, modest deal
  if (years === 1 && salary < 1.0) {
    baseline += 6;
  }

  // Randomness so it never feels purely deterministic
  const noise = (Math.random() * 20) - 10; // -10..10
  const score = baseline + noise;

  const accepted = score >= 52;

  let reason;
  if (accepted) {
    reason = "Ownership is comfortable with these terms for a first-time GM.";
  } else {
    if (salary > 1.75 && years >= 3) {
      reason =
        "Ownership is not comfortable committing that level of money and term to a first-time GM.";
    } else if (years === 3 && winPct > 0.55) {
      reason =
        "This front office prefers a shorter initial deal given the current trajectory of the roster.";
    } else if (salary > 1.25) {
      reason = "They view this number as aggressive for an initial GM contract.";
    } else {
      reason =
        "They are looking for more flexibility on the first deal before committing.";
    }
  }

  return {
    accepted,
    reason
    // score: Math.round(score) // kept internal; could be used for debugging or future tuning.
  };
}

// ---------------------------
// Build initial franchise save
//
// NOTE: This builds the canonical FranchiseSave *summary* object used by the
// landing screen and dashboards. The full league state (rosters, schedule,
// contracts, etc.) will live alongside this in a separate structure later.
// ---------------------------

function buildInitialFranchiseSave(team, contract, gmCredibility, seasonYear) {
  const nowIso = new Date().toISOString();
  const franchiseName = `${team.city} ${team.name} Football Operations`;
  const simpleTeamName = `${team.city} ${team.name}`;

  const { wins, losses } = parseRecord(team.lastSeasonRecord);
  const totalGames = wins + losses;
  const winPct = totalGames > 0 ? wins / totalGames : 0.5;

  const droughtYears =
    team.lastPlayoffAppearance == null
      ? 10
      : Math.max(0, (seasonYear - 1) - team.lastPlayoffAppearance);

  // Owner expectation heuristics: will be replaced by more detailed logic later.
  let patience = team.ownerPatience || "average";
  let targetOffsetYears;
  if (patience === "impatient") {
    targetOffsetYears = 1;
  } else if (patience === "patient") {
    targetOffsetYears = 3;
  } else {
    targetOffsetYears = 2;
  }

  let baselineWins;
  if (winPct > 0.6) baselineWins = 11;
  else if (winPct > 0.45) baselineWins = 10;
  else if (winPct > 0.3) baselineWins = 9;
  else baselineWins = 8;

  // GM age mechanics (future):
  // - Start at 40.
  // - Age ticks +1 every March 1 in the sim.
  // - Retirement around 70, with special rules for high-credibility GMs.
  const gmAgeStart = 40;
  const birthYear = seasonYear - gmAgeStart;

  /** @type {FranchiseSave} */
  const save = {
    version: 1,
    franchiseId: generateNewFranchiseId(),
    franchiseName,
    teamName: simpleTeamName, // compat / display helper for the landing page
    teamCode: team.teamCode,
    seasonYear,
    weekIndex: 0, // 0 = immediate post–Super Bowl offseason
    phase: "Offseason (Post-Super Bowl)",
    record: "0-0",
    lastPlayedISO: nowIso,

    accolades: {
      seasons: 0,
      playoffAppearances: 0,
      divisionTitles: 0,
      championships: 0
    },

    gmJob: {
      contractYears: contract.years,
      currentYear: 1,
      salaryPerYearMillions: contract.salaryPerYearMillions,
      contractTotalMillions: contract.totalMillions,
      status: "active",
      ageYears: gmAgeStart,
      birthYear
    },

    leagueSummary: {
      teams: 32,
      seasonsSimmed: 0
    },

    realismOptions: {
      injuriesOn: true,
      capMode: "realistic",
      difficulty: "simulation",
      ironman: true
    },

    ownerExpectation: {
      patience,
      targetYear: seasonYear + targetOffsetYears,
      baselineWins
    },

    // Hidden meta field that will influence future job offers,
    // media/fan perception, etc.
    gmCredibility
  };

  // TODO: Attach full leagueState structure elsewhere.

  return save;
}

// ---------------------------
// UI rendering – team views
// ---------------------------

function setTeamFeedback(message, isWarning) {
  const el = document.getElementById("team-feedback");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = isWarning ? "#facc15" : "var(--text-soft)";
}

function createLeagueView(container) {
  container.className = "team-list";

  if (!TEAMS.length) {
    container.innerHTML =
      '<div class="team-list-empty">No teams available.</div>';
    return;
  }

  container.innerHTML = "";

  TEAMS.forEach((team) => {
    const open = isTeamOpen(team.teamCode);
    const card = document.createElement("article");
    card.className = "team-card";

    if (open) {
      card.classList.add("team-card--open");
      card.tabIndex = 0;
    } else {
      card.classList.add("team-card--filled");
    }

    if (team.teamCode === appState.selectedTeamCode) {
      card.classList.add("team-card--selected");
    }

    const header = document.createElement("div");
    header.className = "team-card-header";

    const nameBlock = document.createElement("div");
    nameBlock.className = "team-name-line";
    const nameStrong = document.createElement("strong");
    nameStrong.textContent = `${team.city} ${team.name}`;
    const metaSpan = document.createElement("span");
    metaSpan.textContent = `${team.conference} ${team.division} • ${team.teamCode}`;
    nameBlock.appendChild(nameStrong);
    nameBlock.appendChild(metaSpan);

    const tag = document.createElement("div");
    tag.className = "team-tag";
    if (open) {
      tag.classList.add("team-tag--open");
      tag.innerHTML =
        '<span class="team-tag-dot"></span><span>GM Opening</span>';
    } else {
      tag.innerHTML = "<span>GM Filled</span>";
    }

    header.appendChild(nameBlock);
    header.appendChild(tag);

    const body = document.createElement("div");
    body.className = "team-card-body";

    const statCol = document.createElement("div");
    const statLines = [
      `Last season: <strong>${team.lastSeasonRecord}</strong>`,
      `Last 3 seasons: <strong>${team.lastThreeYearsRecord}</strong>`,
      team.lastPlayoffAppearance
        ? `Last playoffs: <strong>${team.lastPlayoffAppearance}</strong>`
        : `Last playoffs: <strong>Long drought</strong>`,
      `All-Pros: <strong>${team.allPros}</strong>`
    ];
    statLines.forEach((line) => {
      const p = document.createElement("div");
      p.className = "team-stat-line";
      p.innerHTML = line;
      statCol.appendChild(p);
    });

    const notesCol = document.createElement("div");
    notesCol.className = "team-notes";
    const ownerLabel = document.createElement("span");
    ownerLabel.className = "label";
    ownerLabel.textContent = "Owner / market";
    const ownerP = document.createElement("p");
    ownerP.textContent = team.ownerProfile;
    const marketP = document.createElement("p");
    marketP.textContent = team.marketProfile;
    const rosterLabel = document.createElement("span");
    rosterLabel.className = "label";
    rosterLabel.textContent = "Roster snapshot";
    const rosterP = document.createElement("p");
    rosterP.textContent = team.rosterSnapshot;

    notesCol.appendChild(ownerLabel);
    notesCol.appendChild(ownerP);
    notesCol.appendChild(marketP);
    notesCol.appendChild(rosterLabel);
    notesCol.appendChild(rosterP);

    body.appendChild(statCol);
    body.appendChild(notesCol);

    card.appendChild(header);
    card.appendChild(body);

    if (open) {
      card.addEventListener("click", () => handleTeamSelect(team.teamCode));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleTeamSelect(team.teamCode);
        }
      });
    } else {
      card.addEventListener("click", () => {
        setTeamFeedback(
          `GM position for ${team.city} ${team.name} is currently filled.`,
          true
        );
      });
    }

    container.appendChild(card);
  });
}

function groupTeamsByConference() {
  const groups = {};
  TEAMS.forEach((t) => {
    const key = t.conference;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  Object.values(groups).forEach((arr) =>
    arr.sort((a, b) => a.city.localeCompare(b.city))
  );
  return groups;
}

function groupTeamsByDivision() {
  const groups = {};
  TEAMS.forEach((t) => {
    const key = `${t.conference} ${t.division}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  Object.values(groups).forEach((arr) =>
    arr.sort((a, b) => a.city.localeCompare(b.city))
  );
  return groups;
}

function createConferenceView(container) {
  container.className = "team-groups";
  container.innerHTML = "";

  const groups = groupTeamsByConference();

  Object.keys(groups)
    .sort()
    .forEach((conf) => {
      const groupEl = document.createElement("section");
      groupEl.className = "team-group";

      const title = document.createElement("div");
      title.className = "team-group-title";
      title.textContent = `${conf} Conference`;

      const rowsWrapper = document.createElement("div");
      rowsWrapper.className = "team-rows";

      groups[conf].forEach((team) => {
        const row = document.createElement("div");
        row.className = "team-row";

        const open = isTeamOpen(team.teamCode);
        if (open) {
          row.classList.add("team-row--open");
          row.tabIndex = 0;
        }
        if (team.teamCode === appState.selectedTeamCode) {
          row.classList.add("team-row--selected");
        }

        const colTeam = document.createElement("span");
        colTeam.textContent = `${team.city} ${team.name} (${team.teamCode})`;

        const colRecord = document.createElement("span");
        colRecord.textContent = `Last: ${team.lastSeasonRecord}`;

        const colStatus = document.createElement("span");
        colStatus.textContent = open ? "GM Opening" : "GM Filled";
        colStatus.className = open ? "status-open" : "status-filled";

        row.appendChild(colTeam);
        row.appendChild(colRecord);
        row.appendChild(colStatus);

        if (open) {
          row.addEventListener("click", () =>
            handleTeamSelect(team.teamCode)
          );
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleTeamSelect(team.teamCode);
            }
          });
        } else {
          row.addEventListener("click", () => {
            setTeamFeedback(
              `GM position for ${team.city} ${team.name} is currently filled.`,
              true
            );
          });
        }

        rowsWrapper.appendChild(row);
      });

      groupEl.appendChild(title);
      groupEl.appendChild(rowsWrapper);
      container.appendChild(groupEl);
    });
}

function createDivisionView(container) {
  container.className = "team-groups";
  container.innerHTML = "";

  const groups = groupTeamsByDivision();

  Object.keys(groups)
    .sort()
    .forEach((divKey) => {
      const groupEl = document.createElement("section");
      groupEl.className = "team-group";

      const title = document.createElement("div");
      title.className = "team-group-title";
      title.textContent = divKey;

      const rowsWrapper = document.createElement("div");
      rowsWrapper.className = "team-rows";

      groups[divKey].forEach((team) => {
        const row = document.createElement("div");
        row.className = "team-row";

        const open = isTeamOpen(team.teamCode);
        if (open) {
          row.classList.add("team-row--open");
          row.tabIndex = 0;
        }
        if (team.teamCode === appState.selectedTeamCode) {
          row.classList.add("team-row--selected");
        }

        const colTeam = document.createElement("span");
        colTeam.textContent = `${team.city} ${team.name} (${team.teamCode})`;

        const colRecord = document.createElement("span");
        colRecord.textContent = `Last: ${team.lastSeasonRecord}`;

        const colStatus = document.createElement("span");
        colStatus.textContent = open ? "GM Opening" : "GM Filled";
        colStatus.className = open ? "status-open" : "status-filled";

        row.appendChild(colTeam);
        row.appendChild(colRecord);
        row.appendChild(colStatus);

        if (open) {
          row.addEventListener("click", () =>
            handleTeamSelect(team.teamCode)
          );
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleTeamSelect(team.teamCode);
            }
          });
        } else {
          row.addEventListener("click", () => {
            setTeamFeedback(
              `GM position for ${team.city} ${team.name} is currently filled.`,
              true
            );
          });
        }

        rowsWrapper.appendChild(row);
      });

      groupEl.appendChild(title);
      groupEl.appendChild(rowsWrapper);
      container.appendChild(groupEl);
    });
}

/**
 * Render current view mode.
 */
function renderTeamView() {
  const container = document.getElementById("team-container");
  if (!container) return;

  if (appState.viewMode === "league") {
    createLeagueView(container);
  } else if (appState.viewMode === "conference") {
    createConferenceView(container);
  } else {
    createDivisionView(container);
  }
}

// ---------------------------
// Contract / summary UI updates
// ---------------------------

function clampSalary(value) {
  const min = 0.25;
  const max = 2.0;
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function formatMoneyMillions(m) {
  return m.toFixed(2);
}

function updateContractDisplay() {
  const totalEl = document.getElementById("contract-total-text");
  if (!totalEl) return;
  const years = appState.contractYears;
  const salary = appState.salaryPerYearMillions;
  const total = years * salary;
  totalEl.innerHTML = `<strong>Total: $${formatMoneyMillions(
    total
  )}M</strong> over ${years} year${years === 1 ? "" : "s"}`;
}

function updateFranchiseNameAndContext() {
  const team =
    appState.selectedTeamCode && getTeamByCode(appState.selectedTeamCode);
  const nameEl = document.getElementById("franchise-name-display");
  const ownerEl = document.getElementById("owner-market-display");

  if (!nameEl || !ownerEl) return;

  if (!team) {
    nameEl.textContent = "Select an open team to set your franchise.";
    ownerEl.textContent =
      "Team context will appear here after you choose an opening.";
    return;
  }

  const franchiseName = `${team.city} ${team.name} Football Operations`;
  nameEl.textContent = franchiseName;

  ownerEl.textContent = `${team.ownerProfile} ${team.marketProfile}`;
}

function updateSummaryCard() {
  const team =
    appState.selectedTeamCode && getTeamByCode(appState.selectedTeamCode);

  const franchiseNameEl = document.getElementById("summary-franchise-name");
  const teamLineEl = document.getElementById("summary-team-line");
  const seasonLineEl = document.getElementById("summary-season-line");
  const phaseLineEl = document.getElementById("summary-phase-line");
  const contractLineEl = document.getElementById("summary-contract-line");
  const ownerLineEl = document.getElementById("summary-owner-line");

  if (
    !franchiseNameEl ||
    !teamLineEl ||
    !seasonLineEl ||
    !phaseLineEl ||
    !contractLineEl ||
    !ownerLineEl
  ) {
    return;
  }

  const years = appState.contractYears;
  const salary = appState.salaryPerYearMillions;
  const total = years * salary;

  if (!team) {
    franchiseNameEl.textContent = "No team selected";
    teamLineEl.textContent = "—";
    seasonLineEl.textContent = "—";
    phaseLineEl.textContent = "Offseason (Post-Super Bowl)";
    contractLineEl.textContent = "—";
    ownerLineEl.textContent = "—";
    return;
  }

  const franchiseName = `${team.city} ${team.name} Football Operations`;
  franchiseNameEl.textContent = franchiseName;
  teamLineEl.textContent = `${team.city} ${team.name} (${team.teamCode})`;
  seasonLineEl.textContent = `${appState.seasonYear}`;
  phaseLineEl.textContent = "Offseason (Post-Super Bowl)";
  contractLineEl.textContent = `${years} year${
    years === 1 ? "" : "s"
  }, $${formatMoneyMillions(salary)}M per year, $${formatMoneyMillions(
    total
  )}M total`;

  const droughtText = team.lastPlayoffAppearance
    ? `Last playoffs: ${team.lastPlayoffAppearance}`
    : "Long playoff drought";
  const patienceText = team.ownerPatience || "average";
  ownerLineEl.textContent = `Owner: ${patienceText}; ${droughtText}.`;
}

function updateCreateButtonState() {
  const btn = document.getElementById("btn-create-franchise");
  if (!btn) return;
  const team =
    appState.selectedTeamCode && getTeamByCode(appState.selectedTeamCode);
  const salary = appState.salaryPerYearMillions;
  const validSalary =
    Number.isFinite(salary) && salary >= 0.25 && salary <= 2.0;
  const validYears =
    appState.contractYears >= 1 && appState.contractYears <= 3;
  const attempts =
    team && appState.negotiationAttemptsByTeam[team.teamCode]
      ? appState.negotiationAttemptsByTeam[team.teamCode]
      : 0;
  const attemptsRemaining = team ? Math.max(0, 3 - attempts) : 3;

  const enabled = !!team && validSalary && validYears && attemptsRemaining > 0;
  btn.disabled = !enabled;
}

function updateExistingSaveNote() {
  const noteEl = document.getElementById("existing-save-note");
  if (!noteEl) return;
  const save = loadLastFranchise();
  if (!save) {
    noteEl.hidden = true;
    noteEl.textContent = "";
    return;
  }

  const displayName =
    save.franchiseName ||
    save.teamName ||
    "Existing franchise";
  const teamCode = save.teamCode || "";
  const line = teamCode
    ? `${displayName} (${teamCode})`
    : displayName;

  noteEl.hidden = false;
  noteEl.textContent = `Current active franchise: ${line}. Creating a new franchise here will overwrite it.`;
}

function updateAttemptNote() {
  const noteEl = document.getElementById("attempt-note");
  const team =
    appState.selectedTeamCode && getTeamByCode(appState.selectedTeamCode);
  if (!noteEl || !team) {
    if (noteEl) noteEl.textContent = "";
    return;
  }

  const attempts = appState.negotiationAttemptsByTeam[team.teamCode] || 0;
  const remaining = Math.max(0, 3 - attempts);

  if (remaining <= 0) {
    noteEl.textContent =
      "Negotiations with this owner have ended for this offseason. Select another opening or adjust your approach.";
  } else {
    noteEl.textContent = `Negotiation attempts with this owner this offseason: ${attempts} used, ${remaining} remaining.`;
  }
}

// ---------------------------
// Event handlers
// ---------------------------

function handleViewModeChange(mode) {
  if (appState.viewMode === mode) return;
  appState.viewMode = mode;

  const buttons = document.querySelectorAll("[data-view-mode]");
  buttons.forEach((btn) => {
    const m = btn.getAttribute("data-view-mode");
    btn.setAttribute("aria-pressed", m === mode ? "true" : "false");
  });

  renderTeamView();
}

function handleTeamSelect(teamCode) {
  if (!isTeamOpen(teamCode)) {
    setTeamFeedback("That GM job is currently filled.", true);
    return;
  }

  appState.selectedTeamCode = teamCode;
  setTeamFeedback("", false);

  // Reset contract feedback when changing team.
  const feedbackEl = document.getElementById("contract-feedback");
  if (feedbackEl) {
    feedbackEl.textContent = "";
    feedbackEl.classList.remove(
      "contract-feedback--error",
      "contract-feedback--success"
    );
  }

  // Render again to highlight selection in whatever view we're in.
  renderTeamView();
  updateFranchiseNameAndContext();
  updateSummaryCard();
  updateCreateButtonState();
  updateAttemptNote();
}

function handleContractYearsClick(years) {
  appState.contractYears = years;
  const buttons = document.querySelectorAll(
    ".contract-years-buttons button"
  );
  buttons.forEach((btn) => {
    const y = Number(btn.getAttribute("data-years"));
    btn.setAttribute("aria-pressed", y === years ? "true" : "false");
  });
  updateContractDisplay();
  updateSummaryCard();
  updateCreateButtonState();
}

function handleSalaryInputChange() {
  const input = document.getElementById("salary-input");
  if (!input) return;
  const value = Number(input.value);
  const clamped = clampSalary(value);
  appState.salaryPerYearMillions = clamped;
  if (value !== clamped) {
    input.value = clamped.toFixed(2);
  }
  updateContractDisplay();
  updateSummaryCard();
  updateCreateButtonState();
}

/**
 * Final "Create Franchise" click:
 * - Validates selection and contract.
 * - Evaluates contract acceptance.
 * - On success, builds save and navigates.
 * - On rejection, shows a realistic message and counts attempts.
 */
function handleCreateFranchise() {
  const team =
    appState.selectedTeamCode && getTeamByCode(appState.selectedTeamCode);
  const feedbackEl = document.getElementById("contract-feedback");

  if (!team || !feedbackEl) return;

  const years = appState.contractYears;
  const salary = appState.salaryPerYearMillions;

  // Basic validation guard
  if (!isTeamOpen(team.teamCode)) {
    feedbackEl.textContent =
      "That GM job is no longer available. Select another opening.";
    feedbackEl.classList.add("contract-feedback--error");
    return;
  }

  if (
    !Number.isFinite(salary) ||
    salary < 0.25 ||
    salary > 2.0 ||
    years < 1 ||
    years > 3
  ) {
    feedbackEl.textContent =
      "Contract terms are out of bounds. Years must be 1–3 and salary must be between $0.25M and $2.0M per year.";
    feedbackEl.classList.add("contract-feedback--error");
    return;
  }

  const attempts = appState.negotiationAttemptsByTeam[team.teamCode] || 0;
  if (attempts >= 3) {
    feedbackEl.textContent =
      "This owner has ended talks for this offseason. Choose another opening.";
    feedbackEl.classList.add("contract-feedback--error");
    updateCreateButtonState();
    updateAttemptNote();
    return;
  }

  const proposal = {
    years,
    salaryPerYearMillions: salary,
    totalMillions: years * salary
  };

  const result = evaluateContractOffer(
    team,
    proposal,
    appState.gmCredibility,
    appState.seasonYear
  );

  if (result.accepted) {
    feedbackEl.textContent = result.reason;
    feedbackEl.classList.remove("contract-feedback--error");
    feedbackEl.classList.add("contract-feedback--success");

    // Build and save FranchiseSave, overwriting any existing franchise.
    const save = buildInitialFranchiseSave(
      team,
      proposal,
      appState.gmCredibility,
      appState.seasonYear
    );
    saveLastFranchise(save);

    // Navigation into the main Franchise view.
    navigateToFranchise();
  } else {
    const newAttempts = attempts + 1;
    appState.negotiationAttemptsByTeam[team.teamCode] = newAttempts;
    feedbackEl.textContent = result.reason;
    feedbackEl.classList.remove("contract-feedback--success");
    feedbackEl.classList.add("contract-feedback--error");

    setTeamFeedback(
      `Offer declined by ${team.city} ${team.name}. You can adjust terms and try again (limit 3 attempts per team).`,
      true
    );

    updateAttemptNote();
    updateCreateButtonState();
  }
}

// ---------------------------
// Initialization
// ---------------------------

function initTeamSelect() {
  // View mode buttons
  const btnLeague = document.getElementById("btn-view-league");
  const btnConf = document.getElementById("btn-view-conference");
  const btnDiv = document.getElementById("btn-view-division");

  if (btnLeague) {
    btnLeague.addEventListener("click", () => handleViewModeChange("league"));
  }
  if (btnConf) {
    btnConf.addEventListener("click", () =>
      handleViewModeChange("conference")
    );
  }
  if (btnDiv) {
    btnDiv.addEventListener("click", () =>
      handleViewModeChange("division")
    );
  }

  // Contract years segmented control
  const yearButtons = document.querySelectorAll(
    ".contract-years-buttons button"
  );
  yearButtons.forEach((btn) => {
    const y = Number(btn.getAttribute("data-years"));
    btn.addEventListener("click", () => handleContractYearsClick(y));
  });

  // Salary input
  const salaryInput = document.getElementById("salary-input");
  if (salaryInput) {
    salaryInput.addEventListener("change", handleSalaryInputChange);
    salaryInput.addEventListener("blur", handleSalaryInputChange);
    salaryInput.addEventListener("input", () => {
      // Do not spam; just update live while typing
      const value = Number(salaryInput.value);
      appState.salaryPerYearMillions = clampSalary(value);
      updateContractDisplay();
      updateSummaryCard();
      updateCreateButtonState();
    });
  }

  // Create franchise button
  const createBtn = document.getElementById("btn-create-franchise");
  if (createBtn) {
    createBtn.addEventListener("click", handleCreateFranchise);
  }

  // Initial render
  renderTeamView();
  updateContractDisplay();
  updateFranchiseNameAndContext();
  updateSummaryCard();
  updateCreateButtonState();
  updateExistingSaveNote();
  updateAttemptNote();

  // Initial info
  setTeamFeedback(
    "Select an open GM job to begin. Openings are highlighted; filled jobs are informational only.",
    false
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTeamSelect);
} else {
  initTeamSelect();
}

// ---------------------------
// Future hooks / notes
// ---------------------------
//
// - Job market & interviews:
//   * Instead of one screen, you might have multiple rounds where AI candidates
//     are also interviewing for the same openings. This module could expose a
//     function to generate candidate pools, and evaluateContractOffer would be
//     called for each candidate with different gmCredibility values.
//
// - Multi-career meta & credibility:
//   * gmCredibility can be adjusted after each season or major event
//     (playoff runs, firings, retirements).
//   * Future restarts could seed gmCredibility from prior careers,
//     giving “veteran GM” runs a different starting point.
//
// - Age & retirement:
//   * At the end of each sim season, increment gmJob.ageYears based on
//     birthYear and current seasonYear (tick on March 1).
//   * Around age 70, force retirement unless gmCredibility is extremely high.
//     For example, if gmCredibility >= 90, you could give a 10% chance per
//     point above 90 to continue one more year.
//
// - Owner expectation tuning:
//   * ownerExpectation.targetYear and baselineWins can later be computed from
//     richer sim history: roster age curve, cap position, prior run of success.
//   * That object will eventually be used for “hot seat” logic and owner
//     meetings, not just hiring decisions.
//
// - GM profile / history:
//   * A future GM Profile page can read this save plus a history log
//     (stored elsewhere) including contract history, team changes,
//     credibility swings, and championships won.
