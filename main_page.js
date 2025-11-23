// main.js
// Landing / Mode Select logic for Franchise GM.
//
// This file defines:
// - A versioned FranchiseSave shape stored under a single localStorage key.
// - Helpers for loading/saving, generating IDs, and updating last-played timestamps.
// - Stubs for autosave flows that can be called from other pages after sims/decisions.
// - UI wiring for Start / Continue / Rename / Accolades / Overwrite modal on the landing page.
//
// You can reuse the save helpers on other pages by including this script there as well
// (or by extracting them into a shared utilities file).

// -----------------------------
// Save schema & key
// -----------------------------

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version           // Save schema version (e.g., 1).
 * @property {string} franchiseId       // Unique ID for this career.
 * @property {string} franchiseName     // User-facing name (rename-able).
 * @property {string} teamCode          // Team identifier (e.g., "NYJ").
 * @property {number} seasonYear        // In-game season year (e.g., 2027).
 * @property {number} weekIndex         // Current week index (0- or 1-based, here treated as 1-based for display).
 * @property {string} record            // e.g., "5-3".
 * @property {string} phase             // e.g., "Regular Season", "Offseason".
 * @property {string} lastPlayedISO     // ISO timestamp of last update.
 * @property {Object} accolades         // Summary of career achievements.
 * @property {number} accolades.seasons
 * @property {number} accolades.playoffAppearances
 * @property {number} accolades.divisionTitles
 * @property {number} accolades.championships
 * @property {Object} gmJob             // GM contract/job state (not surfaced on landing yet).
 * @property {number} gmJob.contractYears
 * @property {number} gmJob.currentYear
 * @property {string} gmJob.status      // "stable", "warm", "hot-seat", etc.
 * @property {Object} leagueSummary     // Lightweight league summary for quick reference.
 * @property {number} leagueSummary.teams
 * @property {number} leagueSummary.seasonsSimmed
 *
 * In your real app you will also have a larger "leagueState" object elsewhere.
 * This landing file only needs this summary shape.
 */

/**
 * Single-slot save key.
 * If you ever move to multiple slots, this can become a list of saves instead.
 */
const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";

// -----------------------------
// Storage helpers
// -----------------------------

/**
 * Safely detect if localStorage is available.
 */
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

/**
 * Generate a new franchiseId string.
 * This does not need to be cryptographically secure; just unique enough for routing.
 */
function generateNewFranchiseId() {
  const timePart = Date.now().toString(36);
  const randPart = Math.random().toString(36).slice(2, 8);
  return `franchise-${timePart}-${randPart}`;
}

/**
 * Internal: build a basic default save summary.
 * You will typically construct the real save in your team select / init pipeline.
 *
 * @param {Partial<FranchiseSave>} overrides
 * @returns {FranchiseSave}
 */
function buildDefaultFranchiseSave(overrides) {
  const now = new Date().toISOString();
  const base = {
    version: 1,
    franchiseId: generateNewFranchiseId(),
    franchiseName: "Franchise",
    teamCode: "XXX",
    seasonYear: new Date().getFullYear(),
    weekIndex: 1,
    record: "0-0",
    phase: "Preseason",
    lastPlayedISO: now,
    accolades: {
      seasons: 0,
      playoffAppearances: 0,
      divisionTitles: 0,
      championships: 0
    },
    gmJob: {
      contractYears: 5,
      currentYear: 1,
      status: "stable"
    },
    leagueSummary: {
      teams: 32,
      seasonsSimmed: 0
    }
  };

  return Object.assign(base, overrides || {});
}

/**
 * Attempt to migrate a legacy save object (from an older, simpler schema)
 * to the new FranchiseSave shape. This lets existing users continue without
 * having to wipe localStorage manually.
 *
 * Expected legacy shape:
 * { teamName, seasonYear, record, lastPlayedISO }
 *
 * @param {any} legacy
 * @returns {FranchiseSave | null}
 */
