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
 * @property {"division"|"conference"|"nonconference"|"extra"|"bye"} type
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
  // Single-team schedule (17 games, 1 bye week between Weeks 5–10)
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
    if (selfIndex < 0) return [];
  
    /** @type {TeamGame[]} */
    const games = [];
  
    // 1) Division home/away (6)
    divTeams.forEach((opCode, idx) => {
      if (opCode === teamCode) return;
      const homeFirst = selfIndex <= idx;
      games.push({
        index: -1, seasonWeek: 0, teamCode, opponentCode: opCode, isHome: homeFirst,
        type: "division", kickoffIso: null, status: "scheduled", teamScore: null, opponentScore: null
      });
      games.push({
        index: -1, seasonWeek: 0, teamCode, opponentCode: opCode, isHome: !homeFirst,
        type: "division", kickoffIso: null, status: "scheduled", teamScore: null, opponentScore: null
      });
    });
  
    // 2) Same-conference rotation (4)
    const sameConfDivision = getSameConferenceOppDivision(conference, division, seasonYear);
    getDivisionTeams(conference, sameConfDivision).forEach((opCode, idx) => {
      const isHome = ((seasonYear + selfIndex + idx) & 1) === 0;
      games.push({
        index: -1, seasonWeek: 0, teamCode, opponentCode: opCode, isHome,
        type: "conference", kickoffIso: null, status: "scheduled", teamScore: null, opponentScore: null
      });
    });
  
    // 3) Cross-conference rotation (4)
    const otherConference = conference === "AFC" ? "NFC" : "AFC";
    const crossDivision = getCrossConferenceDivision(conference, division, seasonYear);
    getDivisionTeams(otherConference, crossDivision).forEach((opCode, idx) => {
      const isHome = ((seasonYear + idx) & 1) === 0;
      games.push({
        index: -1, seasonWeek: 0, teamCode, opponentCode: opCode, isHome,
        type: "nonconference", kickoffIso: null, status: "scheduled", teamScore: null, opponentScore: null
      });
    });
  
    // 4) Extra intra-conference game (1)
    const remainingDivisions = DIVISION_NAMES.filter((d) => d !== division && d !== sameConfDivision);
    const targetDiv = remainingDivisions[selfIndex % remainingDivisions.length];
    const oppTeam = getDivisionTeams(conference, targetDiv)[selfIndex % 4];
    games.push({
      index: -1, seasonWeek: 0, teamCode, opponentCode: oppTeam, isHome: Math.random() < 0.5,
      type: "extra", kickoffIso: null, status: "scheduled", teamScore: null, opponentScore: null
    });
  
    // ========== 17 total games ==========
    // Add 1 BYE WEEK between Weeks 5–10
    const byeWeek = 5 + Math.floor(Math.random() * 6);
    const byeGame = {
      index: -1, seasonWeek: byeWeek, teamCode, opponentCode: "BYE", isHome: false,
      type: "bye", kickoffIso: null, status: "scheduled", teamScore: null, opponentScore: null
    };
  
    // Order and assign dates (18 total weeks)
    const ordered = [...games];
    ordered.sort((a, b) => a.opponentCode.localeCompare(b.opponentCode));
    ordered.splice(byeWeek - 1, 0, byeGame);
  
    const baseDate = new Date(seasonYear, 8, 7); // ~Sept 7 (Thursday)
    const SLOTS = {
      THU: { dayOffset: 0, hour: 20, minute: 20 },
      SUN_930: { dayOffset: 3, hour: 9, minute: 30 },
      SUN_1: { dayOffset: 3, hour: 13, minute: 0 },
      SUN_415: { dayOffset: 3, hour: 16, minute: 15 },
      SUN_425: { dayOffset: 3, hour: 16, minute: 25 },
      SUN_820: { dayOffset: 3, hour: 20, minute: 20 },
      MON_700: { dayOffset: 4, hour: 19, minute: 0 },
      MON_1000: { dayOffset: 4, hour: 22, minute: 0 }
    };
  
    const WEST_COAST = ["SEA", "SF", "LAR", "ARI", "LV", "LAC", "DEN"];
    const MOUNTAIN = ["DEN", "ARI"];
    let thursdayTeamUsed = new Set();
    let mondayTeamUsed = new Set();
    let sundayNightUsed = new Set();
  
    ordered.forEach((g, idx) => {
      g.index = idx;
      g.seasonWeek = idx + 1;
  
      if (g.type === "bye") {
        g.kickoffIso = null;
        return;
      }
  
      let slot = SLOTS.SUN_1;
      const isLateTeam = WEST_COAST.includes(g.teamCode) || MOUNTAIN.includes(g.teamCode);
      if (isLateTeam && Math.random() < 0.7) {
        const lateSlots = [SLOTS.SUN_415, SLOTS.SUN_425, SLOTS.MON_1000];
        slot = lateSlots[Math.floor(Math.random() * lateSlots.length)];
      }
  
      if (idx % 7 === 0 && !thursdayTeamUsed.has(g.teamCode)) {
        slot = SLOTS.THU;
        thursdayTeamUsed.add(g.teamCode);
      }
      if (idx % 7 === 1 && !sundayNightUsed.has(g.teamCode)) {
        slot = SLOTS.SUN_820;
        sundayNightUsed.add(g.teamCode);
      }
      if (idx % 7 === 2 && !mondayTeamUsed.has(g.teamCode) && !thursdayTeamUsed.has(g.teamCode)) {
        slot = Math.random() < 0.5 ? SLOTS.MON_700 : SLOTS.MON_1000;
        mondayTeamUsed.add(g.teamCode);
      }
      if ((g.seasonWeek === 5 || g.seasonWeek === 6) && Math.random() < 0.15) {
        slot = SLOTS.SUN_930;
      }
  
      const kickoff = new Date(Date.UTC(seasonYear, 8, 7, 0, 0, 0, 0)); // Sept 7 (Thursday UTC)
      kickoff.setUTCDate(kickoff.getUTCDate() + (g.seasonWeek - 1) * 7 + slot.dayOffset);
      kickoff.setUTCHours(slot.hour, slot.minute, 0, 0);
      g.kickoffIso = kickoff.toISOString();
    });
  
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
    if (!schedule || !schedule.byTeam || !schedule.byTeam[teamCode]) return "0-0";
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
  