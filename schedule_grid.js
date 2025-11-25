// schedule_grid.js
// -----------------------------------------------------------------------------
// Builds an 18-week × 32-team schedule grid table.
// -----------------------------------------------------------------------------

import { ensureAllTeamSchedules, getAllTeamCodes, getTeamDisplayName } from "./league_schedule.js";

const leagueState = {};
const seasonYear = 2025;

// Build or load the full league schedule
const schedule = ensureAllTeamSchedules(leagueState, seasonYear);

const container = document.getElementById("gridContainer");

// Construct table
const table = document.createElement("table");
const thead = document.createElement("thead");
const headerRow = document.createElement("tr");

const teamHeader = document.createElement("th");
teamHeader.textContent = "TEAM";
headerRow.appendChild(teamHeader);

// Week headers 1–18
for (let w = 1; w <= 18; w++) {
  const th = document.createElement("th");
  th.textContent = w;
  headerRow.appendChild(th);
}
thead.appendChild(headerRow);
table.appendChild(thead);

const tbody = document.createElement("tbody");
const teamCodes = getAllTeamCodes();

// Build a map for quick lookup of week → game
function getWeekGame(team, week) {
  const games = schedule.byTeam[team];
  return games.find(g => g.seasonWeek === week);
}

for (const team of teamCodes) {
  const tr = document.createElement("tr");

  const th = document.createElement("th");
  th.textContent = team;
  tr.appendChild(th);

  for (let w = 1; w <= 18; w++) {
    const td = document.createElement("td");
    const g = getWeekGame(team, w);

    if (!g) {
      td.textContent = "";
    } else if (g.type === "bye") {
      td.textContent = "BYE";
      td.classList.add("bye");
    } else if (g.isHome) {
        td.textContent = getTeamDisplayName(g.opponentCode).split(" ").pop();
      td.classList.add("home");
    } else {
        td.textContent = "@" + getTeamDisplayName(g.opponentCode).split(" ").pop();
      td.classList.add("away");
    }

    tr.appendChild(td);
  }

  tbody.appendChild(tr);
}

table.appendChild(tbody);
container.appendChild(table);
