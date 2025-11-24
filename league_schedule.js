// league_schedule.js
// -----------------------------------------------------------------------------
// Shared schedule engine (no DOM, no localStorage).
// Used by: schedule.js, franchise_gameday.js, franchise.js (season rollover).
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} TeamGame
 * @property {number} index
 * @property {number} seasonWeek
 * @property {string} teamCode
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

// -----------------------------------------------------------------------------
// Team metadata
// -----------------------------------------------------------------------------
export const TEAM_META = [
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
  
  // -----------------------------------------------------------------------------
  // Rotations
  // -----------------------------------------------------------------------------
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
  
  export function getCrossConferenceDivision(conference, division, seasonYear) {
    const baseYear = 2022;
    const offsetRaw = (seasonYear - baseYear) % 4;
    const offset = offsetRaw < 0 ? offsetRaw + 4 : offsetRaw;
    const divIndex = DIVISION_NAMES.indexOf(division);
    if (divIndex < 0) return "East";
    const oppIndex = (divIndex + offset) % 4;
    return DIVISION_NAMES[oppIndex];
  }
  
  export function getSameConferenceOppDivision(conference, division, seasonYear) {
    const rotations = SAME_CONF_ROTATION[conference];
    if (!rotations) return "East";
    const baseYear = 2023;
    const rawIdx = (seasonYear - baseYear) % rotations.length;
    const idx = rawIdx < 0 ? rawIdx + rotations.length : rawIdx;
    const config = rotations[idx];
    return config[division] || division;
  }
  
  // -----------------------------------------------------------------------------
  // Single-team schedule
  // -----------------------------------------------------------------------------
  export function generateTeamSchedule(teamCode, seasonYear) {
    const meta = getTeamMeta(teamCode);
    if (!meta) {
      console.warn("[Schedule] generateTeamSchedule: unknown team", teamCode);
      return [];
    }
  
    const conference = meta.conference;
    const division = meta.division;
  
    const divTeams = getDivisionTeams(conference, division);
    const selfIndex = divTeams.indexOf(teamCode);
    if (selfIndex < 0) {
      console.warn("[Schedule] team not found in division", teamCode);
      return [];
    }
  
    /** @type {TeamGame[]} */
    const games = [];
  
    // 1) Division home/away
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
  
    // 2) Same-conference rotation
    const sameConfDivision = getSameConferenceOppDivision(conference, division, seasonYear);
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
  
    // 3) Cross-conference rotation
    const otherConference = conference === "AFC" ? "NFC" : "AFC";
    const crossDivision = getCrossConferenceDivision(conference, division, seasonYear);
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
  
    // 4) Extra same-conf vs remaining divisions
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
  
    // Bucket and order into weeks, then assign dates
    const divisionGames = games.filter(g => g.type === "division");
    const confGames     = games.filter(g => g.type === "conference");
    const nonConfGames  = games.filter(g => g.type === "nonconference");
    const extraGames    = games.filter(g => g.type === "extra");
  
    const pull = (list) => (list.length ? list.shift() : null);
    divisionGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
    confGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
    nonConfGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
    extraGames.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
  
    /** @type {TeamGame[]} */
    const ordered = [];
  
    for (let i = 0; i < 4; i++) {
      const g = pull(nonConfGames) || pull(confGames) || pull(extraGames) || pull(divisionGames);
      if (g) ordered.push(g);
    }
    for (let i = 0; i < 4; i++) {
      const g = pull(divisionGames) || pull(confGames) || pull(nonConfGames) || pull(extraGames);
      if (g) ordered.push(g);
    }
    for (let i = 0; i < 4; i++) {
      const g = pull(confGames) || pull(nonConfGames) || pull(divisionGames) || pull(extraGames);
      if (g) ordered.push(g);
    }
    while (divisionGames.length || confGames.length || nonConfGames.length || extraGames.length) {
      const g = pull(divisionGames) || pull(confGames) || pull(nonConfGames) || pull(extraGames);
      if (g) ordered.push(g);
    }
  
    const baseDate = new Date(seasonYear, 8, 10, 13, 0, 0, 0); // Sept ~10 1PM
    ordered.forEach((g, idx) => {
      g.index = idx;
      g.seasonWeek = idx + 1;
      const d = new Date(baseDate.getTime());
      d.setDate(baseDate.getDate() + idx * 7);
      g.kickoffIso = d.toISOString();
    });
  
    if (ordered.length !== 16) {
      console.warn("[Schedule] unexpected game count", teamCode, seasonYear, ordered.length);
    }
  
    return ordered;
  }
  
  // -----------------------------------------------------------------------------
  // League-level helpers
  // -----------------------------------------------------------------------------
  export function ensureLeagueScheduleObject(leagueState, seasonYear) {
    if (!leagueState.schedule || leagueState.schedule.seasonYear !== seasonYear) {
      leagueState.schedule = { seasonYear, byTeam: {} };
    } else if (!leagueState.schedule.byTeam) {
      leagueState.schedule.byTeam = {};
    }
    return leagueState.schedule;
  }
  
  export function ensureTeamSchedule(leagueState, teamCode, seasonYear) {
    const schedule = ensureLeagueScheduleObject(leagueState, seasonYear);
    if (!schedule.byTeam[teamCode]) {
      schedule.byTeam[teamCode] = generateTeamSchedule(teamCode, schedule.seasonYear);
    }
    return schedule.byTeam[teamCode];
  }
  
  export function ensureAllTeamSchedules(leagueState, seasonYear) {
    const schedule = ensureLeagueScheduleObject(leagueState, seasonYear);
    TEAM_META.forEach((t) => {
      if (!schedule.byTeam[t.teamCode]) {
        schedule.byTeam[t.teamCode] = generateTeamSchedule(t.teamCode, schedule.seasonYear);
      }
    });
    return schedule;
  }
  
  export function recomputeRecordFromSchedule(leagueState, teamCode) {
    const schedule = leagueState.schedule;
    if (!schedule || !schedule.byTeam || !schedule.byTeam[teamCode]) {
      return "0-0";
    }
    const games = schedule.byTeam[teamCode];
    let wins = 0, losses = 0, ties = 0;
    for (const g of games) {
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
  