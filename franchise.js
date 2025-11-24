// franchise.js
//
// Franchise GM – Franchise Hub (GM Dashboard)
//
// This file drives the main GM dashboard view. It:
// - Loads the current FranchiseSave summary from localStorage.
// - Loads or creates the LeagueState object tied to that franchise.
// - Renders header + dashboard cards (Next Event, Alerts, Season Summary,
//   Owner & Expectations, Developer Debug).
// - Wires basic navigation and modal interactions.
//
// Assumptions about HTML structure:
// - Header fields:
//   - #header-team-name
//   - #header-season-line
//   - #header-record-pill
// - Cards (Next Event):
//   - #next-event-title
//   - #next-event-subline
//   - #next-event-main
//   - #next-event-detail
//   - #next-event-primary-btn
//   - #next-event-secondary-link
//   - #next-event-notice (optional, for placeholder messages)
// - Alerts card:
//   - #alerts-title
//   - #alerts-meta
//   - #alerts-body
//   - #alerts-empty
//   - #btn-view-alerts
// - Season summary card:
//   - #season-summary-season
//   - #season-summary-record
//   - #season-summary-pfpa
//   - #season-summary-diff
//   - #season-summary-last5
//   - #chip-offense-rank
//   - #chip-defense-rank
// - Owner card:
//   - #owner-baseline-line
//   - #owner-goals-line
//   - #btn-meet-owner
//   - #owner-notes-toggle
//   - #owner-notes-container
//   - #owner-notes-list
//   - #btn-add-owner-note
// - Debug card:
//   - #debug-franchise-id
//   - #debug-season
//   - #debug-phase
//   - #debug-week-index
//   - #debug-gm-credibility
//   - #btn-toggle-raw-league
//   - #debug-raw-container
//   - #debug-raw-pre
// - Advance modal:
//   - #advance-modal
//   - #advance-modal-backdrop (optional, if present)
//   - #btn-advance-cancel
//   - #btn-advance-confirm
// - Shortcuts row:
//   - #shortcut-team
//   - #shortcut-standings
//   - #shortcut-stats
//   - #shortcut-contracts
//   - #shortcut-scouting
//
// If any element is missing, the relevant renderer will fail gracefully.

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} [teamName]      // optional helper
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
 * @property {number} gmCredibility
 */

/**
 * @typedef {Object} AlertItem
 * @property {string} id
 * @property {string} type           // "injury" | "contract" | "morale" | "deadline" | "trade_rumor" | ...
 * @property {string} createdIso
 * @property {string} title
 * @property {string} body
 * @property {"high" | "medium" | "low"} severity
 * @property {string} [relatedPlayerId]
 * @property {string} [relatedTeamCode]
 */

/**
 * @typedef {Object} OwnerNote
 * @property {string} id
 * @property {string} createdIso
 * @property {"system" | "user"} source
 * @property {string} text
 */

/**
 * @typedef {Object} LeagueState
 * @property {string} franchiseId
 * @property {number} seasonYear
 *
 * @property {Object} timeline
 * @property {Object} timeline.nextEvent
 * @property {string} timeline.nextEvent.type
 * @property {string} timeline.nextEvent.label
 * @property {string} timeline.nextEvent.phase
 * @property {number|null} timeline.nextEvent.weekIndex
 * @property {boolean|null} timeline.nextEvent.isHome
 * @property {string|null} timeline.nextEvent.opponentName
 * @property {string|null} timeline.nextEvent.kickoffIso
 *
 * @property {Object} alerts
 * @property {Array<AlertItem>} alerts.items
 *
 * @property {Object} statsSummary
 * @property {string} statsSummary.record
 * @property {number} statsSummary.pointsFor
 * @property {number} statsSummary.pointsAgainst
 * @property {Array<string>} statsSummary.lastFive
 * @property {number|null} statsSummary.offenseRankPointsPerGame
 * @property {number|null} statsSummary.defenseRankPointsPerGame
 *
 * @property {Array<OwnerNote>} ownerNotes
 *
 * @property {Object} debug
 * @property {number} debug.gmCredibility
 * @property {string} [debug.lastSimIso]
 * @property {Object} [debug.internalFlags]
 */

// ---------------------------------------------------------------------------
// Constants / storage keys
// ---------------------------------------------------------------------------

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";

