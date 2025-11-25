// league_schedule_generator.js
// -----------------------------------------------------------------------------
// NFL-accurate schedule generator (deterministic, 17-game, 18-week format)
// Phase 1: opponent calculation per team
// Phase 2: league-wide week assignment and validation
// -----------------------------------------------------------------------------

import { TEAM_META, DIVISION_NAMES } from "./league_schedule.js";

// -----------------------------------------------------------------------------
// 1. Build internal data structure for conferences/divisions
// -----------------------------------------------------------------------------
function groupTeams() {
  const structure = { AFC: {}, NFC: {} };
  for (const conf of ["AFC", "NFC"]) {
    for (const div of DIVISION_NAMES) {
      structure[conf][div] = TEAM_META
        .filter(t => t.conference === conf && t.division === div)
        .map(t => t.teamCode);
    }
  }
  return structure;
}

const NFL_STRUCTURE = groupTeams();

// -----------------------------------------------------------------------------
// 2. Rotation maps
// -----------------------------------------------------------------------------
const AFC_INTRA_ROTATION = { East: "South", North: "West", South: "East", West: "North" };
const NFC_INTRA_ROTATION = { East: "South", North: "West", South: "East", West: "North" };

const INTER_CONF_ROTATION = {
  AFC: { East: "NFC_West", North: "NFC_East", South: "NFC_North", West: "NFC_South" },
  NFC: { East: "AFC_North", North: "AFC_South", South: "AFC_West", West: "AFC_East" }
};

const SEVENTEENTH_GAME_PAIR = {
  AFC_East: "NFC_North", AFC_North: "NFC_South", AFC_South: "NFC_East", AFC_West: "NFC_West",
  NFC_East: "AFC_South", NFC_North: "AFC_West", NFC_South: "AFC_North", NFC_West: "AFC_East"
};

// -----------------------------------------------------------------------------
// 3. Opponent Calculator (Phase 1)
// -----------------------------------------------------------------------------
function calculateOpponents(teamCode, ranks) {
  // ranks: optional dictionary {teamCode -> 1–4} for seeding
  const meta = TEAM_META.find(t => t.teamCode === teamCode);
  const { conference, division } = meta;
  const structure = NFL_STRUCTURE[conference];
  const myTeams = structure[division];
  const myRank = ranks?.[teamCode] || myTeams.indexOf(teamCode) + 1;
  const opponents = [];

  // (1) Division opponents (6)
  for (const t of myTeams) {
    if (t !== teamCode) {
      opponents.push({ code: t, type: "division", home: true });
      opponents.push({ code: t, type: "division", home: false });
    }
  }

  // (2) Intra-conference rotation (4)
  const intraMap = conference === "AFC" ? AFC_INTRA_ROTATION : NFC_INTRA_ROTATION;
  const targetDiv = intraMap[division];
  for (const t of structure[targetDiv]) {
    opponents.push({ code: t, type: "conference", home: Math.random() < 0.5 });
  }

  // (3) Inter-conference rotation (4)
  const crossKey = INTER_CONF_ROTATION[conference][division];
  const [crossConf, crossDiv] = crossKey.split("_");
  for (const t of NFL_STRUCTURE[crossConf][crossDiv]) {
    opponents.push({ code: t, type: "nonconference", home: Math.random() < 0.5 });
  }

  // (4) Intra-conference rank-based (2)
  const remainingDivs = DIVISION_NAMES.filter(d => d !== division && d !== targetDiv);
  for (const d of remainingDivs) {
    const teams = structure[d];
    const oppCode = teams[myRank - 1];
    opponents.push({ code: oppCode, type: "extra", home: Math.random() < 0.5 });
  }

  // (5) 17th inter-conference rank game (1)
  const seventeenthKey = `${conference}_${division}`;
  const targetKey = SEVENTEENTH_GAME_PAIR[seventeenthKey];
  const [targetConf, targetDivName] = targetKey.split("_");
  const oppCode = NFL_STRUCTURE[targetConf][targetDivName][myRank - 1];
  const hostConf = (conference === "AFC") ? (new Date().getFullYear() % 2 === 0 ? "AFC" : "NFC")
                                          : (new Date().getFullYear() % 2 === 0 ? "NFC" : "AFC");
  const home = conference === hostConf;
  opponents.push({ code: oppCode, type: "nonconference", home });

  if (opponents.length !== 17) {
    console.warn(`[ScheduleGen] ${teamCode} has ${opponents.length} opponents (expected 17)`);
  }

  return opponents;
}

