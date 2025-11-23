// main_page.js
// Landing / Mode Select logic for Franchise GM.
//
// This file defines:
// - A versioned FranchiseSave shape stored under a single localStorage key.
// - Helpers for loading/saving, generating IDs, and updating last-played timestamps.
// - Stubs for autosave flows that can be called from other pages after sims/decisions.
// - UI wiring for Start / Continue / Rename / Accolades / Overwrite modal.
// - Tool links pointing to your existing roster/sim pages.
//
// If you later rename your old index.html (Layer 3 Rosters) to a different filename,
// update setupToolLinks() below to match.

// -----------------------------
// Save schema & key
// -----------------------------

/**
 * @typedef {Object} FranchiseSave
 * @property {number} version
 * @property {string} franchiseId
 * @property {string} franchiseName
 * @property {string} teamCode
 * @property {number} seasonYear
 * @property {number} weekIndex
 * @property {string} record
 * @property {string} phase
 * @property {string} lastPlayedISO
 * @property {Object} accolades
 * @property {number} accolades.seasons
 * @property {number} accolades.playoffAppearances
 * @property {number} accolades.divisionTitles
 * @property {number} accolades.championships
 * @property {Object} gmJob
 * @property {number} gmJob.contractYears
 * @property {number} gmJob.currentYear
 * @property {string} gmJob.status
 * @property {Object} leagueSummary
 * @property {number} leagueSummary.teams
 * @property {number} leagueSummary.seasonsSimmed
 */

const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";

// This matches the DEFAULT_LAYER3_URL from your current index.html
const DEFAULT_LAYER3_URL =
  "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/layer3_rosters.csv";

// -----------------------------
// Storage helpers
// -----------------------------

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

function generateNewFranchiseId() {
  const timePart = Date.now().toString(36);
  const randPart = Math.random().toString(36).slice(2, 8);
  return `franchise-${timePart}-${randPart}`;
}

/**
 * Build a default FranchiseSave, then allow overrides.
 * In the real app, you'd construct this from actual league init logic
 * after team selection.
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
 * Attempt to migrate a legacy save (old shape) into the new FranchiseSave shape.
 * Legacy expected: { teamName, seasonYear, record, lastPlayedISO }
 */
function migrateLegacySave(legacy) {
  if (!legacy || typeof legacy !== "object") return null;
  if (!legacy.teamName) return null;

  const teamName = String(legacy.teamName);
  const seasonYear =
    typeof legacy.seasonYear === "number"
      ? legacy.seasonYear
      : new Date().getFullYear();
  const record =
    typeof legacy.record === "string" ? legacy.record : "0-0";
  const lastPlayedISO =
    typeof legacy.lastPlayedISO === "string"
      ? legacy.lastPlayedISO
      : new Date().toISOString();

  const migrated = buildDefaultFranchiseSave({
    franchiseName: teamName,
    teamCode: "XXX",
    seasonYear,
    record,
    lastPlayedISO,
    phase: "Unknown"
  });

  saveLastFranchise(migrated);
  return migrated;
}

/**
 * Basic validation for versioned FranchiseSave.
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
 * Load the last franchise from localStorage.
 */
function loadLastFranchise() {
  if (!storageAvailable()) return null;

  const raw = window.localStorage.getItem(SAVE_KEY_LAST_FRANCHISE);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);

    if (isValidFranchiseSave(parsed)) {
      return parsed;
    }

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
 * Persist FranchiseSave.
 */
function saveLastFranchise(save) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(
      SAVE_KEY_LAST_FRANCHISE,
      JSON.stringify(save)
    );
  } catch (err) {
    console.warn("[Franchise GM] Failed to write franchise save:", err);
  }
}

/**
 * Return a copy with lastPlayedISO updated to now.
 */
function updateLastPlayed(save) {
  return Object.assign({}, save, {
    lastPlayedISO: new Date().toISOString()
  });
}

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
// Autosave stubs for other pages
// -----------------------------

