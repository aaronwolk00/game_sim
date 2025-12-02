// franchise.js
//
// Franchise GM – Franchise Hub (GM Dashboard)
//
// Responsibilities:
// - Load current FranchiseSave summary from localStorage.
// - Load or create a LeagueState object per franchise.
// - Render:
//   * Header (team + season/phase/week + record).
//   * Next Major Event card (Game Day -> schedule.html).
//   * Key Alerts card.
//   * Season Summary card.
//   * Owner & Expectations card.
//   * Developer Debug card.
// - Wire shortcuts and the Advance-to-event modal.
//
// This file is self-contained; it shares storage keys with schedule.js
// but does not depend on schedule.js being loaded.

// ---------------------------------------------------------------------------
// Types (JSDoc – documentation only)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} [teamName]
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {number} weekIndex
 * @property {string} phase
 * @property {string} record
 * @property {string} lastPlayedISO
 *
 * @property {Object} accolades
 * @property {Object} gmJob
 * @property {Object} leagueSummary
 * @property {Object} realismOptions
 * @property {Object} ownerExpectation
 * @property {number} gmCredibility
 */

/**
 * @typedef {Object} AlertItem
 * @property {string} id
 * @property {string} type          // "injury" | "contract" | "morale" | "deadline" | "trade_rumor" | etc
 * @property {string} createdIso
 * @property {string} title
 * @property {string} body
 * @property {"high"|"medium"|"low"} severity
 * @property {string} [relatedPlayerId]
 * @property {string} [relatedTeamCode]
 */

/**
 * @typedef {Object} OwnerNote
 * @property {string} id
 * @property {string} createdIso
 * @property {"system"|"user"} source
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
 * @property {AlertItem[]} alerts.items
 *
 * @property {Object} statsSummary
 * @property {string} statsSummary.record
 * @property {number} statsSummary.pointsFor
 * @property {number} statsSummary.pointsAgainst
 * @property {string[]} statsSummary.lastFive
 * @property {number|null} statsSummary.offenseRankPointsPerGame
 * @property {number|null} statsSummary.defenseRankPointsPerGame
 *
 * @property {OwnerNote[]} ownerNotes
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
    return parsed;
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
 * Create a default LeagueState when none exists.
 * This infers a reasonable nextEvent and neutral stats.
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

  // Regular season with a defined week -> treat the upcoming game as next event.
  if (typeof phase === "string" && phase.includes("Regular Season") && rawWeekIndex !== null) {
    const upcomingWeekIndex = rawWeekIndex; // assume this is the upcoming game index
    const isHome = (save.teamCode || "").length % 2 === 0; // arbitrary but stable per team
    const opponentName =
      upcomingWeekIndex % 3 === 0
        ? "Division Rival"
        : upcomingWeekIndex % 3 === 1
        ? "Conference Opponent"
        : "Non-Conference Opponent";

    const kickoff = new Date();
    kickoff.setDate(kickoff.getDate() + 3);
    kickoff.setHours(16, 25, 0, 0); // 4:25 PM

    nextEvent = {
      type: "game",
      label: `Week ${upcomingWeekIndex + 1} vs ${opponentName}`,
      phase: "Regular Season",
      weekIndex: upcomingWeekIndex,
      isHome,
      opponentName,
      kickoffIso: kickoff.toISOString()
    };
  } else if (typeof phase === "string" && phase.toLowerCase().includes("offseason")) {
    // Simple offseason assumption: draft is next major event.
    const draftDate = new Date(seasonYear, 3, 25, 20, 0, 0, 0); // late April 8 PM
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
    // Generic fallback front-office event.
    const generic = new Date();
    generic.setDate(generic.getDate() + 7);
    nextEvent = {
      type: "owner_meeting",
      label: "Next scheduled front-office event",
      phase: phase || "Unknown phase",
      weekIndex: null,
      isHome: null,
      opponentName: null,
      kickoffIso: generic.toISOString()
    };
  }

  const statsRecord =
    save.record && typeof save.record === "string" && save.record.trim()
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

/**
 * Ensure a loaded leagueState has baseline structures; patch missing
 * fields from a default template if necessary.
 *
 * @param {LeagueState|null} leagueState
 * @param {FranchiseSave} save
 * @returns {LeagueState}
 */
