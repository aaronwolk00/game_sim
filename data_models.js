// data_models.js
// -----------------------------------------------------------------------------
// Domain models & data loading for the NFL-style simulation.
// This module is the bridge between your Layer2/Layer3 CSV-style data and the
// simulation engine (randomness models, micro-engine, and game loop).
//
// It knows about:
//   - Players (ratings, traits, factors, plus a slot for latent vectors)
//   - Teams (rosters, depth charts, rating snapshots)
//   - League container
//   - GameClock & GameState skeleton
//
// It does NOT:
//   - Decide how probabilities work (that belongs in the models / micro-engine)
//   - Simulate plays or drives (that belongs in game_engine.js)
//
// All exports are plain JS classes + helpers; everything is ES-module friendly.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/**
 * Safely parse a numeric field from a raw object.
 * Returns defaultValue if missing or NaN.
 */
 function toNumber(raw, key, defaultValue = 0) {
    if (!raw || raw[key] === undefined || raw[key] === null) return defaultValue;
    const v = Number(raw[key]);
    return Number.isFinite(v) ? v : defaultValue;
  }
  
  /**
   * Safely parse an integer field.
   */
  function toInt(raw, key, defaultValue = 0) {
    if (!raw || raw[key] === undefined || raw[key] === null) return defaultValue;
    const v = parseInt(raw[key], 10);
    return Number.isFinite(v) ? v : defaultValue;
  }
  
  /**
   * Safely parse a string field.
   */
  function toStr(raw, key, defaultValue = "") {
    if (!raw || raw[key] === undefined || raw[key] === null) return defaultValue;
    return String(raw[key]);
  }
  
  /**
   * Shallow clone of an object (so we never mutate original CSV rows).
   */
  function shallowClone(obj) {
    return Object.assign({}, obj);
  }
  
  // -----------------------------------------------------------------------------
  // Position & side-of-ball semantics
  // -----------------------------------------------------------------------------
  // These are intentionally minimal. The config/statistical modules can extend.
  // -----------------------------------------------------------------------------
  
  /**
   * Side-of-ball classification.
   * Used for routing players into units, not for ratings math directly.
   */
  export const SIDE = /** @type {const} */ ({
    OFFENSE: "OFFENSE",
    DEFENSE: "DEFENSE",
    SPECIAL: "SPECIAL",
  });
  
  /**
   * Map of primary position -> side of ball.
   * This is aligned with your Layer 2 / Layer 3 positions.
   */
  export const POSITION_SIDE = {
    QB: SIDE.OFFENSE,
    RB: SIDE.OFFENSE,
    WR: SIDE.OFFENSE,
    TE: SIDE.OFFENSE,
    FB: SIDE.OFFENSE,
    LT: SIDE.OFFENSE,
    LG: SIDE.OFFENSE,
    C: SIDE.OFFENSE,
    RG: SIDE.OFFENSE,
    RT: SIDE.OFFENSE,
  
    DT: SIDE.DEFENSE,
    EDGE: SIDE.DEFENSE,
    LB: SIDE.DEFENSE,
    CB: SIDE.DEFENSE,
    S: SIDE.DEFENSE,
  
    K: SIDE.SPECIAL,
    P: SIDE.SPECIAL,
  };
  
  /**
   * Convenience list of all primary positions in the sim.
   */
  export const ALL_POSITIONS = Object.freeze([
    "QB",
    "RB",
    "WR",
    "TE",
    "FB",
    "LT",
    "LG",
    "C",
    "RG",
    "RT",
    "DT",
    "EDGE",
    "LB",
    "CB",
    "S",
    "K",
    "P",
  ]);
  
  // -----------------------------------------------------------------------------
  // Latent profiles: A / C / T / P / V
  // -----------------------------------------------------------------------------
  // This is a *container*; the actual computation of these will generally live
  // in your "models" / randomness module so you can iterate on math independently.
  // -----------------------------------------------------------------------------
  
  /**
   * A single latent sub-vector (e.g. A, C, T, P, V).
   * Wrapped as a simple keyed numeric map.
   */
  export class LatentSubVector {
    /**
     * @param {Object.<string, number>} components
     */
    constructor(components = {}) {
      /** @type {Object.<string, number>} */
      this.components = { ...components };
    }
  
    get(name, fallback = 0) {
      const v = this.components[name];
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    }
  
    set(name, value) {
      this.components[name] = Number(value) || 0;
    }
  
    toJSON() {
      return shallowClone(this.components);
    }
  }
  
  /**
   * Full latent profile per player.
   * A = athletic, C = cognitive, T = technical, P = psyche, V = variance/context.
   */
  export class LatentProfile {
    constructor({
      A = {},
      C = {},
      T = {},
      P = {},
      V = {},
    } = {}) {
      /** @type {LatentSubVector} */
      this.A = A instanceof LatentSubVector ? A : new LatentSubVector(A);
      this.C = C instanceof LatentSubVector ? C : new LatentSubVector(C);
      this.T = T instanceof LatentSubVector ? T : new LatentSubVector(T);
      this.P = P instanceof LatentSubVector ? P : new LatentSubVector(P);
      this.V = V instanceof LatentSubVector ? V : new LatentSubVector(V);
    }
  
    /**
     * Convenience accessor:
     *    profile.get("A", "explosiveness", 0)
     */
    get(group, key, fallback = 0) {
      const vec = this[group];
      if (!vec || typeof vec.get !== "function") return fallback;
      return vec.get(key, fallback);
    }
  
    toJSON() {
      return {
        A: this.A.toJSON(),
        C: this.C.toJSON(),
        T: this.T.toJSON(),
        P: this.P.toJSON(),
        V: this.V.toJSON(),
      };
    }
  }
  
  // -----------------------------------------------------------------------------
  // Player model
  // -----------------------------------------------------------------------------
  // This wraps a single row from layer2 / layer3_rosters as a live simulation
  // object, with convenient access to core fields and trait/factor maps.
  // -----------------------------------------------------------------------------
  
  export class Player {
    /**
     * @param {Object} rawRow - One row from layer2_ratings or layer3_rosters.
     *                          Must at least have: id, position, rating_overall.
     *                          For layer3_rosters, also team_id, team_name, depth.
     */
    constructor(rawRow) {
      if (!rawRow) rawRow = {};
      /** Raw CSV/JSON backing object (never mutate this directly). */
      this.raw = shallowClone(rawRow);
  
      /** Unique player id as string. */
      this.id = toStr(rawRow, "id");
  
      /** Primary position, e.g. "QB", "WR", "DT". */
      this.position = toStr(rawRow, "position").toUpperCase();
  
      /** Overall 0-100 rating (already normalized by your Python pipeline). */
      this.ratingOverall = toNumber(rawRow, "rating_overall", 0);
  
      /**
       * Position-specific overall (if present).
       * For OL, this may be rating_OL_overall; for DB, rating_CB_overall / rating_S_overall, etc.
       */
      this.ratingPos = toNumber(rawRow, "rating_pos", this.ratingOverall);
  
      /** Optional human-readable name; if not present, we just use "Player <id>". */
      this.name =
        rawRow.name ||
        rawRow.player_name ||
        rawRow.full_name ||
        `Player ${this.id || "?"}`;
  
      /** Team ID + name (may be empty for pure Layer2 data without team assignment). */
      this.teamId = toStr(rawRow, "team_id", "");
      this.teamName = toStr(rawRow, "team_name", "");
  
      /** Depth on team at this position, e.g. 1=starter, 2=backup. 0 if unknown. */
      this.depth = toInt(rawRow, "depth", 0);
  
      /** Map of factor_* columns (0-10000-style) -> numeric 0..1. */
      this.factors = {};
      /** Map of trait_* columns (0-10000-style) -> numeric 0..1. */
      this.traits = {};
  
      /** Latent A/C/T/P/V profile – can be filled in later by the models module. */
      this.latent = new LatentProfile();
  
      /** Side of ball (OFFENSE/DEFENSE/SPECIAL) based on primary position. */
      this.side = POSITION_SIDE[this.position] || null;
  
      this._ingestFactorsAndTraits(rawRow);
    }
  
    _ingestFactorsAndTraits(rawRow) {
      for (const [key, val] of Object.entries(rawRow)) {
        if (key.startsWith("factor_")) {
          const v = Number(val);
          // assume 0..10000 or 0..100; normalize softly to 0..1
          const scaled =
            !Number.isFinite(v) ? 0 : v > 1000 ? v / 10000 : v / 100;
          this.factors[key.slice("factor_".length)] = Math.max(
            0,
            Math.min(1, scaled)
          );
        } else if (key.startsWith("trait_")) {
          const v = Number(val);
          const scaled =
            !Number.isFinite(v) ? 0 : v > 1000 ? v / 10000 : v / 100;
          this.traits[key.slice("trait_".length)] = Math.max(
            0,
            Math.min(1, scaled)
          );
        }
      }
    }
  
    // --- Convenience getters ---------------------------------------------------
  
    /**
     * Get a normalized factor in [0,1] by short name (e.g. "explosiveness").
     */
    getFactor(name, fallback = 0.5) {
      const v = this.factors[name];
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    }
  
    /**
     * Get a normalized trait in [0,1] by short name (e.g. "speed_20y").
     */
    getTrait(name, fallback = 0.5) {
      const v = this.traits[name];
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    }
  
    /**
     * Update team assignment (used when building teams from generic Layer2 data).
     */
    assignTeam(teamId, teamName, depth = 0) {
      this.teamId = teamId;
      this.teamName = teamName || teamId;
      this.depth = depth;
    }
  
    /**
     * Attach a latent profile (usually computed by the statistical models module).
     * @param {LatentProfile} profile
     */
    setLatentProfile(profile) {
      if (profile instanceof LatentProfile) {
        this.latent = profile;
      } else if (profile && typeof profile === "object") {
        this.latent = new LatentProfile(profile);
      }
    }
  
    /**
     * Minimal JSON representation for logs / UI.
     */
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        position: this.position,
        side: this.side,
        teamId: this.teamId,
        teamName: this.teamName,
        depth: this.depth,
        ratingOverall: this.ratingOverall,
        ratingPos: this.ratingPos,
      };
    }
  }
  
  // -----------------------------------------------------------------------------
  // Team model
  // -----------------------------------------------------------------------------
  
  export class Team {
    /**
     * @param {string} teamId
     * @param {string} teamName
     */
    constructor(teamId, teamName) {
      this.id = String(teamId);
      this.name = String(teamName || teamId);
  
      /** Flat roster list in no particular order. */
      this.roster = /** @type {Player[]} */ ([]);
  
      /** Depth charts by position: position -> Player[] sorted by depth then rating. */
      this.depthCharts = /** @type {Record<string, Player[]>} */ ({});
  
      /** Optional rating snapshot – usually filled in by the ratings module. */
      this.ratings = {
        offense: null,
        defense: null,
        special: null,
        overall: null,
      };
  
      /** Optional richer unit profiles, filled by later modules. */
      this.unitProfiles = {
        offense: null, // e.g. { pass: 0-100, run: 0-100, explosiveness: ... }
        defense: null, // e.g. { coverage: 0-100, passRush: 0-100, runFit: ... }
        special: null,
      };
    }
  
    /**
     * Add a player to this team and place them into the depth chart.
     * Depth is taken from player.depth if not provided.
     */
    addPlayer(player, explicitDepth = null) {
      if (!(player instanceof Player)) {
        throw new Error("Team.addPlayer expects a Player instance.");
      }
      const depth = explicitDepth != null ? explicitDepth : player.depth || 0;
  
      // Attach team info to player (in case player came from generic Layer2 data).
      player.assignTeam(this.id, this.name, depth);
  
      this.roster.push(player);
  
      const pos = player.position;
      if (!this.depthCharts[pos]) {
        this.depthCharts[pos] = [];
      }
      this.depthCharts[pos].push(player);
  
      // Keep the depth chart sorted: 1,2,3,... then by rating desc.
      this.depthCharts[pos].sort((a, b) => {
        const da = a.depth || 999;
        const db = b.depth || 999;
        if (da !== db) return da - db;
        return b.ratingOverall - a.ratingOverall;
      });
    }
  
    /**
     * Get depth chart for a position; always returns an array (possibly empty).
     */
    getDepthChart(position) {
      return this.depthCharts[position] || [];
    }
  
    /**
     * Return the "starter" at a position (depth === 1) if any.
     */
    getStarter(position) {
      const list = this.getDepthChart(position);
      if (!list.length) return null;
      // Ensure sorted by depth then rating.
      return list[0];
    }
  
    /**
     * Set a rating snapshot for this team.
     * Usually called from the ratings / models module.
     */
    setRatings({ offense, defense, special, overall }) {
      this.ratings = {
        offense: offense ?? this.ratings.offense,
        defense: defense ?? this.ratings.defense,
        special: special ?? this.ratings.special,
        overall: overall ?? this.ratings.overall,
      };
    }
  
    /**
     * Set richer unit profiles, like pass/run splits, coverage strength, etc.
     */
    setUnitProfiles({ offense, defense, special }) {
      if (offense) this.unitProfiles.offense = offense;
      if (defense) this.unitProfiles.defense = defense;
      if (special) this.unitProfiles.special = special;
    }
  
    /**
     * Simple summary for UI / debugging.
     */
    summary() {
      return {
        id: this.id,
        name: this.name,
        rosterSize: this.roster.length,
        ratings: this.ratings,
      };
    }
  
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        ratings: this.ratings,
      };
    }
  }
  
  // -----------------------------------------------------------------------------
  // League container
  // -----------------------------------------------------------------------------
  
  export class League {
    /**
     * @param {Team[]} teams
     */
    constructor(teams = []) {
      /** @type {Map<string, Team>} */
      this.teamsById = new Map();
      /** @type {Map<string, Player>} */
      this.playersById = new Map();
  
      for (const t of teams) {
        this.addTeam(t);
      }
    }
  
    addTeam(team) {
      if (!(team instanceof Team)) {
        throw new Error("League.addTeam expects a Team instance.");
      }
      this.teamsById.set(team.id, team);
      for (const p of team.roster) {
        this.playersById.set(p.id, p);
      }
    }
  
    getTeam(teamId) {
      return this.teamsById.get(teamId) || null;
    }
  
    getPlayer(playerId) {
      return this.playersById.get(playerId) || null;
    }
  
    listTeams() {
      return Array.from(this.teamsById.values());
    }
  
    /**
     * Basic position count diagnostics across the league.
     */
    getPositionCounts() {
      const counts = {};
      for (const team of this.teamsById.values()) {
        for (const player of team.roster) {
          const pos = player.position;
          counts[pos] = (counts[pos] || 0) + 1;
        }
      }
      return counts;
    }
  }
  
  // -----------------------------------------------------------------------------
  // GameClock & GameState skeleton
  // -----------------------------------------------------------------------------
  // These are intentionally light. The game engine module will drive them.
  // -----------------------------------------------------------------------------
  
  export class GameClock {
    constructor({
      quarter = 1,
      secondsRemaining = 15 * 60, // per quarter
      running = false,
    } = {}) {
      this.quarter = quarter;
      this.secondsRemaining = secondsRemaining;
      this.running = running;
    }
  
    clone() {
      return new GameClock({
        quarter: this.quarter,
        secondsRemaining: this.secondsRemaining,
        running: this.running,
      });
    }
  }
  
  export class GameState {
    /**
     * @param {Object} opts
     * @param {League} opts.league
     * @param {Team} opts.homeTeam
     * @param {Team} opts.awayTeam
     */
    constructor({ league, homeTeam, awayTeam }) {
      this.league = league;
      this.homeTeam = homeTeam;
      this.awayTeam = awayTeam;
  
      // basic scoreboard
      this.score = {
        home: 0,
        away: 0,
      };
  
      // possession: "home" or "away"
      this.possession = "home";
  
      // field state
      this.ballOnYardline = 25; // 25 = own 25 (we'll define a convention in the game engine)
      this.down = 1;
      this.distance = 10;
  
      // quarter & clock
      this.clock = new GameClock();
  
      // logs
      this.plays = []; // each element will be a play result object
      this.drives = []; // each element will be a drive summary
  
      // simple flags
      this.isFinal = false;
    }
  
    /**
     * Swap possession between home and away.
     */
    switchPossession() {
      this.possession = this.possession === "home" ? "away" : "home";
    }
  
    /**
     * Get the Team object currently on offense.
     */
    getOffenseTeam() {
      return this.possession === "home" ? this.homeTeam : this.awayTeam;
    }
  
    /**
     * Get the Team object currently on defense.
     */
    getDefenseTeam() {
      return this.possession === "home" ? this.awayTeam : this.homeTeam;
    }
  
    /**
     * Record a play result into the log.
     * The game engine will decide the shape of `playResult` objects.
     */
    logPlay(playResult) {
      this.plays.push(playResult);
    }
  
    toJSON() {
      return {
        homeTeam: this.homeTeam.summary(),
        awayTeam: this.awayTeam.summary(),
        score: this.score,
        possession: this.possession,
        ballOnYardline: this.ballOnYardline,
        down: this.down,
        distance: this.distance,
        clock: {
          quarter: this.clock.quarter,
          secondsRemaining: this.clock.secondsRemaining,
        },
        isFinal: this.isFinal,
      };
    }
  }
  
  // -----------------------------------------------------------------------------
  // Data loading from Layer3-style rosters
  // -----------------------------------------------------------------------------
  // We assume you've already parsed CSV into an array of plain JS objects where
  // each row looks like a line from layer3_rosters.csv.
  // -----------------------------------------------------------------------------
  
  /**
   * Build a full League (teams + players) from rows that look like layer3_rosters.csv.
   *
   * Each row is expected to contain at least:
   *   - team_id, team_name
   *   - position
   *   - depth
   *   - id
   *   - rating_overall
   *   - rating_pos
   * plus all the Layer2 factor_* and trait_* columns.
   *
   * @param {Object[]} rows
   * @param {Object} [options]
   * @param {boolean} [options.attachLatentPlaceholders=true] - If true, we attach
   *        empty LatentProfiles so later modules can just fill them in.
   * @returns {{ league: League, teams: Team[], playersById: Map<string, Player> }}
   */
  export function buildLeagueFromRosterRows(
    rows,
    { attachLatentPlaceholders = true } = {}
  ) {
    /** @type {Map<string, Team>} */
    const teamsById = new Map();
    /** @type {Map<string, Player>} */
    const playersById = new Map();
  
    if (!Array.isArray(rows)) {
      throw new Error("buildLeagueFromRosterRows expects an array of row objects.");
    }
  
    for (const row of rows) {
      const teamId = toStr(row, "team_id");
      const teamName = toStr(row, "team_name", teamId || "Unknown Team");
  
      if (!teamId) {
        // You *could* support no-team data, but for layer3 it's expected.
        // For now we just skip rows without a team_id.
        // You can relax this later if needed.
        continue;
      }
  
      let team = teamsById.get(teamId);
      if (!team) {
        team = new Team(teamId, teamName);
        teamsById.set(teamId, team);
      }
  
      const player = new Player(row);
      if (attachLatentPlaceholders && !player.latent) {
        player.setLatentProfile(new LatentProfile());
      }
  
      // Depth is already baked into the row (from layer3).
      team.addPlayer(player, player.depth);
  
      if (player.id) {
        playersById.set(player.id, player);
      }
    }
  
    const teams = Array.from(teamsById.values());
    const league = new League(teams);
  
    return { league, teams, playersById };
  }
  
  /**
   * Lightweight league diagnostics (for wiring / sanity checks).
   * Returns summary stats, does not print directly.
   */
  export function summarizeLeague(league) {
    const teams = league.listTeams();
    const teamSummaries = teams.map((t) => t.summary());
    const posCounts = league.getPositionCounts();
  
    const numTeams = teams.length;
    const numPlayers = Array.from(league.playersById.values()).length;
  
    return {
      numTeams,
      numPlayers,
      positionCounts: posCounts,
      teams: teamSummaries,
    };
  }
  