function mergeSaveSummary(base, patch) {
  const result = Object.assign({}, base, patch || {});

  if (patch && patch.accolades) {
    result.accolades = Object.assign(
      {},
      base.accolades || {},
      patch.accolades
    );
  }
  if (patch && patch.gmJob) {
    result.gmJob = Object.assign({}, base.gmJob || {}, patch.gmJob);
  }
  if (patch && patch.leagueSummary) {
    result.leagueSummary = Object.assign(
      {},
      base.leagueSummary || {},
      patch.leagueSummary
    );
  }

  return result;
}

/**
 * Called from other pages when a week sim finishes.
 *
 * Example:
 * autosaveAfterWeek({
 *   weekIndex: 8,
 *   record: "5-3",
 *   phase: "Regular Season",
 *   accolades: { seasons: 2, playoffAppearances: 1 }
 * });
 */
function autosaveAfterWeek(summaryUpdate) {
  let save = loadLastFranchise();
  if (!save) {
    console.warn(
      "[Franchise GM] autosaveAfterWeek called with no existing save."
    );
    return;
  }

  const merged = mergeSaveSummary(save, summaryUpdate);
  const updated = updateLastPlayed(merged);
  saveLastFranchise(updated);
}

/**
 * Called from other pages after major decisions (signings, trades, drafts, etc.).
 */
function autosaveAfterMajorDecision(summaryUpdate) {
  let save = loadLastFranchise();
  if (!save) {
    console.warn(
      "[Franchise GM] autosaveAfterMajorDecision called with no existing save."
    );
    return;
  }

  const merged = mergeSaveSummary(save, summaryUpdate);
  const updated = updateLastPlayed(merged);
  saveLastFranchise(updated);
}

// -----------------------------
// Navigation helpers
// -----------------------------

function navigateToFranchise() {
  window.location.href = "franchise.html";
}

/**
 * Navigate to team_select.html where you'll:
 * - pick a team
 * - name the franchise
 * - build full league state
 * - call saveLastFranchise() with the real FranchiseSave
 */
function navigateToTeamSelect() {
  window.location.href = "team_select.html";
}

// -----------------------------
// Tool links (to existing pages)
// -----------------------------

/**
 * Set up links to:
 * - Layer 3 Rosters (current index.html)
 * - Simulation (simulation.html)
 * - Batch Sim (batch_sim.html)
 *
 * All carry the same ?players=<DEFAULT_LAYER3_URL> pattern as your current index.html.
 */
function setupToolLinks() {
  const playersParam = encodeURIComponent(DEFAULT_LAYER3_URL);

  const rostersLink = document.getElementById("link-rosters");
  const simLink = document.getElementById("link-sim");
  const batchLink = document.getElementById("link-batch");

  // If you later rename your rosters page, update this URL.
  if (rostersLink) {
    rostersLink.href = `index.html?players=${playersParam}`;
  }

  if (simLink) {
    simLink.href = `simulation.html?players=${playersParam}`;
  }

  if (batchLink) {
    batchLink.href = `batch_sim.html?players=${playersParam}&n=500`;
  }
}

// -----------------------------
// UI wiring
// -----------------------------

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

/**
 * Update the Continue card and all Continue buttons.
 */
function updateContinueUI(save) {
  const continueCard = document.querySelector("[data-continue-card]");
  const continueMeta = document.querySelector("[data-continue-meta]");
  const continueNameSub = document.getElementById("continue-franchise-name-sub");
  const continueButtons = document.querySelectorAll("[data-continue-button]");
  const renameButton = document.getElementById("btn-rename-franchise");
  const accoladesToggle = document.getElementById("btn-toggle-accolades");
  const accoladesPanel = document.querySelector("[data-accolades-panel]");

  if (
    !continueCard ||
    !continueMeta ||
    !continueNameSub ||
    !renameButton ||
    !accoladesToggle ||
    !accoladesPanel
  ) {
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

  const weekDisplay =
    save.weekIndex != null ? `Week ${save.weekIndex}` : "Week –";
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

// -----------------------------
// Modal behavior
// -----------------------------

const modalState = {
  open: false,
  lastFocusedElement: null,
  keydownHandler: null
};

function getFocusableElements(container) {
  const selectors = [
    "button",
    "[href]",
    "input",
    "select",
    "textarea",
    "[tabindex]:not([tabindex='-1'])"
  ];
  return Array.prototype.slice
    .call(container.querySelectorAll(selectors.join(",")))
    .filter(function (el) {
      return !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden");
    });
}

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
      const last =
        focusablesInner[focusablesInner.length - 1];
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

function closeOverwriteModal() {
  const backdrop = document.querySelector("[data-modal-backdrop]");
  if (!backdrop) return;

  backdrop.hidden = true;
  modalState.open = false;

  if (modalState.keydownHandler) {
    document.removeEventListener("keydown", modalState.keydownHandler);
    modalState.keydownHandler = null;
  }

  if (
    modalState.lastFocusedElement &&
    typeof modalState.lastFocusedElement.focus === "function"
  ) {
    modalState.lastFocusedElement.focus();
  }
}

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
      // We don't wipe the save here; we go to team_select.html
      // where a new franchise will be configured and saved.
      navigateToTeamSelect();
    });
  }
}