function migrateLegacySave(legacy) {
  if (!legacy || typeof legacy !== "object") return null;
  if (!legacy.teamName) return null;

  const teamName = String(legacy.teamName);
  const seasonYear = typeof legacy.seasonYear === "number"
    ? legacy.seasonYear
    : new Date().getFullYear();
  const record = typeof legacy.record === "string" ? legacy.record : "0-0";
  const lastPlayedISO = typeof legacy.lastPlayedISO === "string"
    ? legacy.lastPlayedISO
    : new Date().toISOString();

  const migrated = buildDefaultFranchiseSave({
    franchiseName: teamName,
    teamCode: "XXX", // TODO: you can attempt to infer a code from teamName if desired.
    seasonYear: seasonYear,
    record: record,
    lastPlayedISO: lastPlayedISO,
    phase: "Unknown"
  });

  // Persist the migrated save so future loads use the versioned shape.
  saveLastFranchise(migrated);
  return migrated;
}

/**
 * Validate that a parsed object matches the FranchiseSave shape enough to use.
 * This is intentionally lenient; you can tighten it over time.
 *
 * @param {any} obj
 * @returns {obj is FranchiseSave}
 */
function isValidFranchiseSave(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.version !== "number") return false;
  if (typeof obj.franchiseId !== "string") return false;
  if (typeof obj.franchiseName !== "string") return false;
  if (typeof obj.teamCode !== "string") return false;
  if (typeof obj.seasonYear !== "number") return false;
  if (typeof obj.weekIndex !== "number") return false;
  if (typeof obj.record !== "string") return false;
  if (typeof obj.phase !== "string") return false;
  if (typeof obj.lastPlayedISO !== "string") return false;
  return true;
}

/**
 * Load the last franchise save from localStorage, if present.
 * Handles both current versioned saves and legacy saves.
 *
 * @returns {FranchiseSave | null}
 */
function loadLastFranchise() {
  if (!storageAvailable()) return null;

  const raw = window.localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);

    // New versioned save
    if (isValidFranchiseSave(parsed)) {
      return parsed;
    }

    // Legacy save without version field; attempt migration
    if (!parsed.version && parsed.teamName) {
      return migrateLegacySave(parsed);
    }

    return null;
  } catch (err) {
    console.warn("[Franchise GM] Could not parse saved franchise data:", err);
    return null;
  }
}

/**
 * Persist a FranchiseSave object into localStorage.
 *
 * @param {FranchiseSave} save
 */
function saveLastFranchise(save) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(SAVE_KEY_LAST_FRANCHISE, JSON.stringify(save));
  } catch (err) {
    console.warn("[Franchise GM] Failed to write franchise save:", err);
  }
}

/**
 * Return a copy of the given save with lastPlayedISO updated to "now".
 *
 * @param {FranchiseSave} save
 * @returns {FranchiseSave}
 */
function updateLastPlayed(save) {
  return Object.assign({}, save, {
    lastPlayedISO: new Date().toISOString()
  });
}

/**
 * Format a human-readable "Last played" timestamp from ISO.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatLastPlayed(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const options = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  };

  try {
    return date.toLocaleString(undefined, options);
  } catch {
    return date.toISOString();
  }
}

// -----------------------------
// Autosave stubs (for other pages)
// -----------------------------

/**
 * Called from other pages when a week sim finishes.
 * Merge a summary patch (e.g., updated record, weekIndex, phase, accolades, etc.)
 * into the existing save and update lastPlayedISO.
 *
 * Example usage (on franchise.html):
 * autosaveAfterWeek({
 *   weekIndex: 8,
 *   record: "5-3",
 *   phase: "Regular Season",
 *   accolades: { seasons: 2, playoffAppearances: 1, divisionTitles: 0, championships: 0 }
 * });
 *
 * @param {Partial<FranchiseSave>} summaryUpdate
 */
function autosaveAfterWeek(summaryUpdate) {
  let save = loadLastFranchise();
  if (!save) {
    console.warn("[Franchise GM] autosaveAfterWeek called with no existing save.");
    return;
  }

  // Merge nested objects carefully (accolades, gmJob, leagueSummary).
  const merged = mergeSaveSummary(save, summaryUpdate);
  const updated = updateLastPlayed(merged);
  saveLastFranchise(updated);
}

/**
 * Called from other pages after a major decision (signing, trade, draft pick).
 * Same pattern as autosaveAfterWeek; intended to be light-weight and frequent.
 *
 * @param {Partial<FranchiseSave>} summaryUpdate
 */
