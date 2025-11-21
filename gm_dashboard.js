// gm_dashboard.js
// Primary GM Dashboard logic for "Team Ratings Explorer" / GM view.
// Expects a companion HTML file that defines the core DOM elements
// (status pill, team select, meta panel, groups container, etc.).

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config & shared URL handling (aligned with index.html)
  // ---------------------------------------------------------------------------

  const URL_PARAMS = new URLSearchParams(window.location.search || "");

  // Allow ?players=<url> override; normalize /refs/heads/ -> /
  const RAW_PLAYERS_PARAM = (URL_PARAMS.get("players") || "").replace(
    "/refs/heads/",
    "/"
  );

  // Keep this in sync with index.html
  const DEFAULT_LAYER3_URL =
    "https://raw.githubusercontent.com/aaronwolk00/game_sim/refs/heads/main/layer3_rosters.csv";

  // If players= is given, prefer it; otherwise, use the default.
  const EFFECTIVE_ROSTER_URL = RAW_PLAYERS_PARAM || DEFAULT_LAYER3_URL;

  // Try the effective URL first, then fall back to the default.
  const CSV_URLS = [EFFECTIVE_ROSTER_URL, DEFAULT_LAYER3_URL];

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------

  const dom = {
    statusPill: document.getElementById("status-pill"),
    statusText: document.getElementById("status-text"),
    summaryMain: document.getElementById("summary-main"),
    summarySource: document.getElementById("summary-source"),
    errorBox: document.getElementById("error-box"),
    teamMeta: document.getElementById("team-meta"),
    groupsContainer: document.getElementById("groups-container"),
    teamSelect: document.getElementById("team-select"),
    clearTeamBtn: document.getElementById("clear-team-btn"),
    backLink: document.getElementById("back-link"),
  };

  // Simple guard so we fail loudly if the HTML is missing expected nodes
  function assertDomReady() {
    const missing = Object.entries(dom)
      .filter(([, el]) => !el)
      .map(([key]) => key);
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.error(
        "[gm_dashboard] Missing DOM elements:",
        missing.join(", ")
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Status + error helpers
  // ---------------------------------------------------------------------------

  function setStatus(state, message) {
    // state: "loading" | "ready" | "error"
    if (dom.statusPill) {
      dom.statusPill.dataset.state = state;
    }
    if (dom.statusText && typeof message === "string") {
      dom.statusText.textContent = message;
    }
  }

  function showError(message, detail) {
    if (!dom.errorBox) return;
    dom.errorBox.style.display = "block";
    dom.errorBox.innerHTML =
      "<strong>Load error:</strong> " +
      (message || "Unknown error") +
      (detail ? "<br><small>" + detail + "</small>" : "");
    setStatus("error", "Error loading team ratings");
  }

  function hideError() {
    if (dom.errorBox) {
      dom.errorBox.style.display = "none";
      dom.errorBox.textContent = "";
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch + CSV parsing (robust, quoted fields supported)
  // ---------------------------------------------------------------------------

  async function fetchCsvTextWithFallback(urls) {
    let lastError = null;
    for (const url of urls) {
      try {
        // Optional: small timeout wrapper so we don't hang forever on a bad host
        const controller = typeof AbortController !== "undefined"
          ? new AbortController()
          : null;

        const timeoutId =
          controller &&
          setTimeout(() => {
            controller.abort();
          }, 15000); // 15s timeout

        const res = await fetch(url, {
          cache: "no-store",
          mode: "cors",
          signal: controller ? controller.signal : undefined,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error("HTTP " + res.status + " – " + res.statusText);
        }
        const text = await res.text();
        return { text, url };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("CSV not reachable");
  }

  // Char-by-char CSV parser that respects quotes, commas, and newlines.
  function parseCsvToRows(text) {
    text = String(text || "").replace(/^\uFEFF/, ""); // strip BOM if present
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            // Escaped quote ("")
            field += '"';
            i++;
          } else {
            // End of quoted section
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else if (c !== "\r") {
          field += c;
        }
      }
    }
    // Push last field / row
    row.push(field);
    rows.push(row);

    // Filter out completely empty rows
    return rows.filter((r) => r.length && r.some((x) => x !== ""));
  }

  function rowsToObjectsWithDedupHeader(rows) {
    if (!rows.length) return [];
    const headerRaw = rows[0].map((h) => String(h || "").trim());

    // Deduplicate header names: id, id_1, id_2, ...
    const nameCounts = {};
    const headers = headerRaw.map((h) => {
      const base = h || "col";
      const count = nameCounts[base] || 0;
      const name = count === 0 ? base : `${base}_${count}`;
      nameCounts[base] = count + 1;
      return name;
    });

    return rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = r[i] === undefined ? "" : r[i];
      });
      return o;
    });
  }

  // ---------------------------------------------------------------------------
  // Team + rating utilities
  // ---------------------------------------------------------------------------

  const POSITION_GROUPS = {
    QB: "Quarterbacks",
    RB: "Running Backs",
    FB: "Fullbacks",
    WR: "Wide Receivers",
    TE: "Tight Ends",

    LT: "Offensive Line",
    LG: "Offensive Line",
    C: "Offensive Line",
    RG: "Offensive Line",
    RT: "Offensive Line",
    OL: "Offensive Line",

    DT: "Defensive Line",
    DL: "Defensive Line",
    DE: "Defensive Line",
    NT: "Defensive Line",

    EDGE: "Edge Rushers",

    LB: "Linebackers",

    CB: "Cornerbacks",

    S: "Safeties",
    FS: "Safeties",
    SS: "Safeties",

    K: "Specialists",
    P: "Specialists",
    LS: "Specialists",
  };

  const GROUP_NAME_ORDER = [
    "Quarterbacks",
    "Running Backs",
    "Fullbacks",
    "Wide Receivers",
    "Tight Ends",
    "Offensive Line",
    "Defensive Line",
    "Edge Rushers",
    "Linebackers",
    "Cornerbacks",
    "Safeties",
    "Specialists",
    "Other",
  ];

  let gAllRows = [];
  let gTeams = [];
  let gAllRatingColumns = [];

  function getPositionGroupLabel(pos) {
    const p = (pos || "").toUpperCase();
    return POSITION_GROUPS[p] || "Other";
  }

  function formatRating(value) {
    if (value == null || value === "") return "";
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    // For dashboard purposes, whole number feels right
    return Math.round(num);
  }

  function computeRatingColumns(objs) {
    if (!objs.length) return [];
    const headers = Object.keys(objs[0]);

    const core = ["rating_overall", "rating_pos"];

    const ratingCols = headers.filter((h) => {
      if (core.includes(h)) return true;
      return h.startsWith("rating_");
    });

    const extra = ratingCols
      .filter((h) => !core.includes(h))
      .sort((a, b) => a.localeCompare(b));

    return [...core, ...extra];
  }

  function prettifyRatingHeader(key) {
    if (key === "rating_overall") return "Ovr";
    if (key === "rating_pos") return "Pos Rt";

    let rest = key.replace(/^rating_/, "");
    if (!rest) return key;
    const parts = rest.split("_");

    // If it's all caps (e.g., CB, QB), just show raw
    const allUpper = parts.every((p) => p === p.toUpperCase());
    if (allUpper) return rest;

    return parts
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function buildTeamsFromRows(objs) {
    const byKey = new Map();

    for (const row of objs) {
      const teamId = String(row.team_id || "").trim();
      const teamName = String(row.team_name || "").trim();
      if (!teamId && !teamName) continue;

      const key = teamId || teamName;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          teamId,
          teamName,
          players: [],
        });
      }
      byKey.get(key).players.push(row);
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const nameA = a.teamName || a.teamId || "";
      const nameB = b.teamName || b.teamId || "";
      return nameA.localeCompare(nameB);
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering: team select + metadata
  // ---------------------------------------------------------------------------

  function renderTeamOptions(teams) {
    if (!dom.teamSelect) return;

    dom.teamSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a team…";
    dom.teamSelect.appendChild(placeholder);

    for (const team of teams) {
      const opt = document.createElement("option");
      const displayName = team.teamName || team.teamId || "(Unnamed)";
      const tag = team.teamId ? team.teamId : "";
      opt.value = team.key;
      opt.textContent = tag ? `${displayName} (${tag})` : displayName;
      dom.teamSelect.appendChild(opt);
    }

    dom.teamSelect.disabled = teams.length === 0;
  }

  function renderTeamMeta(team) {
    if (!dom.teamMeta) return;

    const players = team.players || [];
    if (!players.length) {
      dom.teamMeta.style.display = "none";
      dom.teamMeta.innerHTML = "";
      return;
    }

    const overalls = players
      .map((p) => Number(p.rating_overall))
      .filter((n) => Number.isFinite(n));

    const avgOvr =
      overalls.length > 0
        ? overalls.reduce((a, b) => a + b, 0) / overalls.length
        : null;
    const minOvr = overalls.length > 0 ? Math.min(...overalls) : null;
    const maxOvr = overalls.length > 0 ? Math.max(...overalls) : null;

    const posCounts = {};
    for (const p of players) {
      const pos = (p.position || "").toUpperCase();
      if (!pos) continue;
      posCounts[pos] = (posCounts[pos] || 0) + 1;
    }
    const posSummary = Object.entries(posCounts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pos, count]) => `${pos}×${count}`)
      .join(", ");

    const displayName = team.teamName || team.teamId || "(Unnamed)";
    const idLabel = team.teamId || "—";

    dom.teamMeta.style.display = "block";
    dom.teamMeta.innerHTML = `
      <div class="team-meta-top">
        <div class="team-meta-name-block">
          <div class="team-meta-name">${displayName}</div>
          <div class="team-meta-id">Team ID: ${idLabel}</div>
        </div>
        <div class="team-meta-stats">
          <div class="team-meta-stat">
            <div class="team-meta-stat-label">Players</div>
            <div class="team-meta-stat-value">${players.length}</div>
          </div>
          <div class="team-meta-stat">
            <div class="team-meta-stat-label">Avg overall</div>
            <div class="team-meta-stat-value">
              ${avgOvr != null ? formatRating(avgOvr) : "—"}
            </div>
          </div>
          <div class="team-meta-stat">
            <div class="team-meta-stat-label">Min / Max Ovr</div>
            <div class="team-meta-stat-value">
              ${
                minOvr != null && maxOvr != null
                  ? formatRating(minOvr) + " – " + formatRating(maxOvr)
                  : "—"
              }
            </div>
          </div>
        </div>
      </div>
      <div class="team-meta-positions">
        <strong>Position mix:</strong>
        ${posSummary || "No position data available."}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Rendering: groups & rating tables
  // ---------------------------------------------------------------------------

  function buildGroupsForTeam(players) {
    const map = new Map();

    for (const p of players) {
      const pos = (p.position || "").toUpperCase();
      const groupName = getPositionGroupLabel(pos);
      if (!map.has(groupName)) {
        map.set(groupName, []);
      }
      map.get(groupName).push(p);
    }

    let groups = Array.from(map.entries()).map(([name, groupPlayers]) => ({
      name,
      players: groupPlayers,
    }));

    // Sort players within each group: depth asc, then overall desc, then name
    for (const g of groups) {
      g.players.sort((a, b) => {
        const depthA = Number(a.depth);
        const depthB = Number(b.depth);

        if (Number.isFinite(depthA) && Number.isFinite(depthB)) {
          if (depthA !== depthB) return depthA - depthB;
        }

        const ovrA = Number(a.rating_overall);
        const ovrB = Number(b.rating_overall);
        if (Number.isFinite(ovrA) && Number.isFinite(ovrB) && ovrA !== ovrB) {
          return ovrB - ovrA;
        }

        const nameA = (a.last_name || "") + ", " + (a.first_name || "");
        const nameB = (b.last_name || "") + ", " + (b.first_name || "");
        return nameA.localeCompare(nameB);
      });
    }

    // Sort groups by GROUP_NAME_ORDER, then by name
    groups.sort((a, b) => {
      const idxA = GROUP_NAME_ORDER.indexOf(a.name);
      const idxB = GROUP_NAME_ORDER.indexOf(b.name);
      const normA = idxA === -1 ? GROUP_NAME_ORDER.length + 1 : idxA;
      const normB = idxB === -1 ? GROUP_NAME_ORDER.length + 1 : idxB;
      if (normA !== normB) return normA - normB;
      return a.name.localeCompare(b.name);
    });

    return groups;
  }

  function renderGroupsForTeam(team) {
    if (!dom.groupsContainer) return;

    const players = team.players || [];
    dom.groupsContainer.innerHTML = "";

    if (!players.length) {
      const empty = document.createElement("div");
      empty.textContent = "No players found for this team.";
      empty.style.fontSize = "13px";
      empty.style.color = "var(--text-soft)";
      dom.groupsContainer.appendChild(empty);
      return;
    }

    const groups = buildGroupsForTeam(players);

    for (const group of groups) {
      const card = document.createElement("section");
      card.className = "group-card";

      // Header
      const header = document.createElement("div");
      header.className = "group-header";

      const title = document.createElement("div");
      title.className = "group-title";
      title.textContent = group.name;

      const meta = document.createElement("div");
      meta.className = "group-meta";

      // Count pill
      const countPill = document.createElement("div");
      countPill.className = "group-meta-pill";
      const countLabel = group.players.length === 1 ? "player" : "players";
      countPill.innerHTML =
        "<strong>" + group.players.length + "</strong> " + countLabel;
      meta.appendChild(countPill);

      // OVR pill
      const ovrValues = group.players
        .map((p) => Number(p.rating_overall))
        .filter((n) => Number.isFinite(n));

      if (ovrValues.length) {
        const avg =
          ovrValues.reduce((a, b) => a + b, 0) / ovrValues.length;
        const range =
          formatRating(Math.min(...ovrValues)) +
          " – " +
          formatRating(Math.max(...ovrValues));
        const statPill = document.createElement("div");
        statPill.className = "group-meta-pill";
        statPill.innerHTML =
          "<strong>Ovr:</strong> " + formatRating(avg) + " avg; " + range;
        meta.appendChild(statPill);
      }

      header.appendChild(title);
      header.appendChild(meta);
      card.appendChild(header);

      // Table
      const wrapper = document.createElement("div");
      wrapper.className = "group-table-wrapper";

      const table = document.createElement("table");
      table.className = "group-table";

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");

      const baseCols = [
        { key: "position", label: "Pos" },
        { key: "depth", label: "Depth" },
        { key: "first_name", label: "First" },
        { key: "last_name", label: "Last" },
      ];

      for (const col of baseCols) {
        const th = document.createElement("th");
        th.textContent = col.label;
        headRow.appendChild(th);
      }

      for (const key of gAllRatingColumns) {
        const th = document.createElement("th");
        th.textContent = prettifyRatingHeader(key);
        headRow.appendChild(th);
      }

      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");

      for (const p of group.players) {
        const tr = document.createElement("tr");

        const posCell = document.createElement("td");
        posCell.textContent = (p.position || "").toUpperCase();
        posCell.className = "core";
        tr.appendChild(posCell);

        const depthCell = document.createElement("td");
        depthCell.textContent = p.depth || "";
        depthCell.className = "numeric";
        tr.appendChild(depthCell);

        const firstCell = document.createElement("td");
        firstCell.textContent = p.first_name || "";
        tr.appendChild(firstCell);

        const lastCell = document.createElement("td");
        lastCell.className = "name-cell";
        lastCell.textContent = p.last_name || "";
        if (p.primary_archetype) {
          const span = document.createElement("span");
          span.textContent = p.primary_archetype;
          lastCell.appendChild(span);
        }
        tr.appendChild(lastCell);

        for (const key of gAllRatingColumns) {
          const td = document.createElement("td");
          td.className = "numeric";
          td.textContent = formatRating(p[key]);
          tr.appendChild(td);
        }

        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      wrapper.appendChild(table);
      card.appendChild(wrapper);

      dom.groupsContainer.appendChild(card);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleTeamChange() {
    if (!dom.teamSelect) return;

    const key = dom.teamSelect.value;
    if (!key) {
      if (dom.clearTeamBtn) dom.clearTeamBtn.disabled = true;
      if (dom.groupsContainer) dom.groupsContainer.innerHTML = "";
      if (dom.teamMeta) {
        dom.teamMeta.style.display = "none";
        dom.teamMeta.innerHTML = "";
      }
      if (dom.summaryMain) {
        dom.summaryMain.textContent =
          "Select a team to view its full rating grid by position group.";
      }
      return;
    }

    if (dom.clearTeamBtn) dom.clearTeamBtn.disabled = false;

    const team = gTeams.find((t) => t.key === key);
    if (!team) return;

    renderTeamMeta(team);
    renderGroupsForTeam(team);

    const name = team.teamName || team.teamId || "(Unnamed)";
    if (dom.summaryMain) {
      dom.summaryMain.textContent =
        "Showing full rating grid for " +
        name +
        " – " +
        team.players.length +
        " players.";
    }
  }

  function handleClearTeam() {
    if (!dom.teamSelect) return;
    dom.teamSelect.value = "";
    handleTeamChange();
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async function initDashboard() {
    assertDomReady();
    hideError();
    setStatus("loading", "Loading team ratings…");

    // Wire back link (return to index.html, preserving ?players= if present)
    if (dom.backLink) {
      const baseForBack =
        "index.html" +
        (RAW_PLAYERS_PARAM
          ? "?players=" + encodeURIComponent(RAW_PLAYERS_PARAM)
          : "");
      dom.backLink.href = baseForBack;
    }

    if (dom.summarySource) {
      dom.summarySource.textContent =
        "Source: " +
        (RAW_PLAYERS_PARAM
          ? "players=" + RAW_PLAYERS_PARAM
          : "layer3_rosters.csv");
    }

    const tStart = performance.now();

    try {
      const { text, url } = await fetchCsvTextWithFallback(CSV_URLS);
      const tFetch = performance.now();

      const rows = parseCsvToRows(text);
      const objs = rowsToObjectsWithDedupHeader(rows);
      gAllRows = objs;
      gAllRatingColumns = computeRatingColumns(objs);
      gTeams = buildTeamsFromRows(objs);

      const tBuild = performance.now();

      renderTeamOptions(gTeams);

      const fetchMs = Math.round(tFetch - tStart);
      const buildMs = Math.round(tBuild - tFetch);

      if (dom.summaryMain) {
        dom.summaryMain.textContent =
          "Loaded " +
          gTeams.length +
          " teams and " +
          gAllRows.length +
          " player rows from " +
          url +
          " in " +
          fetchMs +
          " ms (parse + " +
          buildMs +
          " ms grouping). Pick a team to inspect.";
      }

      setStatus("ready", "Team ratings loaded");

      // Auto-select a team if ?team= is provided
      const initialKey = URL_PARAMS.get("team") || "";
      if (initialKey && dom.teamSelect) {
        const team = gTeams.find(
          (t) =>
            t.teamId === initialKey ||
            t.key === initialKey ||
            t.teamName === initialKey
        );
        if (team) {
          dom.teamSelect.value = team.key;
          handleTeamChange();
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[gm_dashboard] Failed to initialize:", err);
      showError(
        "Could not load or parse the roster CSV.",
        err && err.message ? err.message : String(err)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Wire events & run
  // ---------------------------------------------------------------------------

  function wireEvents() {
    if (dom.teamSelect) {
      dom.teamSelect.addEventListener("change", handleTeamChange);
    }
    if (dom.clearTeamBtn) {
      dom.clearTeamBtn.addEventListener("click", handleClearTeam);
    }
  }

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(() => {
    wireEvents();
    initDashboard();
  });
})();