// -----------------------------
// Landing events
// -----------------------------

function bindLandingEventListeners() {
  const btnStartHero = document.getElementById("btn-start-hero");
  const btnStartModeCard = document.getElementById("btn-start-mode-card");

  const continueButtons = document.querySelectorAll("[data-continue-button]");
  const renameButton = document.getElementById("btn-rename-franchise");
  const accoladesToggle = document.getElementById("btn-toggle-accolades");
  const accoladesPanel = document.querySelector("[data-accolades-panel");

  function handleStartNewFranchiseClick() {
    const existing = loadLastFranchise();

    if (!existing) {
      navigateToTeamSelect();
      return;
    }

    openOverwriteModal();
  }

  function handleContinueFranchiseClick() {
    const save = loadLastFranchise();
    if (!save) return;

    // If you want, you can stash franchiseId in sessionStorage here:
    // sessionStorage.setItem("franchiseGM_activeId", save.franchiseId);
    navigateToFranchise();
  }

  function handleRenameFranchise() {
    const save = loadLastFranchise();
    if (!save) return;

    const currentName = save.franchiseName || "";
    const nextName = window.prompt(
      "Enter a new franchise name:",
      currentName
    );
    if (!nextName) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;

    const updated = Object.assign({}, save, {
      franchiseName: trimmed
    });
    saveLastFranchise(updated);
    updateContinueUI(updated);
  }

  function handleAccoladesToggle() {
    const toggleEl = document.getElementById("btn-toggle-accolades");
    const panel = document.querySelector("[data-accolades-panel]");
    if (!toggleEl || !panel) return;

    const expanded = toggleEl.getAttribute("aria-expanded") === "true";
    const newExpanded = !expanded;

    toggleEl.setAttribute(
      "aria-expanded",
      newExpanded ? "true" : "false"
    );
    panel.hidden = !newExpanded;

    const chevron = toggleEl.querySelector(".chevron");
    if (chevron) {
      chevron.style.transform = newExpanded
        ? "rotate(180deg)"
        : "rotate(0deg)";
    }
  }

  if (btnStartHero) {
    btnStartHero.addEventListener(
      "click",
      handleStartNewFranchiseClick
    );
  }
  if (btnStartModeCard) {
    btnStartModeCard.addEventListener(
      "click",
      handleStartNewFranchiseClick
    );
  }

  continueButtons.forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.addEventListener("click", handleContinueFranchiseClick);
  });

  if (renameButton) {
    renameButton.addEventListener("click", handleRenameFranchise);
  }

  if (accoladesToggle) {
    accoladesToggle.addEventListener("click", handleAccoladesToggle);
  }

  bindModalEvents();
}

// -----------------------------
// Init
// -----------------------------

function initLanding() {
  const existingSave = loadLastFranchise();
  updateContinueUI(existingSave);
  bindLandingEventListeners();
  setupToolLinks(); // new: wire up the Rosters / Simulation / Batch Sim links
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLanding);
} else {
  initLanding();
}

// -----------------------------
// Notes:
// - To switch to multiple save slots, replace the single SAVE_KEY_* with an array
//   of saves and render a selector instead of a single card.
// - On team_select.html, build a real FranchiseSave (plus full league state) and
//   call saveLastFranchise(), then redirect to franchise.html.
// - On franchise.html, call autosaveAfterWeek / autosaveAfterMajorDecision
//   when sims/decisions complete.
// -----------------------------