function autosaveAfterMajorDecision(summaryUpdate) {
  let save = loadLastFranchise();
  if (!save) {
    console.warn("[Franchise GM] autosaveAfterMajorDecision called with no existing save.");
    return;
  }

  const merged = mergeSaveSummary(save, summaryUpdate);
  const updated = updateLastPlayed(merged);
  saveLastFranchise(updated);
}

/**
 * Internal helper to merge a partial FranchiseSave patch into an existing save.
 * Handles nested objects (accolades, gmJob, leagueSummary) in a shallow way.
 *
 * @param {FranchiseSave} base
 * @param {Partial<FranchiseSave>} patch
 * @returns {FranchiseSave}
 */
function mergeSaveSummary(base, patch) {
  const result = Object.assign({}, base, patch || {});

  if (patch && patch.accolades) {
    result.accolades = Object.assign({}, base.accolades || {}, patch.accolades);
  }
  if (patch && patch.gmJob) {
    result.gmJob = Object.assign({}, base.gmJob || {}, patch.gmJob);
  }
  if (patch && patch.leagueSummary) {
    result.leagueSummary = Object.assign({}, base.leagueSummary || {}, patch.leagueSummary);
  }

  return result;
}

// -----------------------------
// Navigation helpers
// -----------------------------

/**
 * Navigate into the Franchise GM view.
 *
 * Currently this simply sends you to franchise.html.
 * Later you can:
 * - Use query params (e.g., ?franchiseId=...).
 * - Use a hash/router pattern.
 * - Hydrate client state before/after navigation.
 */
function navigateToFranchise() {
  window.location.href = "franchise.html";
}

/**
 * Navigate to team_select.html to start a new franchise.
 *
 * In the real app:
 * - team_select.html should allow the user to pick a team, name the franchise,
 *   and construct the initial FranchiseSave (plus full leagueState).
 * - Once created, that page should call saveLastFranchise() with the new save.
 */
function navigateToTeamSelect() {
  window.location.href = "team_select.html";
}

// -----------------------------
// UI wiring
// -----------------------------

/**
 * Update the Continue card and all Continue buttons based on a loaded save.
 *
 * @param {FranchiseSave | null} save
 */
function updateContinueUI(save) {
  const continueCard = document.querySelector("[data-continue-card]");
  const continueMeta = document.querySelector("[data-continue-meta]");
  const continueNameSub = document.getElementById("continue-franchise-name-sub");
  const continueButtons = document.querySelectorAll("[data-continue-button]");
  const renameButton = document.getElementById("btn-rename-franchise");
  const accoladesToggle = document.getElementById("btn-toggle-accolades");
  const accoladesPanel = document.querySelector("[data-accolades-panel]");

  if (!continueCard || !continueMeta || !continueNameSub || !renameButton || !accoladesToggle || !accoladesPanel) {
    return;
  }

  if (!save) {
    continueCard.classList.add("is-disabled");
    continueNameSub.textContent = "No active franchise";
    continueMeta.innerHTML = `
      <strong>No active franchise</strong>
      <small>Start a new franchise to create one.</small>
    `;

    continueButtons.forEach((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return;
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    });

    renameButton.disabled = true;
    accoladesToggle.disabled = true;
    accoladesToggle.setAttribute("aria-expanded", "false");
    accoladesPanel.hidden = true;
    return;
  }

  continueCard.classList.remove("is-disabled");

  const weekDisplay = save.weekIndex != null ? `Week ${save.weekIndex}` : "Week –";
  const lastPlayed = formatLastPlayed(save.lastPlayedISO);
  const metaLine = `Year ${save.seasonYear} \u2013 ${weekDisplay} \u2022 ${save.record} \u2022 ${save.phase}`;

  continueNameSub.textContent = `${save.franchiseName} (${save.teamCode})`;
  continueMeta.innerHTML = `
    <strong>${save.franchiseName} (${save.teamCode})</strong>
    <small>${metaLine}<span> \u2022 Last played: ${lastPlayed}</span></small>
  `;

  continueButtons.forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.disabled = false;
    btn.setAttribute("aria-disabled", "false");
  });

  renameButton.disabled = false;

  // Accolades
  accoladesToggle.disabled = false;
  updateAccoladesUI(save);
}