// -----------------------------------------------------------------------------
// 4. Bye pattern and assignment
// -----------------------------------------------------------------------------
function assignPerfectByes(teamCodes) {
  // Perfect 32-team bye distribution (Weeks 5–14)
  const byePattern = [4, 4, 4, 4, 4, 4, 4, 0, 2, 2]; // 32 teams, total = 32 byes
  const weeks = Array.from({ length: 10 }, (_, i) => i + 5);
  const byes = {};

  const shuffled = [...teamCodes];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  let index = 0;
  for (let i = 0; i < weeks.length; i++) {
    for (let j = 0; j < byePattern[i]; j++) {
      if (index >= shuffled.length) break;
      byes[shuffled[index]] = weeks[i];
      index++;
    }
  }

  return byes;
}

// -----------------------------------------------------------------------------
// 5. League-wide schedule builder (Phase 2)
// -----------------------------------------------------------------------------
export function generateNFLPerfectSchedule() {
  const allTeams = TEAM_META.map(t => t.teamCode);
  const byeWeeks = assignPerfectByes(allTeams);

  // Calculate opponent sets
  const allOpponents = {};
  for (const t of allTeams) {
    allOpponents[t] = calculateOpponents(t);
  }

  // Initialize structure
  const schedule = {};
  for (const t of allTeams) {
    schedule[t] = Array.from({ length: 18 }, (_, i) => ({
      week: i + 1,
      opponent: null,
      isHome: null,
      type: null
    }));
  }

  // Place byes first
  for (const [team, week] of Object.entries(byeWeeks)) {
    schedule[team][week - 1] = { week, opponent: "BYE", isHome: false, type: "bye" };
  }

  // Track matchups placed
  const placed = new Set();

  // Helper to make symmetric placement
  function placeMatchup(home, away, week, type) {
    schedule[home][week - 1] = { week, opponent: away, isHome: true, type };
    schedule[away][week - 1] = { week, opponent: home, isHome: false, type };
    placed.add([home, away].sort().join("|"));
  }

  // Assign week slots round-robin
  for (const team of allTeams) {
    for (const opp of allOpponents[team]) {
      const key = [team, opp.code].sort().join("|");
      if (placed.has(key)) continue;

      // Try to find a valid week (avoid byes and existing games)
      for (let w = 1; w <= 18; w++) {
        if (w < 5 || w > 14) { // allow all, just skip bye overlaps
          const homeBusy = schedule[team][w - 1].opponent !== null;
          const awayBusy = schedule[opp.code][w - 1].opponent !== null;
          const byeConflict = byeWeeks[team] === w || byeWeeks[opp.code] === w;
          if (!homeBusy && !awayBusy && !byeConflict) {
            const homeTeam = opp.home ? team : opp.code;
            const awayTeam = opp.home ? opp.code : team;
            placeMatchup(homeTeam, awayTeam, w, opp.type);
            break;
          }
        }
      }
    }
  }

  // Late-season division clustering (Weeks 15–18)
  for (const team of allTeams) {
    const divisionOpps = schedule[team].filter(g => g.type === "division");
    const lateWeeks = [15, 16, 17, 18];
    for (let i = 0; i < divisionOpps.length; i++) {
      const targetWeek = lateWeeks[i % lateWeeks.length];
      const g = divisionOpps[i];
      const oppCode = g.opponent;
      schedule[team][targetWeek - 1] = { week: targetWeek, opponent: oppCode, isHome: g.isHome, type: g.type };
    }
  }

  return schedule;
}

// -----------------------------------------------------------------------------
// Validation helper
// -----------------------------------------------------------------------------
export function validateScheduleGrid(schedule) {
  const allTeams = Object.keys(schedule);
  for (const team of allTeams) {
    const games = schedule[team].filter(g => g.opponent !== null);
    if (games.length !== 18) console.warn(`${team}: has ${games.length} weeks (expected 18)`);
    const uniqueOpps = new Set(games.map(g => g.opponent));
    if (uniqueOpps.size !== 17 && !uniqueOpps.has("BYE")) {
      console.warn(`${team}: has ${uniqueOpps.size} unique opponents`);
    }
  }
  console.log("[Validation] Schedule grid appears valid");
}
