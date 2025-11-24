// standings.js
// -----------------------------------------------------------------------------
// Franchise GM – Standings & Playoff Picture
//
// Read-only view that derives league standings and a simple playoff picture
// from LeagueState.schedule and TEAM_META / divisions.
// -----------------------------------------------------------------------------

import {
    TEAM_META,
    DIVISION_NAMES,
    getTeamMeta,
    getTeamDisplayName,
    ensureAllTeamSchedules,
    recomputeRecordFromSchedule
  } from "./league_schedule.js";
  
  // -----------------------------------------------------------------------------
  // Types (JSDoc – documentation only)
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
  
  /**
   * @typedef {Object} LeagueState
   * @property {string} franchiseId
   * @property {number} seasonYear
   * @property {Object} [statsSummary]
   * @property {number} [statsSummary.currentWeekIndex]
   * @property {LeagueSchedule} [schedule]
   */
  
  /**
   * @typedef {Object} StandingRow
   * @property {string} teamCode
   * @property {string} displayName
   * @property {string} conference
   * @property {string} division
   * @property {number} wins
   * @property {number} losses
   * @property {number} ties
   * @property {number} gamesPlayed
   * @property {number} winPct
   * @property {string} pctString
   * @property {string} recordStr
   * @property {number} pointsFor
   * @property {number} pointsAgainst
   * @property {number} pointDiff
   * @property {number} divisionWins
   * @property {number} divisionLosses
   * @property {number} divisionTies
   * @property {number} conferenceWins
   * @property {number} conferenceLosses
   * @property {number} conferenceTies
   * @property {string[]} lastFiveArray
   * @property {string} lastFiveString
   * @property {string} streak
   */
  
  /**
   * @typedef {Object} PlayoffPicture
   * @property {Array<StandingRow & { seed: number }>} seeds
   * @property {StandingRow[]} inTheHunt
   */
  
  // -----------------------------------------------------------------------------
  // Storage keys & helpers
  // -----------------------------------------------------------------------------
  
  const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
  const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";
  
  function getLeagueStateKey(franchiseId) {
    return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
  }
  
  function storageAvailable() {
    try {
      const testKey = "__franchise_standings_storage_test__";
      window.localStorage.setItem(testKey, "1");
      window.localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * @returns {any|null}
   */
  function loadLastFranchise() {
    if (!storageAvailable()) return null;
    const raw = window.localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  
  /**
   * @param {any} save
   */
  function saveLastFranchise(save) {
    if (!storageAvailable() || !save) return;
    try {
      window.localStorage.setItem(SAVE_KEY_LAST_FRANCHISE, JSON.stringify(save));
    } catch (err) {
      console.warn("[Standings] Failed to save franchise:", err);
    }
  }
  
  /**
   * @param {string} franchiseId
   * @returns {LeagueState|null}
   */
  function loadLeagueState(franchiseId) {
    if (!storageAvailable() || !franchiseId) return /** @type {any} */ (null);
    const raw = window.localStorage.getItem(getLeagueStateKey(franchiseId));
    if (!raw) return /** @type {any} */ (null);
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return /** @type {any} */ (null);
    }
  }
  
  /**
   * @param {LeagueState} state
   */
  function saveLeagueState(state) {
    if (!storageAvailable() || !state || !state.franchiseId) return;
    try {
      window.localStorage.setItem(
        getLeagueStateKey(state.franchiseId),
        JSON.stringify(state)
      );
    } catch (err) {
      console.warn("[Standings] Failed to save league state:", err);
    }
  }
  
  // -----------------------------------------------------------------------------
  // Utility helpers
  // -----------------------------------------------------------------------------
  
  function safeNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  
  /**
   * Format record as "W-L" or "W-L-T".
   */
  function formatRecord(wins, losses, ties) {
    const w = safeNumber(wins, 0);
    const l = safeNumber(losses, 0);
    const t = safeNumber(ties, 0);
    if (t > 0) return `${w}-${l}-${t}`;
    return `${w}-${l}`;
  }
  
  /**
   * Given chronological results array of "W"/"L"/"T", compute lastFive + streak.
   * @param {string[]} resultsChronological
   */
  function computeLastFiveAndStreak(resultsChronological) {
    const len = resultsChronological.length;
    const lastFiveArray =
      len <= 5
        ? resultsChronological.slice()
        : resultsChronological.slice(len - 5);
    const lastFiveString = lastFiveArray.join("");
  
    if (!len) {
      return {
        lastFiveArray,
        lastFiveString,
        streak: ""
      };
    }
  
    const last = resultsChronological[len - 1];
    let count = 0;
    for (let i = len - 1; i >= 0; i--) {
      if (resultsChronological[i] === last) {
        count++;
      } else {
        break;
      }
    }
  
    const streak = `${last}${count}`;
    return { lastFiveArray, lastFiveString, streak };
  }
  
  /**
   * Sort comparator for standings and playoff seeding.
   * Higher winPct, then pointDiff, then pointsFor, then teamCode.
   * @param {StandingRow} a
   * @param {StandingRow} b
   */
  function standingsComparator(a, b) {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.teamCode.localeCompare(b.teamCode);
  }
  
  /**
   * Derive "Through Week X" label and whether any games are final.
   * @param {LeagueState} leagueState
   * @returns {{ weekIndex0: number|null, label: string, hasFinals: boolean }}
   */
  function deriveThroughWeek(leagueState) {
    if (!leagueState || !leagueState.schedule || !leagueState.schedule.byTeam) {
      return { weekIndex0: null, label: "Pre-Week 1", hasFinals: false };
    }
  
    const stats = leagueState.statsSummary || {};
    if (
      typeof stats.currentWeekIndex === "number" &&
      Number.isFinite(stats.currentWeekIndex)
    ) {
      const w = stats.currentWeekIndex + 1;
      return {
        weekIndex0: stats.currentWeekIndex,
        label: `Through Week ${w}`,
        hasFinals: true
      };
    }
  
    const byTeam = leagueState.schedule.byTeam;
    let maxWeek = 0;
  
    for (const games of Object.values(byTeam)) {
      if (!Array.isArray(games)) continue;
      for (const g of games) {
        if (g.status !== "final") continue;
        const w =
          typeof g.seasonWeek === "number"
            ? g.seasonWeek
            : typeof g.index === "number"
            ? g.index + 1
            : null;
        if (!w) continue;
        if (w > maxWeek) maxWeek = w;
      }
    }
  
    if (maxWeek > 0) {
      return {
        weekIndex0: maxWeek - 1,
        label: `Through Week ${maxWeek}`,
        hasFinals: true
      };
    }
  
    return { weekIndex0: null, label: "Pre-Week 1", hasFinals: false };
  }
  
  // -----------------------------------------------------------------------------
  // Standings computation
  // -----------------------------------------------------------------------------
  
  /**
   * Compute full standings map keyed by teamCode.
   * @param {LeagueState} leagueState
   * @returns {Record<string, StandingRow>}
   */
  function computeTeamStandings(leagueState) {
    const standingsMap = /** @type {Record<string, StandingRow>} */ ({});
  
    if (!leagueState || !leagueState.schedule || !leagueState.schedule.byTeam) {
      return standingsMap;
    }
  
    const schedule = leagueState.schedule;
    const byTeam = schedule.byTeam;
  
    /** @type {Record<string, { conference: string; division: string }>} */
    const metaByCode = {};
    for (const t of TEAM_META) {
      metaByCode[t.teamCode] = {
        conference: t.conference,
        division: t.division
      };
    }
  
    for (const meta of TEAM_META) {
      const teamCode = meta.teamCode;
      const conference = meta.conference;
      const division = meta.division;
      const displayName = getTeamDisplayName(teamCode);
  
      /** @type {TeamGame[]} */
      const games = Array.isArray(byTeam[teamCode]) ? byTeam[teamCode] : [];
  
      const finalGames = games
        .filter((g) => g && g.status === "final")
        .slice()
        .sort((a, b) => {
          const aIdx =
            typeof a.index === "number"
              ? a.index
              : typeof a.seasonWeek === "number"
              ? a.seasonWeek - 1
              : 0;
          const bIdx =
            typeof b.index === "number"
              ? b.index
              : typeof b.seasonWeek === "number"
              ? b.seasonWeek - 1
              : 0;
          return aIdx - bIdx;
        });
  
      let wins = 0;
      let losses = 0;
      let ties = 0;
      let pf = 0;
      let pa = 0;
  
      let divW = 0;
      let divL = 0;
      let divT = 0;
  
      let confW = 0;
      let confL = 0;
      let confT = 0;
  
      /** @type {string[]} */
      const resultsChronological = [];
  
      for (const g of finalGames) {
        const us = safeNumber(g.teamScore, NaN);
        const them = safeNumber(g.opponentScore, NaN);
        if (!Number.isFinite(us) || !Number.isFinite(them)) continue;
  
        pf += us;
        pa += them;
  
        let res = "T";
        if (us > them) {
          wins++;
          res = "W";
        } else if (them > us) {
          losses++;
          res = "L";
        } else {
          ties++;
        }
        resultsChronological.push(res);
  
        // Division record
        if (g.type === "division") {
          if (res === "W") divW++;
          else if (res === "L") divL++;
          else divT++;
        }
  
        // Conference record
        const oppMeta = metaByCode[g.opponentCode];
        if (oppMeta && oppMeta.conference === conference) {
          if (res === "W") confW++;
          else if (res === "L") confL++;
          else confT++;
        }
      }
  
      const gamesPlayed = finalGames.length;
      const winPct =
        gamesPlayed > 0 ? (wins + 0.5 * ties) / gamesPlayed : 0;
  
      const pctString = winPct.toFixed(3);
      const recordStr = formatRecord(wins, losses, ties);
      const pointDiff = pf - pa;
  
      const { lastFiveArray, lastFiveString, streak } =
        computeLastFiveAndStreak(resultsChronological);
  
      standingsMap[teamCode] = {
        teamCode,
        displayName,
        conference,
        division,
        wins,
        losses,
        ties,
        gamesPlayed,
        winPct,
        pctString,
        recordStr,
        pointsFor: pf,
        pointsAgainst: pa,
        pointDiff,
        divisionWins: divW,
        divisionLosses: divL,
        divisionTies: divT,
        conferenceWins: confW,
        conferenceLosses: confL,
        conferenceTies: confT,
        lastFiveArray,
        lastFiveString,
        streak
      };
    }
  
    return standingsMap;
  }
  
  /**
   * Group standings by conference and division.
   * @param {Record<string, StandingRow>} standingsMap
   * @returns {{ AFC: Record<string, StandingRow[]>, NFC: Record<string, StandingRow[]> }}
   */
  function groupStandingsByConferenceAndDivision(standingsMap) {
    /** @type {{ AFC: Record<string, StandingRow[]>, NFC: Record<string, StandingRow[]> }} */
    const grouped = {
      AFC: {},
      NFC: {}
    };
  
    for (const conf of ["AFC", "NFC"]) {
      for (const div of DIVISION_NAMES) {
        grouped[conf][div] = [];
      }
    }
  
    for (const row of Object.values(standingsMap)) {
      if (!row) continue;
      const conf = row.conference;
      const div = row.division;
      if (!grouped[conf]) continue;
      if (!grouped[conf][div]) {
        grouped[conf][div] = [];
      }
      grouped[conf][div].push(row);
    }
  
    for (const conf of ["AFC", "NFC"]) {
      for (const div of DIVISION_NAMES) {
        const arr = grouped[conf][div];
        if (Array.isArray(arr)) {
          arr.sort(standingsComparator);
        }
      }
    }
  
    return grouped;
  }
  
  /**
   * Compute playoff picture for one conference.
   * @param {"AFC"|"NFC"} conference
   * @param {Record<string, StandingRow[]>} confDivs
   * @returns {PlayoffPicture}
   */
  function computePlayoffPictureForConference(conference, confDivs) {
    if (!confDivs) {
      return { seeds: [], inTheHunt: [] };
    }
  
    /** @type {StandingRow[]} */
    const allTeams = [];
    /** @type {StandingRow[]} */
    const divisionWinners = [];
  
    for (const div of DIVISION_NAMES) {
      const teams = (confDivs[div] || []).slice();
      if (!teams.length) continue;
      teams.sort(standingsComparator);
      allTeams.push(...teams);
      divisionWinners.push(teams[0]);
    }
  
    // De-duplicate any strange overlaps, just in case.
    const seenWin = new Set();
    /** @type {StandingRow[]} */
    const uniqueWinners = [];
    for (const t of divisionWinners) {
      if (!seenWin.has(t.teamCode)) {
        seenWin.add(t.teamCode);
        uniqueWinners.push(t);
      }
    }
  
    uniqueWinners.sort(standingsComparator);
  
    /** @type {Array<StandingRow & { seed: number }>} */
    const seeds = [];
    const winnerCodes = new Set(uniqueWinners.map((t) => t.teamCode));
  
    uniqueWinners.forEach((t, idx) => {
      seeds.push({ ...t, seed: idx + 1 });
    });
  
    const others = allTeams.filter((t) => !winnerCodes.has(t.teamCode));
    others.sort(standingsComparator);
  
    const wildcardsToTake = Math.min(3, others.length);
    for (let i = 0; i < wildcardsToTake; i++) {
      const t = others[i];
      seeds.push({ ...t, seed: uniqueWinners.length + i + 1 });
    }
  
    const seededCodes = new Set(seeds.map((s) => s.teamCode));
    const outside = allTeams.filter((t) => !seededCodes.has(t.teamCode));
    outside.sort(standingsComparator);
  
    const inTheHunt = outside.slice(0, 4);
  
    return { seeds, inTheHunt };
  }
  
  // -----------------------------------------------------------------------------
  // DOM helpers
  // -----------------------------------------------------------------------------
  
  function getEl(id) {
    return /** @type {HTMLElement | null} */ (document.getElementById(id));
  }
  
  function setText(id, text) {
    const el = getEl(id);
    if (el) el.textContent = text;
  }
  
  /**
   * Attach click navigation from any child row with data-team-code to team_view.
   * @param {HTMLElement|null} container
   */
  function attachTeamRowNavigation(container) {
    if (!container) return;
    container.addEventListener("click", (evt) => {
      const target = /** @type {HTMLElement | null} */ (evt.target);
      if (!target) return;
      const row = target.closest("[data-team-code]");
      if (!row) return;
      const code = row.getAttribute("data-team-code");
      if (!code) return;
      const url = `team_view.html?team=${encodeURIComponent(code)}`;
      window.location.href = url;
    });
  }
  
  // -----------------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------------
  
  /**
   * @param {any} save
   * @param {LeagueState} leagueState
   * @param {string} throughWeekLabel
   */
  function renderHeader(save, leagueState, throughWeekLabel) {
    const userTeamCode = save.teamCode;
    const userName =
      save.teamName ||
      save.franchiseName ||
      getTeamDisplayName(userTeamCode || "");
  
    const seasonYear = save.seasonYear || leagueState.seasonYear || "";
    const phase = save.phase || "Regular Season";
  
    const recordFromSchedule =
      leagueState && leagueState.schedule
        ? recomputeRecordFromSchedule(leagueState, userTeamCode)
        : null;
    const recordText = recordFromSchedule || save.record || "0-0";
  
    setText("standings-header-name", userName);
    setText(
      "standings-header-subline",
      `${seasonYear || "Season —"} • ${phase} • ${throughWeekLabel}`
    );
    setText("standings-record-value", recordText);
  }
  
  /**
   * @param {{ AFC: Record<string, StandingRow[]>, NFC: Record<string, StandingRow[]> }} grouped
   * @param {string} userTeamCode
   */

    function renderDivisionStandings(grouped, userTeamCode, standingsMap) {
    const container = document.getElementById("standings-container") ||
                        document.getElementById("division-standings-container");
    if (!container) return;
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "standings-conferences";

    ["AFC", "NFC"].forEach((conf) => {
        // Pull all teams in this conference
        const rows = Object.values(standingsMap).filter(
        (r) => r && r.conference === conf
        );
        if (!rows.length) return;
        rows.sort(standingsComparator);

        const confBlock = document.createElement("section");
        confBlock.className = "standings-conf";
        confBlock.setAttribute("data-conf", conf);

        const confTitle = document.createElement("div");
        confTitle.className = "standings-conf-title";
        confTitle.textContent = `${conf} Standings`;
        confBlock.appendChild(confTitle);

        const headerRow = document.createElement("div");
        headerRow.className = "standings-header-row";
        ["Team", "Div", "Record", "Pct", "Diff"].forEach((label) => {
        const span = document.createElement("span");
        span.textContent = label;
        headerRow.appendChild(span);
        });
        confBlock.appendChild(headerRow);

        const rowsContainer = document.createElement("div");
        rowsContainer.className = "standings-rows";

        rows.forEach((row) => {
        const rowEl = createStandingsRow(row, userTeamCode);
        rowsContainer.appendChild(rowEl);
        });

        confBlock.appendChild(rowsContainer);
        wrapper.appendChild(confBlock);
    });

    container.appendChild(wrapper);
    }

  
  /**
   * @param {StandingRow} row
   * @param {string} userTeamCode
   */

    function createStandingsRow(row, userTeamCode) {
    const rowEl = document.createElement("div");
    rowEl.className = "standings-row";
    rowEl.setAttribute("data-team-code", row.teamCode);

    if (row.teamCode === userTeamCode) {
        rowEl.classList.add("standings-row--user");
    }

    const top = document.createElement("div");
    top.className = "standings-row-top";

    const teamSpan = document.createElement("span");
    teamSpan.className = "standings-team-name";
    teamSpan.textContent = row.displayName;
    top.appendChild(teamSpan);

    const divSpan = document.createElement("span");
    divSpan.className = "standings-team-div";
    divSpan.textContent = row.division;
    top.appendChild(divSpan);

    const recordSpan = document.createElement("span");
    recordSpan.textContent = row.recordStr;
    top.appendChild(recordSpan);

    const pctSpan = document.createElement("span");
    pctSpan.textContent = row.pctString;
    top.appendChild(pctSpan);

    const diffSpan = document.createElement("span");
    const diff = row.pointDiff;
    diffSpan.textContent = diff > 0 ? `+${diff}` : String(diff);
    top.appendChild(diffSpan);

    const bottom = document.createElement("div");
    bottom.className = "standings-row-bottom";

    const lastFiveSpan = document.createElement("span");
    lastFiveSpan.textContent = row.lastFiveString
        ? `Last 5: ${row.lastFiveString}`
        : "Last 5: —";
    bottom.appendChild(lastFiveSpan);

    const streakDetailSpan = document.createElement("span");
    streakDetailSpan.textContent = row.streak
        ? `Streak: ${row.streak}`
        : "Streak: —";
    bottom.appendChild(streakDetailSpan);

    rowEl.appendChild(top);
    rowEl.appendChild(bottom);

    return rowEl;
    }

  
  /**
   * @param {{ AFC: PlayoffPicture, NFC: PlayoffPicture }} playoffByConf
   * @param {string} userTeamCode
   * @param {string} throughWeekLabel
   */
  function renderPlayoffPicture(playoffByConf, userTeamCode, throughWeekLabel) {
    const container = getEl("playoff-picture-container");
    if (!container) return;
    container.innerHTML = "";
  
    const wrapper = document.createElement("div");
    wrapper.className = "playoff-conferences";
  
    ["AFC", "NFC"].forEach((conf) => {
      const picture = playoffByConf[conf];
      const confBlock = document.createElement("section");
      confBlock.className = "playoff-conf";
      confBlock.setAttribute("data-conf", conf);
  
      const title = document.createElement("div");
      title.className = "playoff-conf-title";
      title.textContent = `${conf} Seeds`;
      confBlock.appendChild(title);
  
      const seedsLabel = document.createElement("div");
      seedsLabel.className = "playoff-seeds-label";
      seedsLabel.textContent = "Seeds 1–7";
      confBlock.appendChild(seedsLabel);
  
      const seedsBox = document.createElement("div");
      seedsBox.className = "playoff-seeds";
  
      const headerRow = document.createElement("div");
      headerRow.className = "playoff-header-row";
      ["Seed", "Team", "Record", "Pct", "Diff", "Strk"].forEach((label) => {
        const span = document.createElement("span");
        span.textContent = label;
        headerRow.appendChild(span);
      });
      seedsBox.appendChild(headerRow);
  
      if (picture && picture.seeds && picture.seeds.length) {
        picture.seeds.forEach((row) => {
          const rowEl = createPlayoffRow(row, userTeamCode, true);
          seedsBox.appendChild(rowEl);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "playoff-row-bottom";
        empty.textContent = "No seeds available yet.";
        seedsBox.appendChild(empty);
      }
  
      confBlock.appendChild(seedsBox);
  
      const huntLabel = document.createElement("div");
      huntLabel.className = "playoff-hunt-label";
      huntLabel.textContent = "In the hunt";
      confBlock.appendChild(huntLabel);
  
      const huntBox = document.createElement("div");
      huntBox.className = "playoff-hunt";
  
      if (picture && picture.inTheHunt && picture.inTheHunt.length) {
        picture.inTheHunt.forEach((row) => {
          const rowEl = createPlayoffRow(row, userTeamCode, false);
          huntBox.appendChild(rowEl);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "playoff-row-bottom";
        empty.textContent = "No additional teams in the hunt yet.";
        huntBox.appendChild(empty);
      }
  
      confBlock.appendChild(huntBox);
      wrapper.appendChild(confBlock);
    });
  
    container.appendChild(wrapper);
  
    // Through-week label mirrored on right card
    setText("playoff-through-week-tag", throughWeekLabel);
  }
  
  /**
   * @param {StandingRow & { seed?: number }} row
   * @param {string} userTeamCode
   * @param {boolean} isSeed
   */

   function createPlayoffRow(row, userTeamCode, isSeed) {
    const rowEl = document.createElement("div");
    rowEl.className = "playoff-row";
    rowEl.setAttribute("data-team-code", row.teamCode);
  
    if (row.teamCode === userTeamCode) {
      rowEl.classList.add("playoff-row--user");
    }
    if (isSeed) {
      rowEl.classList.add("playoff-row--seed");
    }
  
    const top = document.createElement("div");
    top.className = "playoff-row-top";
  
    const seedSpan = document.createElement("span");
    seedSpan.textContent =
      typeof row.seed === "number" && row.seed > 0 ? String(row.seed) : "—";
    top.appendChild(seedSpan);
  
    const teamSpan = document.createElement("span");
    teamSpan.textContent = row.displayName;
    top.appendChild(teamSpan);
  
    const recordSpan = document.createElement("span");
    recordSpan.textContent = row.recordStr;
    top.appendChild(recordSpan);
  
    const pctSpan = document.createElement("span");
    pctSpan.textContent = row.pctString;
    top.appendChild(pctSpan);
  
    rowEl.appendChild(top);
    return rowEl;
  }
  
  
  // -----------------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------------
  
  function initStandings() {
    const save = loadLastFranchise();
    const mainEl = getEl("standings-main");
    const noFranchiseEl = getEl("no-franchise");
  
    if (!save) {
      if (mainEl) mainEl.style.display = "none";
      if (noFranchiseEl) noFranchiseEl.hidden = false;
  
      const backMain = getEl("btn-go-main-menu");
      if (backMain) {
        backMain.addEventListener("click", () => {
          window.location.href = "main_page.html";
        });
      }
      return;
    }
  
    let leagueState = loadLeagueState(save.franchiseId);
    if (!leagueState) {
      leagueState = {
        franchiseId: save.franchiseId,
        seasonYear: save.seasonYear
      };
    }
  
    // Ensure schedule exists for all teams.
    ensureAllTeamSchedules(leagueState, save.seasonYear);
    saveLeagueState(leagueState);
  
    const standingsMap = computeTeamStandings(leagueState);
    const grouped = groupStandingsByConferenceAndDivision(standingsMap);
  
    const playoffByConf = {
      AFC: computePlayoffPictureForConference("AFC", grouped.AFC),
      NFC: computePlayoffPictureForConference("NFC", grouped.NFC)
    };
  
    const throughWeek = deriveThroughWeek(leagueState);
    const throughLabel = throughWeek.label;
  
    renderHeader(save, leagueState, throughLabel);
    setText("standings-through-week-tag", throughLabel);
    renderDivisionStandings(grouped, save.teamCode, standingsMap);
    renderPlayoffPicture(playoffByConf, save.teamCode, throughLabel);

  
    // Hint if no final games yet.
    const hintEl = getEl("standings-hint");
    if (hintEl) {
      hintEl.textContent = throughWeek.hasFinals
        ? ""
        : "No final scores yet. All records currently show 0–0; standings and playoff picture will update as games are completed.";
    }
  
    const backBtn = getEl("btn-back-hub");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        window.location.href = "franchise.html";
      });
    }
  
    const backMain = getEl("btn-go-main-menu");
    if (backMain) {
      backMain.addEventListener("click", () => {
        window.location.href = "main_page.html";
      });
    }
  
    // Clickable rows → team_view.html?team=CODE
    attachTeamRowNavigation(getEl("division-standings-container"));
    attachTeamRowNavigation(getEl("playoff-picture-container"));
  
    // Save franchise back in case other code expects updated meta later.
    saveLastFranchise(save);
  }
  
  // -----------------------------------------------------------------------------
  // Bootstrap
  // -----------------------------------------------------------------------------
  
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initStandings);
  } else {
    initStandings();
  }
  