/**
 * Update the accolades panel values from the save.
 *
 * @param {FranchiseSave | null} save
 */
function updateAccoladesUI(save) {
  const panel = document.querySelector("[data-accolades-panel]");
  const seasonsEl = document.querySelector("[data-accolades-seasons]");
  const playoffsEl = document.querySelector("[data-accolades-playoffs]");
  const divisionsEl = document.querySelector("[data-accolades-divisions]");
  const champsEl = document.querySelector("[data-accolades-championships]");

  if (!panel || !seasonsEl || !playoffsEl || !divisionsEl || !champsEl) return;
  if (!save) {
    seasonsEl.textContent = "0";
    playoffsEl.textContent = "0";
    divisionsEl.textContent = "0";
    champsEl.textContent = "0";
    return;
  }

  const a = save.accolades || {};
  seasonsEl.textContent = String(a.seasons ?? 0);
  playoffsEl.textContent = String(a.playoffAppearances ?? 0);
  divisionsEl.textContent = String(a.divisionTitles ?? 0);
  champsEl.textContent = String(a.championships ?? 0);
}

// -----------------------------
// Modal (overwrite) behavior
// -----------------------------

const modalState = {
  open: false,
  lastFocusedElement: null,
  keydownHandler: null
};

/**
 * Get focusable elements inside an element.
 * Basic implementation for the modal.
 */
function getFocusableElements(container) {
  const selectors = [
    "button",
    "[href]",
    "input",
    "select",
    "textarea",
    "[tabindex]:not([tabindex='-1'])"
  ];
  return Array.prototype.slice.call(
    container.querySelectorAll(selectors.join(","))
  ).filter(function (el) {
    return !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden");
  });
}

/**
 * Open the overwrite confirmation modal.
 */