function getLeagueStateKey(franchiseId) {
  return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

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
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed; // assume valid v1 summary for now
  } catch {
    return null;
  }
}

function loadLeagueState(franchiseId) {
  if (!storageAvailable() || !franchiseId) return null;
  const raw = window.localStorage.getItem(getLeagueStateKey(franchiseId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveLeagueState(state) {
  if (!storageAvailable() || !state || !state.franchiseId) return;
  try {
    window.localStorage.setItem(
      getLeagueStateKey(state.franchiseId),
      JSON.stringify(state)
    );
  } catch (err) {
    console.warn("[Franchise GM] Failed to save league state:", err);
  }
}

// ---------------------------------------------------------------------------
// League state creation / defaults
// ---------------------------------------------------------------------------

/**
 * Create a default LeagueState when none exists yet for this franchise.
 * This is intentionally conservative: we set placeholders for upcoming events
 * and leave most stats neutral so the sim engine can fill them in later.
 *
 * @param {FranchiseSave} save
 * @returns {LeagueState}
 */
function createDefaultLeagueStateFromSummary(save) {
  const seasonYear = Number(save.seasonYear) || new Date().getFullYear();
  const phase = save.phase || "Offseason";
  const rawWeekIndex =
    typeof save.weekIndex === "number" && Number.isFinite(save.weekIndex)
      ? save.weekIndex
      : null;

  /** @type {LeagueState["timeline"]["nextEvent"]} */
  let nextEvent;

  // Basic heuristic: if we're in a regular season phase and have a week index,
  // show the *upcoming* game as next event. Otherwise default to an offseason
  // event appropriate to the phase.
  if (typeof phase === "string" && phase.includes("Regular Season") && rawWeekIndex !== null) {
    const upcomingWeekIndex = rawWeekIndex; // treat current index as "next" for UI
    const isHome = (save.teamCode || "").length % 2 === 0; // arbitrary but stable
    const opponentName =
      upcomingWeekIndex % 3 === 0
        ? "Division Rival"
        : upcomingWeekIndex % 3 === 1
        ? "Conference Opponent"
        : "Non-Conference Opponent";

    // Set an arbitrary kickoff time a few days from now;
    // this is placeholder until the schedule engine drives it.
    const kickoffDate = new Date();
    kickoffDate.setDate(kickoffDate.getDate() + 3);
    kickoffDate.setHours(16, 25, 0, 0); // 4:25 PM local by default

    nextEvent = {
      type: "game",
      label: `Week ${upcomingWeekIndex + 1} vs ${opponentName}`,
      phase: "Regular Season",
      weekIndex: upcomingWeekIndex,
      isHome,
      opponentName,
      kickoffIso: kickoffDate.toISOString()
    };
  } else if (typeof phase === "string" && phase.toLowerCase().includes("offseason")) {
    // Simplified offseason assumption: next big event is the draft.
    const draftDate = new Date(seasonYear, 3, 25, 20, 0, 0, 0); // late April, 8pm
    nextEvent = {
      type: "draft",
      label: `${seasonYear} Draft – Round 1`,
      phase: "Offseason",
      weekIndex: null,
      isHome: null,
      opponentName: null,
      kickoffIso: draftDate.toISOString()
    };
  } else {
    // Generic fallback
    const genericDate = new Date();
    genericDate.setDate(genericDate.getDate() + 7);
    nextEvent = {
      type: "owner_meeting",
      label: "Next scheduled front-office event",
      phase: phase || "Unknown phase",
      weekIndex: null,
      isHome: null,
      opponentName: null,
      kickoffIso: genericDate.toISOString()
    };
  }

  const statsRecord = save.record && typeof save.record === "string" && save.record.trim()
    ? save.record.trim()
    : "0-0";

  /** @type {OwnerNote} */
  const initialNote = {
    id: "note-1",
    createdIso: new Date().toISOString(),
    source: "system",
    text: `Owner expects baseline ${save.ownerExpectation?.baselineWins ?? "—"} wins by ${
      save.ownerExpectation?.targetYear ?? seasonYear + 2
    }. Patience level: ${save.ownerExpectation?.patience || "average"}.`
  };

  /** @type {LeagueState} */
  const leagueState = {
    franchiseId: save.franchiseId,
    seasonYear,
    timeline: {
      nextEvent
    },
    alerts: {
      // Start empty; sim engine will add real items later.
      items: []
    },
    statsSummary: {
      record: statsRecord,
      pointsFor: 0,
      pointsAgainst: 0,
      lastFive: [],
      offenseRankPointsPerGame: null,
      defenseRankPointsPerGame: null
    },
    ownerNotes: [initialNote],
    debug: {
      gmCredibility:
        typeof save.gmCredibility === "number" ? save.gmCredibility : 50,
      lastSimIso: null,
      internalFlags: {}
    }
  };

  return leagueState;
}

// ---------------------------------------------------------------------------
// UI helper functions
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

function formatWeekFromIndex(weekIndex) {
  if (weekIndex === null || weekIndex === undefined) return null;
  const n = Number(weekIndex);
  if (!Number.isFinite(n)) return null;
  // Assumption: weekIndex 0 => Week 1 for user-facing labels
  return `Week ${n + 1}`;
}

function formatHeaderSubline(save) {
  const seasonText = `Season ${save.seasonYear || ""}`.trim();
  const phaseText = save.phase || "";
  const weekLabel = formatWeekFromIndex(save.weekIndex);
  if (weekLabel) {
    return `${seasonText} • ${phaseText} • ${weekLabel}`;
  }
  return `${seasonText} • ${phaseText}`.replace(/\s+•\s+$/, "");
}

function formatIsoToNice(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Example: "Sun, Sep 29 • 4:25 PM"
  const dayPart = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  return `${dayPart} • ${timePart}`;
}

function getTeamDisplayName(save) {
  // In a full implementation, we'd map teamCode -> "Chicago Bears" etc,
  // but here we fall back to whatever summary provides or franchiseName.
  if (save.teamName && typeof save.teamName === "string") {
    return save.teamName;
  }
  if (save.franchiseName && typeof save.franchiseName === "string") {
    return save.franchiseName;
  }
  if (save.teamCode) {
    return save.teamCode;
  }
  return "Franchise Team";
}

function alertSeverityRank(severity) {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function alertTypeLabel(type) {
  switch (type) {
    case "injury":
      return "Injury";
    case "trade_rumor":
      return "Trade rumor";
    case "contract":
      return "Contract";
    case "morale":
      return "Morale";
    case "deadline":
      return "Deadline";
    default:
      return "Note";
  }
}

function truncateText(str, max) {
  if (!str || typeof str !== "string") return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + "…";
}

function formatPointDiff(pf, pa) {
  const diff = pf - pa;
  if (diff > 0) return `Diff: +${diff}`;
  if (diff < 0) return `Diff: ${diff}`;
  return "Diff: 0";
}

function formatNoteTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

// ---------------------------------------------------------------------------
// Global-ish current state (for this page)
// ---------------------------------------------------------------------------

/** @type {FranchiseSave | null} */
let currentFranchiseSave = null;
/** @type {LeagueState | null} */
let currentLeagueState = null;

// ---------------------------------------------------------------------------
// UI render helpers
// ---------------------------------------------------------------------------

function renderHeader(save /* , leagueState */) {
  const teamNameEl = getEl("header-team-name");
  const seasonLineEl = getEl("header-season-line");
  const recordPillEl = getEl("header-record-pill");

  if (teamNameEl) {
    teamNameEl.textContent = getTeamDisplayName(save);
  }

  if (seasonLineEl) {
    seasonLineEl.textContent = formatHeaderSubline(save);
  }

  if (recordPillEl) {
    const record = (save.record && save.record.trim()) || "0-0";
    recordPillEl.textContent = `Record: ${record}`;
  }
}

function renderNextEventCard(save, leagueState) {
  const titleEl = getEl("next-event-title");
  const sublineEl = getEl("next-event-subline");
  const mainEl = getEl("next-event-main");
  const detailEl = getEl("next-event-detail");
  const primaryBtn = getEl("next-event-primary-btn");
  const secondaryLink = getEl("next-event-secondary-link");
  const noticeEl = getEl("next-event-notice");

  const nextEvent = leagueState.timeline?.nextEvent || null;

  if (!nextEvent) {
    if (titleEl) titleEl.textContent = "Next Major Event";
    if (mainEl) mainEl.textContent = "No event scheduled.";
    if (detailEl) detailEl.textContent = "";
    if (primaryBtn) {
      primaryBtn.textContent = "Schedule";
      primaryBtn.disabled = true;
    }
    if (secondaryLink) {
      secondaryLink.textContent = "View full schedule";
      secondaryLink.href = "schedule.html";
    }
    if (noticeEl) {
      noticeEl.textContent = "";
    }
    return;
  }

  const isGame = nextEvent.type === "game";

  if (isGame) {
    if (titleEl) titleEl.textContent = "Next Game";
    const weekLabel = formatWeekFromIndex(nextEvent.weekIndex);
    const phase = nextEvent.phase || "Regular Season";
    if (sublineEl) {
      sublineEl.textContent = weekLabel
        ? `${phase} • ${weekLabel}`
        : phase;
    }

    const opponent = nextEvent.opponentName || "TBD Opponent";
    let mainText;
    if (nextEvent.isHome === true) {
      mainText = `vs ${opponent}`;
    } else if (nextEvent.isHome === false) {
      mainText = `at ${opponent}`;
    } else {
      mainText = opponent;
    }
    if (mainEl) mainEl.textContent = mainText;

    const niceTime = formatIsoToNice(nextEvent.kickoffIso);
    if (detailEl) {
      detailEl.textContent = niceTime
        ? `Kickoff: ${niceTime}`
        : "Kickoff time TBA";
    }

    if (primaryBtn) {
      primaryBtn.textContent = "Game Day";
      primaryBtn.disabled = false;
      primaryBtn.onclick = function () {
        window.location.href = "schedule.html";
      };
    }

    if (secondaryLink) {
      secondaryLink.textContent = "View full schedule";
      secondaryLink.href = "schedule.html";
    }

    if (noticeEl) noticeEl.textContent = "";
  } else {
    if (titleEl) titleEl.textContent = "Next Major Event";
    if (sublineEl) sublineEl.textContent = nextEvent.phase || "Timeline";

    if (mainEl) {
      mainEl.textContent = nextEvent.label || "Upcoming front-office event";
    }

    const niceTime = formatIsoToNice(nextEvent.kickoffIso);
    if (detailEl) {
      detailEl.textContent = niceTime ? `Date: ${niceTime}` : "Date TBA";
    }

    if (primaryBtn) {
      primaryBtn.textContent = "Advance to event";
      primaryBtn.disabled = false;
      primaryBtn.onclick = function () {
        openAdvanceModal();
      };
    }

    if (secondaryLink) {
      secondaryLink.textContent = "View full schedule";
      secondaryLink.href = "schedule.html";
    }

    if (noticeEl) {
      // Placeholder for later; kept empty by default.
      noticeEl.textContent = "";
    }
  }
}

function renderAlertsCard(save, leagueState) {
  const alertsTitleEl = getEl("alerts-title");
  const alertsMetaEl = getEl("alerts-meta");
  const alertsBodyEl = getEl("alerts-body");
  const alertsEmptyEl = getEl("alerts-empty");
  const viewAllBtn = getEl("btn-view-alerts");

  const items = (leagueState.alerts && leagueState.alerts.items) || [];

  if (!items.length) {
    if (alertsTitleEl) alertsTitleEl.textContent = "Key Alerts";
    if (alertsMetaEl) alertsMetaEl.textContent = "";
    if (alertsBodyEl) alertsBodyEl.textContent = "";
    if (alertsEmptyEl) {
      alertsEmptyEl.style.display = "block";
      alertsEmptyEl.textContent = "No urgent alerts at this time.";
    }
  } else {
    // Sort by severity then createdIso desc.
    const sorted = items.slice().sort((a, b) => {
      const sDiff =
        alertSeverityRank(b.severity) - alertSeverityRank(a.severity);
      if (sDiff !== 0) return sDiff;
      const tA = new Date(a.createdIso).getTime();
      const tB = new Date(b.createdIso).getTime();
      return tB - tA;
    });
    const top = sorted[0];

    if (alertsTitleEl) alertsTitleEl.textContent = "Key Alert";
    if (alertsMetaEl) {
      const severityLabel =
        top.severity === "high"
          ? "High priority"
          : top.severity === "medium"
          ? "Medium priority"
          : "Low priority";
      const typeLabel = alertTypeLabel(top.type);
      alertsMetaEl.textContent = `${typeLabel} • ${severityLabel}`;
    }
    if (alertsBodyEl) {
      alertsBodyEl.textContent =
        truncateText(top.title, 80) +
        (top.body ? ` — ${truncateText(top.body, 120)}` : "");
    }
    if (alertsEmptyEl) {
      alertsEmptyEl.style.display = "none";
      alertsEmptyEl.textContent = "";
    }
  }

  if (viewAllBtn) {
    viewAllBtn.onclick = function () {
      // For now, navigate to a placeholder alerts hub.
      window.location.href = "alerts.html";
    };
  }
}

function renderSeasonSummaryCard(save, leagueState) {
  const seasonEl = getEl("season-summary-season");
  const recordEl = getEl("season-summary-record");
  const pfpaEl = getEl("season-summary-pfpa");
  const diffEl = getEl("season-summary-diff");
  const last5Container = getEl("season-summary-last5");
  const offenseChip = getEl("chip-offense-rank");
  const defenseChip = getEl("chip-defense-rank");

  const stats = leagueState.statsSummary || {
    record: save.record || "0-0",
    pointsFor: 0,
    pointsAgainst: 0,
    lastFive: [],
    offenseRankPointsPerGame: null,
    defenseRankPointsPerGame: null
  };

  if (seasonEl) {
    seasonEl.textContent = `Season ${save.seasonYear}`;
  }

  const record =
    (stats.record && typeof stats.record === "string" && stats.record.trim()) ||
    (save.record && save.record.trim()) ||
    "0-0";
  if (recordEl) {
    recordEl.textContent = record;
  }

  const pf = Number(stats.pointsFor) || 0;
  const pa = Number(stats.pointsAgainst) || 0;
  if (pfpaEl) {
    pfpaEl.textContent = `PF: ${pf} • PA: ${pa}`;
  }

  if (diffEl) {
    diffEl.textContent = formatPointDiff(pf, pa);
  }

  if (last5Container) {
    last5Container.innerHTML = "";
    const list = Array.isArray(stats.lastFive) ? stats.lastFive.slice(-5) : [];
    if (!list.length) {
      const span = document.createElement("span");
      span.textContent = "No games played yet.";
      span.className = "summary-last5-empty";
      last5Container.appendChild(span);
    } else {
      list.forEach((result, idx) => {
        const chip = document.createElement("span");
        chip.className =
          "summary-last5-chip summary-last5-chip-" +
          (result === "W" ? "win" : "loss");
        chip.textContent = result;
        chip.title = `Game ${list.length - idx}: ${result === "W" ? "Win" : "Loss"}`;
        last5Container.appendChild(chip);
      });
    }
  }

  // Defensive & offensive rank chips — click to go to stats page.
  const teamCode = encodeURIComponent(save.teamCode || "");

  if (offenseChip) {
    const rank = stats.offenseRankPointsPerGame;
    offenseChip.textContent =
      "Offense: " +
      (Number.isFinite(rank) ? `${rank} in points/game` : "—");
    offenseChip.classList.toggle(
      "chip-disabled",
      !Number.isFinite(rank)
    );
    offenseChip.onclick = function () {
      window.location.href = "stats.html?view=team&team=" + teamCode;
    };
  }

  if (defenseChip) {
    const rank = stats.defenseRankPointsPerGame;
    defenseChip.textContent =
      "Defense: " +
      (Number.isFinite(rank) ? `${rank} in points/game` : "—");
    defenseChip.classList.toggle(
      "chip-disabled",
      !Number.isFinite(rank)
    );
    defenseChip.onclick = function () {
      window.location.href = "stats.html?view=team&team=" + teamCode;
    };
  }
}

function renderOwnerCard(save, leagueState) {
  const baselineLineEl = getEl("owner-baseline-line");
  const goalsLineEl = getEl("owner-goals-line");
  const meetOwnerBtn = getEl("btn-meet-owner");
  const notesToggle = getEl("owner-notes-toggle");
  const notesContainer = getEl("owner-notes-container");
  const notesList = getEl("owner-notes-list");
  const addNoteBtn = getEl("btn-add-owner-note");

  const patience = save.ownerExpectation?.patience || "average";
  const targetYear =
    save.ownerExpectation?.targetYear || (save.seasonYear || 0) + 2;
  const baselineWins = save.ownerExpectation?.baselineWins || 9;

  if (baselineLineEl) {
    baselineLineEl.textContent = `Patience: ${patience} • Target year: ${targetYear}`;
  }

  if (goalsLineEl) {
    goalsLineEl.textContent = `Baseline goal: ${baselineWins} wins by ${targetYear}`;
  }

  if (meetOwnerBtn) {
    meetOwnerBtn.onclick = function () {
      window.location.href = "owner.html";
    };
  }

  // Notes list with simple expand/collapse
  let notesExpanded = false;

  function updateNotesVisibility() {
    if (!notesContainer) return;
    notesContainer.style.display = notesExpanded ? "block" : "none";
    if (notesToggle) {
      notesToggle.textContent = notesExpanded ? "Hide notes" : "View notes";
    }
  }

  function renderNotes() {
    if (!notesList) return;
    notesList.innerHTML = "";
    const notes = Array.isArray(leagueState.ownerNotes)
      ? leagueState.ownerNotes
      : [];
    if (!notes.length) {
      const li = document.createElement("li");
      li.textContent = "No notes recorded yet.";
      notesList.appendChild(li);
      return;
    }
    notes
      .slice()
      .sort((a, b) => new Date(b.createdIso) - new Date(a.createdIso))
      .forEach((note) => {
        const li = document.createElement("li");
        li.className = "owner-note-item";
        const ts = formatNoteTimestamp(note.createdIso);
        li.textContent = `${ts} – ${note.text}`;
        notesList.appendChild(li);
      });
  }

  if (notesToggle) {
    notesToggle.onclick = function () {
      notesExpanded = !notesExpanded;
      updateNotesVisibility();
      if (notesExpanded) {
        renderNotes();
      }
    };
  }

  if (addNoteBtn) {
    addNoteBtn.onclick = function () {
      // Placeholder; future version will allow user-entered notes.
      window.alert("Owner notes editing is not implemented yet.");
    };
  }

  // Default: collapsed
  updateNotesVisibility();
}

function renderDebugCard(save, leagueState) {
  const idEl = getEl("debug-franchise-id");
  const seasonEl = getEl("debug-season");
  const phaseEl = getEl("debug-phase");
  const weekEl = getEl("debug-week-index");
  const gmCredEl = getEl("debug-gm-credibility");
  const toggleRawBtn = getEl("btn-toggle-raw-league");
  const rawContainer = getEl("debug-raw-container");
  const rawPre = getEl("debug-raw-pre");

  if (idEl) idEl.textContent = String(save.franchiseId || "—");
  if (seasonEl) seasonEl.textContent = String(save.seasonYear || "—");
  if (phaseEl) phaseEl.textContent = save.phase || "—";
  if (weekEl) {
    weekEl.textContent =
      typeof save.weekIndex === "number" ? String(save.weekIndex) : "—";
  }
  const gmCred =
    typeof save.gmCredibility === "number"
      ? save.gmCredibility
      : leagueState?.debug?.gmCredibility ?? "—";
  if (gmCredEl) gmCredEl.textContent = String(gmCred);

  if (rawPre) {
    try {
      rawPre.textContent = JSON.stringify(leagueState, null, 2);
    } catch {
      rawPre.textContent = "// Failed to stringify league state";
    }
  }

  if (rawContainer) {
    rawContainer.style.display = "none";
  }

  if (toggleRawBtn && rawContainer) {
    let showing = false;
    toggleRawBtn.onclick = function () {
      showing = !showing;
      rawContainer.style.display = showing ? "block" : "none";
      toggleRawBtn.textContent = showing
        ? "Hide raw league state"
        : "Show raw league state";
    };
  }
}

// ---------------------------------------------------------------------------
// Shortcuts row
// ---------------------------------------------------------------------------

function bindShortcutButtons() {
  const teamBtn = getEl("shortcut-team");
  const standingsBtn = getEl("shortcut-standings");
  const statsBtn = getEl("shortcut-stats");
  const contractsBtn = getEl("shortcut-contracts");
  const scoutingBtn = getEl("shortcut-scouting");

  if (teamBtn) {
    teamBtn.onclick = function () {
      window.location.href = "team.html";
    };
  }
  if (standingsBtn) {
    standingsBtn.onclick = function () {
      window.location.href = "standings.html";
    };
  }
  if (statsBtn) {
    statsBtn.onclick = function () {
      window.location.href = "stats.html";
    };
  }
  if (contractsBtn) {
    contractsBtn.onclick = function () {
      window.location.href = "contracts.html";
    };
  }
  if (scoutingBtn) {
    scoutingBtn.onclick = function () {
      window.location.href = "scouting.html";
    };
  }
}

// ---------------------------------------------------------------------------
// Advance-to-event modal
// ---------------------------------------------------------------------------

let advanceModalOpen = false;

/**
 * Show the "Advance to event" confirmation modal.
 * This is a visual placeholder; it does not mutate league state yet.
 */
function openAdvanceModal() {
  const modal = getEl("advance-modal");
  if (!modal) {
    console.warn("[Franchise GM] Advance modal not found in DOM.");
    return;
  }
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  advanceModalOpen = true;

  // Simple focus management: focus confirm button first.
  const confirmBtn = getEl("btn-advance-confirm");
  if (confirmBtn) {
    confirmBtn.focus();
  }
}

function closeAdvanceModal() {
  const modal = getEl("advance-modal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  advanceModalOpen = false;
}

/**
 * Bind handlers to modal buttons and basic ESC/Backdrop behavior.
 */
function bindModalHandlers() {
  const modal = getEl("advance-modal");
  const cancelBtn = getEl("btn-advance-cancel");
  const confirmBtn = getEl("btn-advance-confirm");
  const backdrop = getEl("advance-modal-backdrop");

  if (!modal) return;

  if (cancelBtn) {
    cancelBtn.onclick = function () {
      closeAdvanceModal();
    };
  }

  if (confirmBtn) {
    confirmBtn.onclick = function () {
      // Placeholder: actual event-advance logic will live here and will
      // drive timeline + stats updates, autosaves, etc.
      console.log("Advance to event: not implemented yet.");
      const noticeEl = getEl("next-event-notice");
      if (noticeEl) {
        noticeEl.textContent =
          "Auto-advance simulation is not implemented yet.";
      }
      closeAdvanceModal();
    };
  }

  if (backdrop) {
    backdrop.onclick = function () {
      closeAdvanceModal();
    };
  }

  // ESC key closes modal when open.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && advanceModalOpen) {
      e.preventDefault();
      closeAdvanceModal();
    }
  });
}

// ---------------------------------------------------------------------------
// No-franchise error handling
// ---------------------------------------------------------------------------

function renderNoFranchiseState() {
  // Try to reuse an existing root container if present; otherwise,
  // create a simple full-page message.
  let root = getEl("franchise-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "franchise-root";
    document.body.innerHTML = "";
    document.body.appendChild(root);
  }

  root.innerHTML = "";
  const container = document.createElement("div");
  container.className = "no-franchise-container";
  container.innerHTML = `
    <div class="no-franchise-card">
      <h1>No active franchise</h1>
      <p>No active franchise was found. Return to the main menu to start or continue a franchise.</p>
      <button type="button" class="btn-primary" id="btn-return-main">Return to main menu</button>
    </div>
  `;
  root.appendChild(container);

  const btn = getEl("btn-return-main");
  if (btn) {
    btn.onclick = function () {
      window.location.href = "main_page.html";
    };
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initFranchiseHub() {
  const save = loadLastFranchise();
  if (!save) {
    renderNoFranchiseState();
    return;
  }

  let leagueState = loadLeagueState(save.franchiseId);
  if (!leagueState) {
    leagueState = createDefaultLeagueStateFromSummary(save);
    saveLeagueState(leagueState);
  }

  currentFranchiseSave = save;
  currentLeagueState = leagueState;

  renderHeader(save, leagueState);
  renderNextEventCard(save, leagueState);
  renderAlertsCard(save, leagueState);
  renderSeasonSummaryCard(save, leagueState);
  renderOwnerCard(save, leagueState);
  renderDebugCard(save, leagueState);
  bindShortcutButtons();
  bindModalHandlers();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFranchiseHub);
} else {
  initFranchiseHub();
}