function normalizeLeagueState(leagueState, save) {
  if (!leagueState || typeof leagueState !== "object") {
    return createDefaultLeagueStateFromSummary(save);
  }
  const template = createDefaultLeagueStateFromSummary(save);

  if (!leagueState.timeline || !leagueState.timeline.nextEvent) {
    leagueState.timeline = template.timeline;
  }
  if (!leagueState.alerts || !Array.isArray(leagueState.alerts.items)) {
    leagueState.alerts = template.alerts;
  }
  if (!leagueState.statsSummary) {
    leagueState.statsSummary = template.statsSummary;
  }
  if (!Array.isArray(leagueState.ownerNotes)) {
    leagueState.ownerNotes = template.ownerNotes;
  }
  if (!leagueState.debug) {
    leagueState.debug = template.debug;
  } else if (typeof leagueState.debug.gmCredibility !== "number") {
    leagueState.debug.gmCredibility = template.debug.gmCredibility;
  }

  // Always ensure seasonYear/franchiseId are aligned with save
  leagueState.franchiseId = save.franchiseId;
  leagueState.seasonYear = save.seasonYear;

  return leagueState;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function getEl(id) {
  return document.getElementById(id);
}

function formatWeekFromIndex(weekIndex) {
  if (weekIndex === null || weekIndex === undefined) return null;
  const n = Number(weekIndex);
  if (!Number.isFinite(n)) return null;
  return `Week ${n + 1}`;
}

function formatHeaderSubline(save) {
  const year = save.seasonYear;
  const seasonText = year ? `Season ${year}` : "Season";
  const phaseText = save.phase || "";
  const weekLabel = formatWeekFromIndex(save.weekIndex);

  if (phaseText && weekLabel) {
    return `${seasonText} • ${phaseText} • ${weekLabel}`;
  }
  if (phaseText) {
    return `${seasonText} • ${phaseText}`;
  }
  return seasonText;
}

function formatIsoToNice(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

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

function getTeamDisplayNameFromSave(save) {
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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

/** @type {FranchiseSave|null} */
let currentFranchiseSave = null;
/** @type {LeagueState|null} */
let currentLeagueState = null;
/** @type {boolean} */
let advanceModalOpen = false;

// ---------------------------------------------------------------------------
// Rendering – header
// ---------------------------------------------------------------------------

function renderHeader(save) {
  const teamNameEl = getEl("team-name-heading");
  const seasonLineEl = getEl("season-phase-line");
  const recordValueEl = getEl("record-pill-value");

  if (teamNameEl) {
    teamNameEl.textContent = getTeamDisplayNameFromSave(save);
  }

  if (seasonLineEl) {
    seasonLineEl.textContent = formatHeaderSubline(save);
  }

  const record = (save.record && save.record.trim()) || "0-0";
  if (recordValueEl) {
    recordValueEl.textContent = record;
  }
}

// ---------------------------------------------------------------------------
// Rendering – Next Major Event card
// ---------------------------------------------------------------------------

function renderNextEventCard(save, leagueState) {
  const titleEl = getEl("card-next-event-title");
  const sublineEl = getEl("next-event-subline");
  const headlineEl = getEl("next-event-headline");
  const detailEl = getEl("next-event-detail");
  const primaryBtn = getEl("btn-next-event-primary");
  const fullScheduleBtn = getEl("btn-view-schedule");
  const inlineNoteEl = getEl("next-event-inline-note");

  const nextEvent = leagueState.timeline?.nextEvent || null;

  if (!nextEvent) {
    if (titleEl) titleEl.textContent = "Next Major Event";
    if (sublineEl) sublineEl.textContent = "Timeline";
    if (headlineEl) headlineEl.textContent = "No event scheduled";
    if (detailEl) detailEl.textContent = "The schedule engine will populate this soon.";
    if (primaryBtn) {
      primaryBtn.textContent = "Game Day";
      primaryBtn.onclick = function () {
        window.location.href = "franchise_gameday.html";
      };
    }
    if (fullScheduleBtn) {
      fullScheduleBtn.onclick = function () {
        window.location.href = "schedule.html";
      };
    }
    if (inlineNoteEl) inlineNoteEl.textContent = "";
    return;
  }

  const isGame = nextEvent.type === "game";

  if (isGame) {
    // --- Game mode: wire Game Day -> schedule.html -------------------------
    if (titleEl) titleEl.textContent = "Next Game";

    const weekLabel = formatWeekFromIndex(nextEvent.weekIndex);
    const phase = nextEvent.phase || "Regular Season";
    if (sublineEl) {
      sublineEl.textContent = weekLabel ? `${phase} • ${weekLabel}` : phase;
    }

    const opponent = nextEvent.opponentName || "TBD Opponent";
    let matchupText;
    if (nextEvent.isHome === true) {
      matchupText = `vs ${opponent}`;
    } else if (nextEvent.isHome === false) {
      matchupText = `at ${opponent}`;
    } else {
      matchupText = opponent;
    }
    if (headlineEl) {
      headlineEl.textContent = matchupText;
    }

    const niceTime = formatIsoToNice(nextEvent.kickoffIso);
    if (detailEl) {
      detailEl.textContent = niceTime
        ? `Kickoff: ${niceTime}`
        : "Kickoff time TBA";
    }

    if (primaryBtn) {
      // Build schedule link; include week query for future use.
      let url = "schedule.html";
      if (typeof nextEvent.weekIndex === "number") {
        const params = new URLSearchParams();
        params.set("view", "my-team");
        params.set("week", String(nextEvent.weekIndex));
        url = `schedule.html?${params.toString()}`;
      }
      primaryBtn.textContent = "Game Day";
      primaryBtn.disabled = false;
      primaryBtn.onclick = function () {
        window.location.href = url;
      };
    }

    if (fullScheduleBtn) {
      fullScheduleBtn.onclick = function () {
        window.location.href = "schedule.html";
      };
    }

    if (inlineNoteEl) inlineNoteEl.textContent = "";
  } else {
    // --- Non-game event (draft, FA, camp, owner meeting…) ------------------
    if (titleEl) titleEl.textContent = "Next Major Event";

    if (sublineEl) {
      sublineEl.textContent = nextEvent.phase || "Timeline";
    }

    if (headlineEl) {
      headlineEl.textContent =
        nextEvent.label || "Upcoming front-office event";
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

    if (fullScheduleBtn) {
      fullScheduleBtn.onclick = function () {
        window.location.href = "schedule.html";
      };
    }

    if (inlineNoteEl) {
      inlineNoteEl.textContent = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering – Alerts card
// ---------------------------------------------------------------------------

function renderAlertsCard(leagueState) {
  const container = getEl("alerts-content");
  const viewAllBtn = getEl("btn-view-all-alerts");

  if (!container) return;

  const items = (leagueState.alerts && leagueState.alerts.items) || [];

  container.innerHTML = "";

  if (!items.length) {
    const p = document.createElement("div");
    p.className = "alert-body";
    p.textContent = "No urgent alerts at this time.";
    container.appendChild(p);
  } else {
    const sorted = items.slice().sort((a, b) => {
      const sDiff =
        alertSeverityRank(b.severity) - alertSeverityRank(a.severity);
      if (sDiff !== 0) return sDiff;
      const tA = new Date(a.createdIso).getTime();
      const tB = new Date(b.createdIso).getTime();
      return tB - tA;
    });
    const top = sorted[0];

    const tag = document.createElement("div");
    tag.className = "alert-tag";
    const dot = document.createElement("span");
    dot.className = "alert-tag-dot";
    tag.appendChild(dot);

    const label = document.createElement("span");
    const typeText = alertTypeLabel(top.type);
    const severityText =
      top.severity === "high"
        ? "High"
        : top.severity === "medium"
        ? "Medium"
        : "Low";
    label.textContent = `${typeText} • ${severityText} priority`;
    tag.appendChild(label);

    if (top.severity === "high") tag.classList.add("alert-tag--high");
    else if (top.severity === "medium") tag.classList.add("alert-tag--medium");

    const title = document.createElement("div");
    title.className = "alert-title";
    title.textContent = truncateText(top.title, 80);

    const body = document.createElement("div");
    body.className = "alert-body";
    const bodyText = top.body ? truncateText(top.body, 140) : "";
    body.textContent = bodyText;

    container.appendChild(tag);
    container.appendChild(title);
    if (bodyText) {
      container.appendChild(body);
    }
  }

  if (viewAllBtn) {
    viewAllBtn.onclick = function () {
      // Placeholder for a future alerts center.
      window.location.href = "alerts.html";
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering – Season Summary
// ---------------------------------------------------------------------------

function renderSeasonSummaryCard(save, leagueState) {
  const sublineEl = getEl("season-summary-subline");
  const recordEl = getEl("season-summary-record");
  const pfpaEl = getEl("season-summary-pfpa");
  const lastRowEl = getEl("recent-form-row");
  const offenseChip = getEl("chip-offense-rank");
  const defenseChip = getEl("chip-defense-rank");
  const offValEl = getEl("offense-rank-value");
  const defValEl = getEl("defense-rank-value");

  const stats = leagueState.statsSummary || {
    record: save.record || "0-0",
    pointsFor: 0,
    pointsAgainst: 0,
    lastFive: [],
    offenseRankPointsPerGame: null,
    defenseRankPointsPerGame: null
  };

  if (sublineEl) {
    sublineEl.textContent = `Season ${save.seasonYear || ""}`;
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
    pfpaEl.textContent = `PF: ${pf} • PA: ${pa} • ${formatPointDiff(pf, pa)}`;
  }

  if (lastRowEl) {
    lastRowEl.innerHTML = "";
    const lastFive = Array.isArray(stats.lastFive) ? stats.lastFive.slice(-5) : [];
    if (!lastFive.length) {
      const span = document.createElement("span");
      span.textContent = "No games played yet.";
      span.style.color = "var(--muted)";
      span.style.fontSize = "0.78rem";
      lastRowEl.appendChild(span);
    } else {
      lastFive.forEach((result) => {
        const chip = document.createElement("span");
        chip.className = "result-chip";
        if (result === "W") chip.classList.add("result-chip--w");
        if (result === "L") chip.classList.add("result-chip--l");
        chip.textContent = result;
        lastRowEl.appendChild(chip);
      });
    }
  }

  const teamCode = encodeURIComponent(save.teamCode || "");

  const offRank = stats.offenseRankPointsPerGame;
  const defRank = stats.defenseRankPointsPerGame;

  if (offValEl) {
    offValEl.textContent = Number.isFinite(offRank) ? String(offRank) : "—";
  }
  if (defValEl) {
    defValEl.textContent = Number.isFinite(defRank) ? String(defRank) : "—";
  }

  if (offenseChip) {
    offenseChip.classList.toggle(
      "stat-chip--disabled",
      !Number.isFinite(offRank)
    );
    offenseChip.onclick = function () {
      window.location.href = "stats.html?view=team&team=" + teamCode;
    };
  }

  if (defenseChip) {
    defenseChip.classList.toggle(
      "stat-chip--disabled",
      !Number.isFinite(defRank)
    );
    defenseChip.onclick = function () {
      window.location.href = "stats.html?view=team&team=" + teamCode;
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering – Owner & Expectations
// ---------------------------------------------------------------------------

function renderOwnerCard(save, leagueState) {
  const line1El = getEl("owner-line-1");
  const line2El = getEl("owner-line-2");
  const meetOwnerBtn = getEl("btn-meet-owner");
  const toggleBtn = getEl("btn-toggle-owner-notes");
  const notesListEl = getEl("owner-notes-list");
  const addNoteBtn = getEl("btn-add-owner-note");

  const patience = save.ownerExpectation?.patience || "average";
  const targetYear =
    save.ownerExpectation?.targetYear || (save.seasonYear || 0) + 2;
  const baselineWins = save.ownerExpectation?.baselineWins || 9;

  if (line1El) {
    line1El.textContent = `Patience: ${patience} • Target: ${targetYear}`;
  }

  if (line2El) {
    line2El.textContent = `Baseline goal: ${baselineWins} wins by ${targetYear}`;
  }

  if (meetOwnerBtn) {
    meetOwnerBtn.onclick = function () {
      window.location.href = "owner.html";
    };
  }

  function renderNotes() {
    if (!notesListEl) return;
    notesListEl.innerHTML = "";

    const notes = Array.isArray(leagueState.ownerNotes)
      ? leagueState.ownerNotes
      : [];

    if (!notes.length) {
      const li = document.createElement("li");
      li.className = "owner-note-item";
      li.textContent = "No notes recorded yet.";
      notesListEl.appendChild(li);
      return;
    }

    notes
      .slice()
      .sort((a, b) => new Date(b.createdIso) - new Date(a.createdIso))
      .forEach((note) => {
        const li = document.createElement("li");
        li.className = "owner-note-item";

        const dateDiv = document.createElement("div");
        dateDiv.className = "owner-note-date";
        dateDiv.textContent = formatNoteTimestamp(note.createdIso);

        const textDiv = document.createElement("div");
        textDiv.textContent = note.text;

        li.appendChild(dateDiv);
        li.appendChild(textDiv);
        notesListEl.appendChild(li);
      });
  }

  if (toggleBtn && notesListEl) {
    toggleBtn.onclick = function () {
      const expanded =
        toggleBtn.getAttribute("aria-expanded") === "true" ? true : false;
      const newExpanded = !expanded;
      toggleBtn.setAttribute("aria-expanded", String(newExpanded));
      const labelSpan = toggleBtn.querySelector("span");
      if (labelSpan) {
        labelSpan.textContent = newExpanded ? "Hide notes" : "View notes";
      }
      notesListEl.hidden = !newExpanded;
      if (newExpanded) {
        renderNotes();
      }
    };
  }

  if (addNoteBtn) {
    addNoteBtn.onclick = function () {
      // Placeholder; user-authored notes can be layered in later.
      window.alert("Owner notes editing is not implemented yet.");
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering – Developer Debug
// ---------------------------------------------------------------------------

function renderDebugCard(save, leagueState) {
  const listEl = getEl("debug-summary-list");
  const toggleBtn = getEl("btn-toggle-raw-state");
  const rawEl = getEl("debug-raw-state");

  if (listEl) {
    listEl.innerHTML = "";

    const entries = [
      ["Franchise ID", save.franchiseId || "—"],
      ["Season", save.seasonYear ?? "—"],
      ["Phase", save.phase || "—"],
      [
        "Week index",
        typeof save.weekIndex === "number" ? String(save.weekIndex) : "—"
      ],
      [
        "GM credibility",
        typeof save.gmCredibility === "number"
          ? String(save.gmCredibility)
          : String(leagueState.debug?.gmCredibility ?? "—")
      ]
    ];

    entries.forEach(([label, value]) => {
      const div = document.createElement("div");
      div.textContent = `${label}: ${value}`;
      listEl.appendChild(div);
    });
  }

  if (rawEl) {
    try {
      rawEl.textContent = JSON.stringify(leagueState, null, 2);
    } catch {
      rawEl.textContent = "// Failed to stringify league state";
    }
  }

  if (toggleBtn && rawEl) {
    toggleBtn.onclick = function () {
      const hidden = rawEl.hidden;
      rawEl.hidden = !hidden;
      toggleBtn.textContent = hidden
        ? "Hide raw league state"
        : "Show raw league state";
    };
  }
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

function bindShortcutButtons() {
  const teamBtn = getEl("shortcut-team");
  const standingsBtn = getEl("shortcut-standings");
  const statsBtn = getEl("shortcut-stats");
  const contractsBtn = getEl("shortcut-contracts");
  const scoutingBtn = getEl("shortcut-scouting");

  if (teamBtn) {
    teamBtn.onclick = function () {
      window.location.href = "team_view.html";
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

function openAdvanceModal() {
  const modal = getEl("advance-modal");
  if (!modal) return;
  modal.hidden = false;
  advanceModalOpen = true;

  const confirmBtn = getEl("btn-modal-confirm");
  if (confirmBtn) {
    confirmBtn.focus();
  }
}

function closeAdvanceModal() {
  const modal = getEl("advance-modal");
  if (!modal) return;
  modal.hidden = true;
  advanceModalOpen = false;
}

function bindModalHandlers() {
  const cancelBtn = getEl("btn-modal-cancel");
  const confirmBtn = getEl("btn-modal-confirm");

  if (cancelBtn) {
    cancelBtn.onclick = function () {
      closeAdvanceModal();
    };
  }

  if (confirmBtn) {
    confirmBtn.onclick = function () {
      // Placeholder – future: simulate up to nextEvent, update save + leagueState.
      console.log("Advance to event: not implemented yet.");
      const noteEl = getEl("next-event-inline-note");
      if (noteEl) {
        noteEl.textContent =
          "Auto-advance simulation is not implemented yet.";
      }
      closeAdvanceModal();
    };
  }

  // ESC to close modal
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && advanceModalOpen) {
      e.preventDefault();
      closeAdvanceModal();
    }
  });
}

// ---------------------------------------------------------------------------
// No-franchise fallback
// ---------------------------------------------------------------------------

function renderNoFranchiseState() {
  const hubMain = getEl("hub-main");
  const header = document.querySelector("header.hub-header");
  const noFranchiseSection = getEl("no-franchise");

  if (hubMain) hubMain.style.display = "none";
  if (header) header.style.display = "none";
  if (noFranchiseSection) {
    noFranchiseSection.hidden = false;
  }

  const backBtn = getEl("btn-go-main-menu");
  if (backBtn) {
    backBtn.onclick = function () {
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
  leagueState = normalizeLeagueState(leagueState, save);
  saveLeagueState(leagueState);

  currentFranchiseSave = save;
  currentLeagueState = leagueState;

  renderHeader(save);
  renderNextEventCard(save, leagueState); // Game Day -> schedule.html here
  renderAlertsCard(leagueState);
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