function openOverwriteModal() {
  const backdrop = document.querySelector("[data-modal-backdrop]");
  const modal = backdrop && backdrop.querySelector(".modal");
  if (!backdrop || !modal) return;

  backdrop.hidden = false;
  modalState.open = true;
  modalState.lastFocusedElement = document.activeElement;

  const focusables = getFocusableElements(modal);
  if (focusables.length > 0) {
    focusables[0].focus();
  }

  modalState.keydownHandler = function (event) {
    if (!modalState.open) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeOverwriteModal();
      return;
    }

    if (event.key === "Tab") {
      const focusablesInner = getFocusableElements(modal);
      if (focusablesInner.length === 0) return;

      const first = focusablesInner[0];
      const last = focusablesInner[focusablesInner.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  };

  document.addEventListener("keydown", modalState.keydownHandler);
}

/**
 * Close the overwrite confirmation modal.
 */
function closeOverwriteModal() {
  const backdrop = document.querySelector("[data-modal-backdrop]");
  if (!backdrop) return;

  backdrop.hidden = true;
  modalState.open = false;

  if (modalState.keydownHandler) {
    document.removeEventListener("keydown", modalState.keydownHandler);
    modalState.keydownHandler = null;
  }

  if (modalState.lastFocusedElement && typeof modalState.lastFocusedElement.focus === "function") {
    modalState.lastFocusedElement.focus();
  }
}

/**
 * Bind events for the overwrite modal buttons.
 */
function bindModalEvents() {
  const cancelBtn = document.getElementById("modal-cancel");
  const confirmBtn = document.getElementById("modal-confirm");

  if (cancelBtn) {
    cancelBtn.addEventListener("click", function () {
      closeOverwriteModal();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener("click", function () {
      // At this point, we do not create or wipe the save here.
      // We simply move to team_select.html where the new franchise will be set up.
      navigateToTeamSelect();
    });
  }
}

// -----------------------------
// Event binding for landing page
// -----------------------------

function bindLandingEventListeners() {
  const btnStartHero = document.getElementById("btn-start-hero");
  const btnStartModeCard = document.getElementById("btn-start-mode-card");

  const continueButtons = document.querySelectorAll("[data-continue-button]");
  const renameButton = document.getElementById("btn-rename-franchise");
  const accoladesToggle = document.getElementById("btn-toggle-accolades");
  const accoladesPanel = document.querySelector("[data-accolades-panel]");

  // Unified "Start New Franchise" handler.
  function handleStartNewFranchiseClick() {
    const existing = loadLastFranchise();

    // No existing franchise: go directly to team select.
    if (!existing) {
      navigateToTeamSelect();
      return;
    }

    // Existing franchise: confirm overwrite.
    openOverwriteModal();
  }

  // Unified "Continue Franchise" handler.
  function handleContinueFranchiseClick() {
    const save = loadLastFranchise();
    if (!save) {
      // No-op if something cleared the save between render and click.
      return;
    }

    // In a more complex setup, you might stash franchiseId in sessionStorage
    // or append a query parameter here for the franchise.html page to read:
    // sessionStorage.setItem("franchiseGM_activeId", save.franchiseId);
    navigateToFranchise();
  }

  // Rename franchise handler.
  function handleRenameFranchise() {
    const save = loadLastFranchise();
    if (!save) return;

    const currentName = save.franchiseName || "";
    const nextName = window.prompt("Enter a new franchise name:", currentName);
    if (!nextName) return;

    const trimmed = nextName.trim();
    if (!trimmed) return;

    const updated = Object.assign({}, save, { franchiseName: trimmed });
    saveLastFranchise(updated);
    updateContinueUI(updated);
  }

  // Accolades toggle handler.
  function handleAccoladesToggle() {
    if (!accoladesToggle || !accoladesPanel) return;
    const expanded = accoladesToggle.getAttribute("aria-expanded") === "true";
    const newExpanded = !expanded;

    accoladesToggle.setAttribute("aria-expanded", newExpanded ? "true" : "false");
    accoladesPanel.hidden = !newExpanded;

    const chevron = accoladesToggle.querySelector(".chevron");
    if (chevron) {
      chevron.style.transform = newExpanded ? "rotate(180deg)" : "rotate(0deg)";
    }
  }

  // Start buttons
  if (btnStartHero) {
    btnStartHero.addEventListener("click", handleStartNewFranchiseClick);
  }
  if (btnStartModeCard) {
    btnStartModeCard.addEventListener("click", handleStartNewFranchiseClick);
  }

  // Continue buttons
  continueButtons.forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.addEventListener("click", handleContinueFranchiseClick);
  });

  // Rename
  if (renameButton) {
    renameButton.addEventListener("click", handleRenameFranchise);
  }

  // Accolades toggle
  if (accoladesToggle) {
    accoladesToggle.addEventListener("click", handleAccoladesToggle);
  }

  // Modal buttons
  bindModalEvents();
}

// -----------------------------
// Init
// -----------------------------

function initLanding() {
  const existingSave = loadLastFranchise();
  updateContinueUI(existingSave);
  bindLandingEventListeners();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLanding);
} else {
  initLanding();
}

// -----------------------------
// Notes for expanding later
// -----------------------------

// - To support multiple franchise slots:
//   * Replace SAVE_KEY_LAST_FRANCHISE with something like "franchiseGM_saves" that stores an
//     array of FranchiseSave summary objects.
//   * Render a list of slots instead of a single card, or a slot picker before this hero.
//   * Continue / Start would then work against a selected slot or create a new one.
//   * You can still reuse mergeSaveSummary, autosaveAfterWeek, and autosaveAfterMajorDecision.
//
// - To hook in real franchise initialization:
//   * On team_select.html, once the user picks a team and name, build a full FranchiseSave plus
//     your full leagueState object, then call:
//       const save = buildDefaultFranchiseSave({ franchiseName, teamCode, seasonYear: initialYear });
//       saveLastFranchise(save);
//   * Then navigate to franchise.html where you will actually spin up the engine.
//
// - On franchise.html and other mode pages:
//   * Call loadLastFranchise() on entry to retrieve the summary for UI (e.g., header).
//   * When a week finishes simming, call autosaveAfterWeek({ ...patchHere });
//   * After trades/signings/drafts, call autosaveAfterMajorDecision({ ...patchHere });
//   * If you introduce multiple slots, these helpers will take a franchiseId instead of
//     assuming a single global slot.
