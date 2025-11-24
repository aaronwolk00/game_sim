// franchise_gameday.js
//
// Franchise GM – Game Day / Single Game Simulation
//
// Responsibilities:
// - Load the active franchise and league state
// - Identify this week’s scheduled game
// - Initialize the UI with correct team names, kickoff time, and records
// - Simulate the full game using the imported game engine
// - Render results: scoreboard, scoring summary, drive log, and team stats
// - Save updated record and stats back into league state
//
// Dependencies: game_engine.js (core simulation logic), layer3_rosters.js (rosters per team)
//
// ---------------------------------------------------------------------------
// Storage Keys & Helpers
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

function storageAvailable() {
  try {
    const testKey = "__franchise_gm_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function loadLastFranchise() {
  if (!storageAvailable()) return null;
  const raw = window.localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadLeagueState(franchiseId) {
  if (!storageAvailable() || !franchiseId) return null;
  const raw = window.localStorage.getItem(getLeagueStateKey(franchiseId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveLeagueState(state) {
  if (!storageAvailable() || !state || !state.franchiseId) return;
  window.localStorage.setItem(getLeagueStateKey(state.franchiseId), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Imports – Assume you’ve added these as separate JS modules/files
// ---------------------------------------------------------------------------
//
// import { simulateGame } from "./game_engine.js";
// import { ROSTERS } from "./layer3_rosters.js";
//
// (For now we’ll stub simulateGame inline for completeness.)

function simulateGame(teamA, teamB, context = {}) {
  // Placeholder: integrate your real engine later.
  // Returns fake data shaped like your simulation output.
  const randomScoreA = Math.floor(17 + Math.random() * 24);
  const randomScoreB = Math.floor(10 + Math.random() * 24);
  const drives = [
    { quarter: 1, summary: `${teamA} opening drive TD pass` },
    { quarter: 2, summary: `${teamB} responds with field goal` },
    { quarter: 3, summary: `${teamA} defensive touchdown` },
    { quarter: 4, summary: `${teamB} late rally falls short` }
  ];
  const scoring = [
    { team: teamA, quarter: 1, points: 7, desc: "TD – 12 yd pass" },
    { team: teamB, quarter: 2, points: 3, desc: "FG – 42 yd" },
    { team: teamA, quarter: 3, points: 7, desc: "Defensive TD" },
    { team: teamB, quarter: 4, points: 7, desc: "Rushing TD" }
  ];
  return {
    teamA,
    teamB,
    finalScore: { [teamA]: randomScoreA, [teamB]: randomScoreB },
    quarters: [
      [7, 0],
      [0, 3],
      [7, 0],
      [0, 7]
    ],
    drives,
    scoring,
    teamStats: {
      [teamA]: {
        totalYards: 385,
        passYards: 260,
        rushYards: 125,
        turnovers: 1,
        timeOfPoss: "31:42"
      },
      [teamB]: {
        totalYards: 312,
        passYards: 198,
        rushYards: 114,
        turnovers: 2,
        timeOfPoss: "28:18"
      }
    },
    topPerformers: {
      [teamA]: [
        { name: "QB1", role: "QB", line: "22/33, 260 yds, 2 TD" },
        { name: "RB1", role: "RB", line: "18 carries, 91 yds, TD" }
      ],
      [teamB]: [
        { name: "QB2", role: "QB", line: "21/37, 198 yds, TD" },
        { name: "WR1", role: "WR", line: "6 rec, 82 yds" }
      ]
    }
  };
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function formatIso(iso) {
  if (!iso) return "Date TBA";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Date TBA";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeader(save, matchup) {
  const teamName = save.teamName || save.franchiseName;
  $("gameday-team-heading").textContent = teamName;
  $("gameday-season-line").textContent = `Season ${save.seasonYear} • ${save.phase} • Week ${save.weekIndex + 1}`;
  $("gameday-record-pill-value").textContent = save.record || "0–0";
}

function renderPregameInfo(matchup) {
  $("score-away-name").textContent = matchup.awayName;
  $("score-away-code").textContent = matchup.awayCode;
  $("score-home-name").textContent = matchup.homeName;
  $("score-home-code").textContent = matchup.homeCode;
  $("scoreboard-subtitle").textContent = `Week ${matchup.weekIndex + 1} • Regular Season`;
  $("scoreboard-meta-line").textContent = `Kickoff: ${formatIso(matchup.kickoffIso)}`;
  $("game-status-label").textContent = "Awaiting simulation";
  $("game-clock-label").textContent = "Kickoff pending";
}

function renderSimResults(result, matchup) {
  const { finalScore, quarters } = result;

  // Fill scoreboard
  const away = matchup.awayCode;
  const home = matchup.homeCode;
  const qLabels = ["q1", "q2", "q3", "q4", "ot"];
  for (let i = 0; i < 4; i++) {
    $(`score-away-${qLabels[i]}`).textContent = quarters[i]?.[0] ?? 0;
    $(`score-home-${qLabels[i]}`).textContent = quarters[i]?.[1] ?? 0;
  }
  $("score-away-ot").textContent = 0;
  $("score-home-ot").textContent = 0;
  $("score-away-total").textContent = finalScore[away];
  $("score-home-total").textContent = finalScore[home];
  $("game-status-label").textContent = "Final";
  $("game-clock-label").textContent = "Game completed";

  // Scoring summary
  const summaryList = $("scoring-summary-list");
  summaryList.innerHTML = "";
  result.scoring.forEach((s) => {
    const li = document.createElement("li");
    li.className = "scoring-summary-item";
    li.innerHTML = `
      <div class="scoring-summary-left">
        <div><strong>${s.team}</strong> – ${s.desc}</div>
        <div class="scoring-summary-drive">Q${s.quarter}</div>
      </div>
      <div class="scoring-summary-points">+${s.points}</div>
    `;
    summaryList.appendChild(li);
  });

  // Drive log
  const driveList = $("drive-log-list");
  driveList.innerHTML = "";
  result.drives.forEach((d) => {
    const li = document.createElement("li");
    li.className = "drive-log-entry";
    li.innerHTML = `
      <div>${d.summary}</div>
      <div class="drive-log-meta">Q${d.quarter}</div>
    `;
    driveList.appendChild(li);
  });

  // Team stats
  const statsBody = $("team-stats-body");
  statsBody.innerHTML = "";
  const statKeys = ["totalYards", "passYards", "rushYards", "turnovers", "timeOfPoss"];
  const statLabels = {
    totalYards: "Total Yards",
    passYards: "Pass Yards",
    rushYards: "Rush Yards",
    turnovers: "Turnovers",
    timeOfPoss: "Time of Possession"
  };
  statKeys.forEach((key) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${statLabels[key]}</td>
      <td class="value-cell">${result.teamStats[home][key]}</td>
      <td class="value-cell">${result.teamStats[away][key]}</td>
    `;
    statsBody.appendChild(tr);
  });

  // Top performers
  const homePerfList = $("home-top-performers");
  const awayPerfList = $("away-top-performers");
  homePerfList.innerHTML = "";
  awayPerfList.innerHTML = "";

  result.topPerformers[home].forEach((p) => {
    const li = document.createElement("li");
    li.className = "performer-item";
    li.innerHTML = `<strong>${p.name}</strong> <span class="performer-role">${p.role}</span><br>${p.line}`;
    homePerfList.appendChild(li);
  });

  result.topPerformers[away].forEach((p) => {
    const li = document.createElement("li");
    li.className = "performer-item";
    li.innerHTML = `<strong>${p.name}</strong> <span class="performer-role">${p.role}</span><br>${p.line}`;
    awayPerfList.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Simulation Flow
// ---------------------------------------------------------------------------

async function handleSimGame(save, leagueState, matchup) {
  $("game-status-label").textContent = "Simulating...";
  $("btn-sim-game").disabled = true;

  // Integrate your actual engine later; this is a placeholder
  const result = simulateGame(matchup.homeCode, matchup.awayCode, { save, leagueState, matchup });

  renderSimResults(result, matchup);

  // Update franchise record (simple placeholder logic)
  const homeWin = result.finalScore[matchup.homeCode] > result.finalScore[matchup.awayCode];
  if (matchup.isHome && homeWin) {
    // add win
    const [w, l] = save.record.split("-").map(Number);
    save.record = `${w + 1}-${l}`;
  } else if (!matchup.isHome && !homeWin) {
    const [w, l] = save.record.split("-").map(Number);
    save.record = `${w + 1}-${l}`;
  } else {
    const [w, l] = save.record.split("-").map(Number);
    save.record = `${w}-${l + 1}`;
  }

  // Save summary and league state updates
  save.lastPlayedISO = new Date().toISOString();
  leagueState.statsSummary = leagueState.statsSummary || {};
  leagueState.statsSummary.record = save.record;
  leagueState.timeline = leagueState.timeline || {};
  leagueState.timeline.lastGameResult = result;
  saveLeagueState(leagueState);
  localStorage.setItem(SAVE_KEY_LAST_FRANCHISE, JSON.stringify(save));

  $("btn-view-boxscore").disabled = false;
  $("btn-sim-game").disabled = true;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initGameDay() {
  const save = loadLastFranchise();
  if (!save) {
    document.getElementById("no-franchise").hidden = false;
    return;
  }

  const leagueState = loadLeagueState(save.franchiseId) || {};
  const schedule = leagueState.schedule?.byTeam?.[save.teamCode];
  if (!schedule) {
    alert("No schedule found for this team.");
    window.location.href = "schedule.html";
    return;
  }

  // Find current week’s matchup
  const game = schedule[save.weekIndex] || schedule[0];
  const matchup = {
    weekIndex: game.index,
    isHome: game.isHome,
    homeCode: game.isHome ? save.teamCode : game.opponentCode,
    awayCode: game.isHome ? game.opponentCode : save.teamCode,
    homeName: game.isHome ? save.teamName : game.opponentName || game.opponentCode,
    awayName: game.isHome ? game.opponentName || game.opponentCode : save.teamName,
    kickoffIso: game.kickoffIso
  };

  renderHeader(save, matchup);
  renderPregameInfo(matchup);

  // Bind events
  $("btn-sim-game").addEventListener("click", () => handleSimGame(save, leagueState, matchup));
  $("btn-back-hub").addEventListener("click", () => (window.location.href = "franchise.html"));
  $("btn-back-schedule").addEventListener("click", () => (window.location.href = "schedule.html"));
  $("btn-header-back-hub").addEventListener("click", () => (window.location.href = "franchise.html"));
  $("btn-header-back-schedule").addEventListener("click", () => (window.location.href = "schedule.html"));
  $("btn-view-boxscore").addEventListener("click", () => alert("Detailed box score view coming soon."));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGameDay);
} else {
  initGameDay();
}
