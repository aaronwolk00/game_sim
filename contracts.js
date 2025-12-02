// contracts.js
// -----------------------------------------------------------------------------
// Franchise GM – Contracts & Cap Overview
//
// - Loads FranchiseSave + LeagueState from localStorage.
// - Ensures LeagueState.schedule exists (for team list/record).
// - Ensures LeagueState.contracts exists, with seeded mock data.
// - Renders:
//     • Team cap sheet view (per-team contracts for selected year)
//     • League rankings view (position-based contract rankings)
// - Supports simple cut / restructure actions that write back to LeagueState.
//
// This file must stay plain JavaScript (no TypeScript syntax).
// -----------------------------------------------------------------------------

import {
    TEAM_META,
    getTeamDisplayName,
    recomputeRecordFromSchedule,
    ensureAllTeamSchedules
  } from "./league_schedule.js";
  
  // -----------------------------------------------------------------------------
  // Storage helpers
  // -----------------------------------------------------------------------------
  
  const SAVE_KEY_LAST_FRANCHISE = "franchiseGM_lastFranchise";
  const LEAGUE_STATE_KEY_PREFIX = "franchiseGM_leagueState_";
  
  function getLeagueStateKey(franchiseId) {
    return `${LEAGUE_STATE_KEY_PREFIX}${franchiseId}`;
  }
  
  function storageAvailable() {
    try {
      const testKey = "__franchise_gm_storage_test__contracts";
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
      return parsed && typeof parsed === "object" ? parsed : null;
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
      return parsed && typeof parsed === "object" ? parsed : null;
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
      console.warn("[Contracts] Failed to save league state:", err);
    }
  }
  
  // -----------------------------------------------------------------------------
  // DOM helpers
  // -----------------------------------------------------------------------------
  
  function getEl(id) {
    return document.getElementById(id);
  }
  
  function formatMoneyMillions(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "$0.0M";
    const abs = Math.abs(num);
    const sign = num < 0 ? "-" : "";
    return `${sign}$${abs.toFixed(1)}M`;
  }
  
  function safeNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  
  // -----------------------------------------------------------------------------
  // Contracts data model helpers
  // -----------------------------------------------------------------------------
  
  // Default cap numbers – tweak as needed.
  const DEFAULT_CAP_BY_YEAR = {
    "2028": 275,
    "2029": 285,
    "2030": 295,
    "2031": 305,
    "2032": 315
  };
  
  function ensureContractsInitialized(leagueState, userTeamCode) {
    leagueState.contracts = leagueState.contracts || {};
    const c = leagueState.contracts;
  
    c.meta = c.meta || {};
    c.meta.capByYear = c.meta.capByYear || { ...DEFAULT_CAP_BY_YEAR };
  
    c.teams = c.teams || {};
  
    // Ensure at least user team has some seeded contracts.
    if (userTeamCode && !c.teams[userTeamCode]) {
      c.teams[userTeamCode] = {
        contracts: seedMockContractsForTeam(userTeamCode)
      };
    }
  
    // Optionally seed a couple of other teams if they exist but have no data.
    const byTeam = leagueState.schedule && leagueState.schedule.byTeam;
    if (byTeam) {
      for (const teamCode of Object.keys(byTeam)) {
        if (!c.teams[teamCode]) {
          c.teams[teamCode] = { contracts: [] };
        }
      }
    }
  
    return leagueState;
  }
  
  // Seed a small, obviously fake contract set for a team so the UI has data.
  // Numbers are in millions.
  function seedMockContractsForTeam(teamCode) {
    const display = getTeamDisplayName(teamCode) || teamCode || "Team";
    const prefix = display.split(" ")[0] || teamCode || "Player";
  
    const years = ["2028", "2029", "2030", "2031"];
  
    function makeYearRows(baseStart, bonus, lengthYears) {
      const rows = {};
      for (let i = 0; i < lengthYears; i++) {
        const y = years[i];
        if (!y) continue;
        const baseSalary = baseStart - i * 1.0;
        const signingBonusProrated = bonus / lengthYears;
        const capHit = baseSalary + signingBonusProrated;
        const deadCap = bonus - i * signingBonusProrated;
        rows[y] = {
          baseSalary,
          signingBonusProrated,
          rosterBonus: 0,
          optionBonus: 0,
          restructureBonus: 0,
          capHit,
          deadCapIfCutPreJune1: deadCap,
          deadCapIfCutPostJune1: deadCap * 0.9
        };
      }
      return rows;
    }
  
    return [
      {
        playerId: `${teamCode}_QB1`,
        playerName: `${prefix} QB1`,
        position: "QB",
        teamCode,
        contractStartYear: 2028,
        contractEndYear: 2031,
        totalValue: 160, // 4 yrs * 40M AAV
        totalGuarantees: 120,
        hasNoTradeClause: true,
        notes: "Mock franchise QB deal.",
        years: makeYearRows(42, 40, 4)
      },
      {
        playerId: `${teamCode}_WR1`,
        playerName: `${prefix} WR1`,
        position: "WR",
        teamCode,
        contractStartYear: 2028,
        contractEndYear: 2030,
        totalValue: 75,
        totalGuarantees: 50,
        years: makeYearRows(26, 15, 3)
      },
      {
        playerId: `${teamCode}_EDGE1`,
        playerName: `${prefix} EDGE1`,
        position: "DL",
        teamCode,
        contractStartYear: 2028,
        contractEndYear: 2030,
        totalValue: 66,
        totalGuarantees: 40,
        years: makeYearRows(24, 12, 3)
      },
      {
        playerId: `${teamCode}_CB1`,
        playerName: `${prefix} CB1`,
        position: "DB",
        teamCode,
        contractStartYear: 2028,
        contractEndYear: 2031,
        totalValue: 68,
        totalGuarantees: 42,
        years: makeYearRows(20, 20, 4)
      }
    ];
  }
  
  function getCapYears(contractsMeta) {
    const capByYear = (contractsMeta && contractsMeta.capByYear) || DEFAULT_CAP_BY_YEAR;
    const keys = Object.keys(capByYear).map((y) => String(y));
    keys.sort();
    return keys;
  }
  
  function computeAAV(contract) {
    if (!contract) return 0;
    const start = safeNumber(contract.contractStartYear, NaN);
    const end = safeNumber(contract.contractEndYear, NaN);
    const totalValue = safeNumber(contract.totalValue, 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return totalValue;
    }
    const years = end - start + 1;
    if (years <= 0) return totalValue;
    return totalValue / years;
  }
  
  function getYearSlice(contract, year) {
    const yKey = String(year);
    const y = (contract && contract.years && contract.years[yKey]) || null;
    if (!y) {
      return {
        baseSalary: 0,
        signingBonusProrated: 0,
        rosterBonus: 0,
        optionBonus: 0,
        restructureBonus: 0,
        capHit: 0,
        deadCapIfCutPreJune1: 0,
        deadCapIfCutPostJune1: 0
      };
    }
    return { ...y };
  }
  
  // After modifying salary/bonus, recompute capHit for all years.
  function recomputeContractCapHits(contract) {
    if (!contract || !contract.years) return;
    for (const [year, y] of Object.entries(contract.years)) {
      const base = safeNumber(y.baseSalary, 0);
      const sb = safeNumber(y.signingBonusProrated, 0);
      const rb = safeNumber(y.rosterBonus, 0);
      const ob = safeNumber(y.optionBonus, 0);
      const rstr = safeNumber(y.restructureBonus, 0);
      y.capHit = base + sb + rb + ob + rstr;
    }
  }
  
  // -----------------------------------------------------------------------------
  // View state
  // -----------------------------------------------------------------------------
  
  const viewState = {
    mode: "team",           // "team" | "league"
    selectedTeam: null,
    selectedYear: null,
    positionFilter: "ALL",
    leagueMetric: "aav",
    hideZeroCap: false,
    sortKey: "capHit",      // for team view
    sortDir: "desc"
  };
  
  let gSave = null;
  let gLeagueState = null;
  
  // -----------------------------------------------------------------------------
  // Rendering – header & summary
  // -----------------------------------------------------------------------------
  
  function populateHeader(save, leagueState) {
    const teamNameEl = getEl("contracts-header-name");
    const sublineEl = getEl("contracts-header-subline");
    const recordEl = getEl("contracts-record-value");
  
    const teamName = getTeamDisplayName(save.teamCode);
    if (teamNameEl) {
      teamNameEl.textContent = teamName || save.franchiseName || "Franchise Team";
    }
  
    const year = save.seasonYear || (leagueState && leagueState.seasonYear) || "";
    if (sublineEl) {
      sublineEl.textContent = `Season ${year} • Contracts & Cap Overview`;
    }
  
    let record = null;
    if (leagueState && leagueState.schedule) {
      record = recomputeRecordFromSchedule(leagueState, save.teamCode);
    }
    if (!record) record = save.record || "0–0";
  
    if (recordEl) {
      recordEl.textContent = record;
    }
  }
  
  function renderCapSummarySidebar() {
    const tbody = getEl("contracts-cap-summary-tbody");
    const topList = getEl("contracts-top-cap-list");
    const summarySubtitle = getEl("contracts-summary-subtitle");
    const topSubtitle = getEl("contracts-top-subtitle");
  
    if (!tbody || !gLeagueState || !gLeagueState.contracts) return;
  
    const teamCode = viewState.selectedTeam;
    const contractsObj = gLeagueState.contracts.teams[teamCode];
    const contracts = (contractsObj && contractsObj.contracts) || [];
  
    const capByYear = gLeagueState.contracts.meta.capByYear || DEFAULT_CAP_BY_YEAR;
    const years = getCapYears(gLeagueState.contracts.meta);
  
    tbody.innerHTML = "";
    const rows = [];
  
    years.forEach((year) => {
      const leagueCap = safeNumber(capByYear[year], 0);
      let teamCap = 0;
      for (const ct of contracts) {
        const slice = getYearSlice(ct, year);
        teamCap += safeNumber(slice.capHit, 0);
      }
      const space = leagueCap - teamCap;
  
      rows.push({ year, leagueCap, teamCap, space });
    });
  
    rows.forEach((row) => {
      const tr = document.createElement("tr");
  
      const tdYear = document.createElement("td");
      tdYear.textContent = row.year;
  
      const tdCap = document.createElement("td");
      tdCap.textContent = formatMoneyMillions(row.leagueCap);
  
      const tdTeamCap = document.createElement("td");
      tdTeamCap.textContent = formatMoneyMillions(row.teamCap);
  
      const tdSpace = document.createElement("td");
      tdSpace.textContent = formatMoneyMillions(row.space);
  
      tr.appendChild(tdYear);
      tr.appendChild(tdCap);
      tr.appendChild(tdTeamCap);
      tr.appendChild(tdSpace);
  
      tbody.appendChild(tr);
  
      // Add bar as a second row
      const trBar = document.createElement("tr");
      const tdBar = document.createElement("td");
      tdBar.colSpan = 4;
  
      const bar = document.createElement("div");
      bar.className = "cap-bar";
  
      const fill = document.createElement("div");
      fill.className = "cap-bar-fill";
  
      const pctUsed =
        row.leagueCap > 0 ? Math.max(0, Math.min(1, row.teamCap / row.leagueCap)) : 0;
      fill.style.width = `${(pctUsed * 100).toFixed(1)}%`;
  
      bar.appendChild(fill);
      tdBar.appendChild(bar);
      trBar.appendChild(tdBar);
      tbody.appendChild(trBar);
    });
  
    if (summarySubtitle && gLeagueState && gLeagueState.contracts) {
      const teamName = getTeamDisplayName(teamCode) || teamCode;
      summarySubtitle.textContent = `Cap usage for ${teamName}, all tracked seasons.`;
    }
  
    if (!topList) return;
    topList.innerHTML = "";
  
    const year = viewState.selectedYear;
    const seasonContracts = contracts
      .map((ct) => {
        const slice = getYearSlice(ct, year);
        return {
          playerName: ct.playerName,
          position: ct.position,
          capHit: safeNumber(slice.capHit, 0)
        };
      })
      .filter((row) => row.capHit > 0);
  
    seasonContracts.sort((a, b) => b.capHit - a.capHit);
    const top = seasonContracts.slice(0, 5);
  
    top.forEach((row) => {
      const li = document.createElement("li");
      li.className = "top-cap-item";
  
      const left = document.createElement("span");
      left.className = "top-cap-name";
      left.textContent = `${row.playerName} (${row.position || "—"})`;
  
      const right = document.createElement("span");
      right.className = "top-cap-meta";
      right.textContent = formatMoneyMillions(row.capHit);
  
      li.appendChild(left);
      li.appendChild(right);
      topList.appendChild(li);
    });
  
    if (topSubtitle) {
      topSubtitle.textContent = `Largest cap hits for ${year}`;
    }
  }
  
  // -----------------------------------------------------------------------------
  // Rendering – team cap sheet
  // -----------------------------------------------------------------------------
  
  function buildTeamCapTableHeader(year) {
    const headerRow = getEl("contracts-cap-header-row");
    if (!headerRow) return;
    headerRow.innerHTML = "";
  
    const columns = [
      { key: "playerName", label: "Player", sortable: true },
      { key: "position", label: "Pos", sortable: true },
      { key: "contractYears", label: "Years", sortable: false },
      { key: "aav", label: "AAV", sortable: true },
      { key: "capHit", label: `Cap hit ${year}`, sortable: true },
      { key: "deadPre", label: "Dead (Pre 6/1)", sortable: true },
      { key: "deadPost", label: "Dead (Post 6/1)", sortable: true },
      { key: "guarantees", label: "Guarantees", sortable: true },
      { key: "actions", label: "Actions", sortable: false }
    ];
  
    columns.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (col.sortable) {
        th.classList.add("sortable");
        th.dataset.sortKey = col.key;
        th.dataset.sortDir = viewState.sortKey === col.key ? viewState.sortDir : "";
        th.addEventListener("click", () => {
          if (viewState.sortKey === col.key) {
            viewState.sortDir = viewState.sortDir === "asc" ? "desc" : "asc";
          } else {
            viewState.sortKey = col.key;
            viewState.sortDir = col.key === "playerName" ? "asc" : "desc";
          }
          renderCurrentView();
        });
      }
      headerRow.appendChild(th);
    });
  }
  
  function renderTeamCapSheet() {
    const tbody = getEl("contracts-cap-tbody");
    const subtitle = getEl("contracts-card-subtitle");
    const footnote = getEl("contracts-footnote");
    const metricSelect = getEl("contracts-metric-filter");
  
    if (!tbody || !gLeagueState || !gLeagueState.contracts) return;
  
    const teamCode = viewState.selectedTeam;
    const year = viewState.selectedYear;
  
    buildTeamCapTableHeader(year);
    tbody.innerHTML = "";
  
    if (metricSelect) {
      // Metric selector is not meaningful in team view; show default.
      metricSelect.disabled = true;
    }
  
    const teamContractsObj = gLeagueState.contracts.teams[teamCode];
    const contracts = (teamContractsObj && teamContractsObj.contracts) || [];
  
    const posFilter = (viewState.positionFilter || "ALL").toUpperCase();
    const hideZero = !!viewState.hideZeroCap;
  
    let rows = contracts.map((ct) => {
      const slice = getYearSlice(ct, year);
      const aav = computeAAV(ct);
      const deadPre = safeNumber(slice.deadCapIfCutPreJune1, 0);
      const deadPost = safeNumber(slice.deadCapIfCutPostJune1, 0);
      const contractYears =
        ct.contractStartYear && ct.contractEndYear
          ? `${ct.contractStartYear}-${ct.contractEndYear}`
          : "—";
      return {
        contract: ct,
        playerName: ct.playerName || "Unknown",
        position: ct.position || "",
        contractYears,
        aav,
        capHit: safeNumber(slice.capHit, 0),
        deadPre,
        deadPost,
        guarantees: safeNumber(ct.totalGuarantees, 0)
      };
    });
  
    if (posFilter !== "ALL") {
      rows = rows.filter((r) => (r.position || "").toUpperCase() === posFilter);
    }
  
    if (hideZero) {
      rows = rows.filter((r) => r.capHit !== 0);
    }
  
    // Sort
    const { sortKey, sortDir } = viewState;
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (sortKey === "playerName" || sortKey === "position" || sortKey === "contractYears") {
        return String(va).localeCompare(String(vb)) * dir;
      }
      return (safeNumber(vb, 0) - safeNumber(va, 0)) * dir;
    });
  
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (row.contract.teamCode === gSave.teamCode) {
        tr.classList.add("row-user-team");
      }
  
      const tdName = document.createElement("td");
      tdName.textContent = row.playerName;
  
      const tdPos = document.createElement("td");
      tdPos.textContent = row.position || "—";
  
      const tdYears = document.createElement("td");
      tdYears.textContent = row.contractYears;
  
      const tdAav = document.createElement("td");
      tdAav.textContent = formatMoneyMillions(row.aav);
  
      const tdCapHit = document.createElement("td");
      tdCapHit.textContent = formatMoneyMillions(row.capHit);
  
      const tdDeadPre = document.createElement("td");
      tdDeadPre.textContent = formatMoneyMillions(row.deadPre);
  
      const tdDeadPost = document.createElement("td");
      tdDeadPost.textContent = formatMoneyMillions(row.deadPost);
  
      const tdGuar = document.createElement("td");
      tdGuar.textContent = formatMoneyMillions(row.guarantees);
  
      const tdActions = document.createElement("td");
      tdActions.className = "contracts-action-cell";
  
      const btnCutPre = document.createElement("button");
      btnCutPre.type = "button";
      btnCutPre.className = "contracts-action-btn";
      btnCutPre.textContent = "Cut Pre–6/1";
      btnCutPre.dataset.action = "cut-pre";
      btnCutPre.dataset.playerId = row.contract.playerId;
  
      const btnCutPost = document.createElement("button");
      btnCutPost.type = "button";
      btnCutPost.className = "contracts-action-btn";
      btnCutPost.textContent = "Cut Post–6/1";
      btnCutPost.dataset.action = "cut-post";
      btnCutPost.dataset.playerId = row.contract.playerId;
  
      const btnRestruct = document.createElement("button");
      btnRestruct.type = "button";
      btnRestruct.className = "contracts-action-btn contracts-action-btn--primary";
      btnRestruct.textContent = "Restructure";
      btnRestruct.dataset.action = "restructure";
      btnRestruct.dataset.playerId = row.contract.playerId;
  
      tdActions.appendChild(btnCutPre);
      tdActions.appendChild(btnCutPost);
      tdActions.appendChild(btnRestruct);
  
      tr.appendChild(tdName);
      tr.appendChild(tdPos);
      tr.appendChild(tdYears);
      tr.appendChild(tdAav);
      tr.appendChild(tdCapHit);
      tr.appendChild(tdDeadPre);
      tr.appendChild(tdDeadPost);
      tr.appendChild(tdGuar);
      tr.appendChild(tdActions);
  
      tbody.appendChild(tr);
    });
  
    if (subtitle) {
      const teamName = getTeamDisplayName(teamCode) || teamCode;
      subtitle.textContent = `Cap sheet for ${teamName}, season ${year}. Click headers to sort.`;
    }
    if (footnote) {
      footnote.textContent =
        "Cap hits / dead money are approximate and stored in LeagueState.contracts in millions. Actions modify the saved contracts and recompute totals.";
    }
  }
  
  // -----------------------------------------------------------------------------
  // Rendering – league rankings view
  // -----------------------------------------------------------------------------
  
  function buildLeagueRankingsHeader() {
    const headerRow = getEl("contracts-cap-header-row");
    if (!headerRow) return;
    headerRow.innerHTML = "";
  
    const cols = [
      { key: "rank", label: "#", sortable: false },
      { key: "playerName", label: "Player", sortable: true },
      { key: "position", label: "Pos", sortable: true },
      { key: "teamCode", label: "Team", sortable: true },
      { key: "aav", label: "AAV", sortable: true },
      { key: "totalValue", label: "Total value", sortable: true },
      { key: "totalGuarantees", label: "Guarantees", sortable: true },
      { key: "contractYears", label: "Years", sortable: false }
    ];
  
    cols.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (col.sortable) {
        th.classList.add("sortable");
        th.dataset.sortKey = col.key;
        th.dataset.sortDir = viewState.sortKey === col.key ? viewState.sortDir : "";
        th.addEventListener("click", () => {
          if (viewState.sortKey === col.key) {
            viewState.sortDir = viewState.sortDir === "asc" ? "desc" : "asc";
          } else {
            viewState.sortKey = col.key;
            viewState.sortDir = col.key === "playerName" ? "asc" : "desc";
          }
          renderCurrentView();
        });
      }
      headerRow.appendChild(th);
    });
  }
  
  function renderLeagueRankings() {
    const tbody = getEl("contracts-cap-tbody");
    const subtitle = getEl("contracts-card-subtitle");
    const footnote = getEl("contracts-footnote");
    const metricSelect = getEl("contracts-metric-filter");
  
    if (!tbody || !gLeagueState || !gLeagueState.contracts) return;
    tbody.innerHTML = "";
  
    buildLeagueRankingsHeader();
  
    const posFilter = (viewState.positionFilter || "ALL").toUpperCase();
    const metric = viewState.leagueMetric || "aav";
  
    if (metricSelect) {
      metricSelect.disabled = false;
    }
  
    const rows = [];
  
    for (const [teamCode, obj] of Object.entries(gLeagueState.contracts.teams)) {
      const contracts = (obj && obj.contracts) || [];
      for (const ct of contracts) {
        const pos = (ct.position || "").toUpperCase();
        if (posFilter !== "ALL" && pos !== posFilter) continue;
  
        const aav = computeAAV(ct);
        const row = {
          contract: ct,
          playerName: ct.playerName || "Unknown",
          position: ct.position || "",
          teamCode,
          aav,
          totalValue: safeNumber(ct.totalValue, 0),
          totalGuarantees: safeNumber(ct.totalGuarantees, 0),
          contractYears:
            ct.contractStartYear && ct.contractEndYear
              ? `${ct.contractStartYear}-${ct.contractEndYear}`
              : "—"
        };
  
        rows.push(row);
      }
    }
  
    let metricKey = "aav";
    if (metric === "total") metricKey = "totalValue";
    if (metric === "guarantees") metricKey = "totalGuarantees";
  
    // Sort by chosen metric by default if sortKey hasn't been changed manually
    const sortKey = viewState.sortKey || metricKey;
    const dir = viewState.sortDir === "asc" ? 1 : -1;
  
    rows.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (sortKey === "playerName" || sortKey === "position" || sortKey === "teamCode") {
        return String(va).localeCompare(String(vb)) * dir;
      }
      return (safeNumber(vb, 0) - safeNumber(va, 0)) * dir;
    });
  
    rows.forEach((row, idx) => {
      const tr = document.createElement("tr");
      if (row.teamCode === gSave.teamCode) {
        tr.classList.add("row-user-team");
      }
  
      const tdRank = document.createElement("td");
      tdRank.textContent = String(idx + 1);
  
      const tdName = document.createElement("td");
      tdName.textContent = row.playerName;
  
      const tdPos = document.createElement("td");
      tdPos.textContent = row.position || "—";
  
      const tdTeam = document.createElement("td");
      tdTeam.textContent = row.teamCode;
  
      const tdAav = document.createElement("td");
      tdAav.textContent = formatMoneyMillions(row.aav);
  
      const tdTotal = document.createElement("td");
      tdTotal.textContent = formatMoneyMillions(row.totalValue);
  
      const tdGuar = document.createElement("td");
      tdGuar.textContent = formatMoneyMillions(row.totalGuarantees);
  
      const tdYears = document.createElement("td");
      tdYears.textContent = row.contractYears;
  
      tr.appendChild(tdRank);
      tr.appendChild(tdName);
      tr.appendChild(tdPos);
      tr.appendChild(tdTeam);
      tr.appendChild(tdAav);
      tr.appendChild(tdTotal);
      tr.appendChild(tdGuar);
      tr.appendChild(tdYears);
  
      tbody.appendChild(tr);
    });
  
    if (subtitle) {
      const posLabel = posFilter === "ALL" ? "all positions" : posFilter;
      const metricLabel =
        metricKey === "aav"
          ? "AAV"
          : metricKey === "totalValue"
          ? "total contract value"
          : "total guarantees";
      subtitle.textContent = `League-wide rankings for ${posLabel}, sorted by ${metricLabel}.`;
    }
  
    if (footnote) {
      footnote.textContent =
        "League rankings are based on contract values saved in LeagueState.contracts. Your team’s contracts are highlighted.";
    }
  }
  
  // -----------------------------------------------------------------------------
  // Actions – cut / restructure
  // -----------------------------------------------------------------------------
  
  function handleContractAction(action, playerId) {
    if (!gLeagueState || !gLeagueState.contracts) return;
  
    const teamCode = viewState.selectedTeam;
    const year = viewState.selectedYear;
    const teamContracts = gLeagueState.contracts.teams[teamCode];
    if (!teamContracts || !Array.isArray(teamContracts.contracts)) return;
  
    const contract = teamContracts.contracts.find((ct) => ct.playerId === playerId);
    if (!contract) return;
  
    const yKey = String(year);
    const yearSlice = contract.years[yKey];
    if (!yearSlice) {
      window.alert("No salary data for this year on this contract.");
      return;
    }
  
    if (action === "cut-pre" || action === "cut-post") {
      const label = action === "cut-pre" ? "pre–June 1" : "post–June 1";
      const confirm = window.confirm(
        `Cut ${contract.playerName} (${label}) in ${year}? This will modify the saved cap numbers for this contract.`
      );
      if (!confirm) return;
  
      const dead =
        action === "cut-pre"
          ? safeNumber(yearSlice.deadCapIfCutPreJune1, 0)
          : safeNumber(yearSlice.deadCapIfCutPostJune1, 0);
  
      // Simple model:
      // - Current year: capHit becomes dead amount.
      // - Future years: base + bonuses zeroed out and dead numbers cleared.
      yearSlice.baseSalary = 0;
      yearSlice.rosterBonus = 0;
      yearSlice.optionBonus = 0;
      yearSlice.restructureBonus = 0;
      yearSlice.capHit = dead;
      yearSlice.deadCapIfCutPreJune1 = 0;
      yearSlice.deadCapIfCutPostJune1 = 0;
  
      for (const [yk, info] of Object.entries(contract.years)) {
        const yNum = Number(yk);
        if (!Number.isFinite(yNum) || yNum <= year) continue;
        info.baseSalary = 0;
        info.rosterBonus = 0;
        info.optionBonus = 0;
        info.restructureBonus = 0;
        info.capHit = 0;
        info.deadCapIfCutPreJune1 = 0;
        info.deadCapIfCutPostJune1 = 0;
      }
  
      contract.cutYear = year;
  
      recomputeContractCapHits(contract);
      saveLeagueState(gLeagueState);
      renderCurrentView();
      renderCapSummarySidebar();
      return;
    }
  
    if (action === "restructure") {
      const maxAmount = safeNumber(yearSlice.baseSalary, 0);
      if (maxAmount <= 0) {
        window.alert("No base salary available to convert this year.");
        return;
      }
  
      const input = window.prompt(
        `Enter amount of base salary (in millions) to convert to signing bonus in ${year}.\nMax: ${maxAmount.toFixed(
          2
        )}M`,
        Math.min(maxAmount, 5).toFixed(2)
      );
      if (input == null) return;
      const amount = safeNumber(input, NaN);
      if (!Number.isFinite(amount) || amount <= 0) {
        window.alert("Invalid amount.");
        return;
      }
      if (amount > maxAmount) {
        window.alert("Amount exceeds current base salary.");
        return;
      }
  
      // Decrease base this year, push equal prorated restructureBonus over remaining non-void years.
      yearSlice.baseSalary -= amount;
  
      const yearsRemaining = Object.keys(contract.years)
        .map((yk) => Number(yk))
        .filter((yn) => Number.isFinite(yn) && yn >= year)
        .sort((a, b) => a - b);
  
      if (!yearsRemaining.length) {
        recomputeContractCapHits(contract);
        saveLeagueState(gLeagueState);
        renderCurrentView();
        renderCapSummarySidebar();
        return;
      }
  
      const perYear = amount / yearsRemaining.length;
      yearsRemaining.forEach((yn) => {
        const k = String(yn);
        const row = contract.years[k];
        if (!row) return;
        row.restructureBonus = safeNumber(row.restructureBonus, 0) + perYear;
      });
  
      recomputeContractCapHits(contract);
      saveLeagueState(gLeagueState);
      renderCurrentView();
      renderCapSummarySidebar();
    }
  }
  
  // -----------------------------------------------------------------------------
  // View coordination
  // -----------------------------------------------------------------------------
  
  function renderCurrentView() {
    if (viewState.mode === "league") {
      renderLeagueRankings();
    } else {
      renderTeamCapSheet();
    }
  }
  
  function syncViewToggleButtons() {
    const btnTeam = getEl("contracts-view-team");
    const btnLeague = getEl("contracts-view-league");
    if (!btnTeam || !btnLeague) return;
  
    if (viewState.mode === "league") {
      btnLeague.dataset.active = "true";
      btnTeam.dataset.active = "false";
    } else {
      btnTeam.dataset.active = "true";
      btnLeague.dataset.active = "false";
    }
  }
  
  // -----------------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------------
  
  async function initContractsPage() {
    const save = loadLastFranchise();
    if (!save) {
      renderNoFranchiseState();
      return;
    }
    gSave = save;
  
    let leagueState = loadLeagueState(save.franchiseId);
    if (!leagueState) {
      leagueState = {
        franchiseId: save.franchiseId,
        seasonYear: save.seasonYear
      };
    } else {
      leagueState.seasonYear = save.seasonYear;
    }
  
    // Ensure schedules so we know all teams.
    await ensureAllTeamSchedules(leagueState, save.seasonYear);
    ensureContractsInitialized(leagueState, save.teamCode);
    saveLeagueState(leagueState);
  
    gLeagueState = leagueState;
  
    populateHeader(save, leagueState);
    setupControls();
    renderCapSummarySidebar();
    renderCurrentView();
  }
  
  function setupControls() {
    const teamSelect = getEl("contracts-team-select");
    const yearSelect = getEl("contracts-year-select");
    const posSelect = getEl("contracts-position-filter");
    const metricSelect = getEl("contracts-metric-filter");
    const hideZero = getEl("contracts-hide-zero");
    const btnTeam = getEl("contracts-view-team");
    const btnLeague = getEl("contracts-view-league");
    const tbody = getEl("contracts-cap-tbody");
  
    // Team list from schedule.byTeam or TEAM_META
    const teamCodes = new Set();
    if (gLeagueState && gLeagueState.schedule && gLeagueState.schedule.byTeam) {
      Object.keys(gLeagueState.schedule.byTeam).forEach((code) =>
        teamCodes.add(code)
      );
    } else if (TEAM_META) {
      Object.keys(TEAM_META).forEach((code) => teamCodes.add(code));
    }
    if (!teamCodes.size && gSave && gSave.teamCode) {
      teamCodes.add(gSave.teamCode);
    }
  
    if (teamSelect) {
      teamSelect.innerHTML = "";
      Array.from(teamCodes)
        .sort()
        .forEach((code) => {
          const opt = document.createElement("option");
          opt.value = code;
          opt.textContent = getTeamDisplayName(code) || code;
          if (code === gSave.teamCode) {
            opt.selected = true;
          }
          teamSelect.appendChild(opt);
        });
      viewState.selectedTeam = teamSelect.value || gSave.teamCode;
  
      teamSelect.addEventListener("change", () => {
        viewState.selectedTeam = teamSelect.value;
        renderCapSummarySidebar();
        renderCurrentView();
      });
    } else {
      viewState.selectedTeam = gSave.teamCode;
    }
  
    // Years from contracts.meta
    const years = getCapYears(gLeagueState.contracts.meta);
    if (yearSelect) {
      yearSelect.innerHTML = "";
      years.forEach((y) => {
        const opt = document.createElement("option");
        opt.value = y;
        opt.textContent = y;
        yearSelect.appendChild(opt);
      });
  
      // Default to current season if present, otherwise first.
      const preferred = String(gSave.seasonYear || "");
      if (years.includes(preferred)) {
        yearSelect.value = preferred;
      }
      viewState.selectedYear = Number(yearSelect.value || years[0]);
  
      yearSelect.addEventListener("change", () => {
        viewState.selectedYear = Number(yearSelect.value);
        renderCapSummarySidebar();
        renderCurrentView();
      });
    } else {
      viewState.selectedYear = Number(years[0]);
    }
  
    if (posSelect) {
      posSelect.addEventListener("change", () => {
        viewState.positionFilter = posSelect.value || "ALL";
        renderCurrentView();
      });
    }
  
    if (metricSelect) {
      metricSelect.addEventListener("change", () => {
        viewState.leagueMetric = metricSelect.value || "aav";
        renderCurrentView();
      });
    }
  
    if (hideZero) {
      hideZero.addEventListener("change", () => {
        viewState.hideZeroCap = !!hideZero.checked;
        renderCurrentView();
      });
    }
  
    if (btnTeam) {
      btnTeam.addEventListener("click", () => {
        viewState.mode = "team";
        viewState.sortKey = "capHit";
        viewState.sortDir = "desc";
        syncViewToggleButtons();
        renderCurrentView();
      });
    }
  
    if (btnLeague) {
      btnLeague.addEventListener("click", () => {
        viewState.mode = "league";
        viewState.sortKey = "aav";
        viewState.sortDir = "desc";
        syncViewToggleButtons();
        renderCurrentView();
      });
    }
  
    syncViewToggleButtons();
  
    if (tbody) {
      tbody.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const playerId = btn.dataset.playerId;
        if (!action || !playerId) return;
        handleContractAction(action, playerId);
      });
    }
  
    const backSchedule = getEl("btn-contracts-back-schedule");
    if (backSchedule) {
      backSchedule.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.href = "schedule.html";
      });
    }
  
    const backHub = getEl("btn-contracts-back-hub");
    if (backHub) {
      backHub.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.href = "franchise.html";
      });
    }
  }
  
  function renderNoFranchiseState() {
    const mainRoot = getEl("contracts-main");
    const header = getEl("contracts-header");
    const noFranchise = getEl("contracts-no-franchise");
    if (mainRoot) mainRoot.hidden = true;
    if (header) header.hidden = true;
    if (noFranchise) noFranchise.hidden = false;
  
    const btn = getEl("contracts-btn-main-menu");
    if (btn) {
      btn.addEventListener("click", () => {
        window.location.href = "index.html";
      });
    }
  }
  
  // -----------------------------------------------------------------------------
  // Bootstrap
  // -----------------------------------------------------------------------------
  
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initContractsPage().catch((err) => {
        console.error("[Contracts] init failed:", err);
      });
    });
  } else {
    initContractsPage().catch((err) => {
      console.error("[Contracts] init failed:", err);
    });
  }
  