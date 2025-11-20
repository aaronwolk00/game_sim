// data_models.js
// -----------------------------------------------------------------------------
// Data & domain models wired to layer3_rosters.csv
//
// Exports:
//   - ALL_POSITIONS (array of string)
//   - LatentSubVector, LatentProfile
//   - Player, Team, League
//   - buildLeagueFromLayer3Csv(text) -> League
//   - loadLeague(url?) -> Promise<League>
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
function toNumber(v, fallback = 0) {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  
  function scale01From100(v) {
    return toNumber(v) / 100; // ratings like 93.0
  }
  
  function scale01From10000(v) {
    return toNumber(v) / 10000; // seeds / factors like ~7000–9000
  }
  
  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const item of arr) {
      const key = keyFn(item);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(item);
    }
    return m;
  }
  
  // -----------------------------------------------------------------------------
  // Position constants (used across pipeline)
  // -----------------------------------------------------------------------------
  export const ALL_POSITIONS = [
    // offense
    "QB", "RB", "FB", "WR", "TE",
    "LT", "LG", "C", "RG", "RT",
    // defense
    "DT", "EDGE", "LB", "CB", "S",
    // specialists
    "K", "P",
  ];
  
  // -----------------------------------------------------------------------------
  // Latent vector containers expected by random_models.js
  // -----------------------------------------------------------------------------
  export class LatentSubVector {
    constructor(entries = {}) {
      this._ = { ...entries };
    }
    get(key, fallback = 0.5) {
      const v = this._[key];
      return Number.isFinite(v) ? v : fallback;
    }
    set(key, value) {
      this._[key] = value;
    }
    toJSON() {
      return { ...this._ };
    }
  }
  
  export class LatentProfile {
    constructor({ A = {}, C = {}, T = {}, P = {}, V = {} } = {}) {
      // Ensure each group is a LatentSubVector
      this.A = A instanceof LatentSubVector ? A : new LatentSubVector(A);
      this.C = C instanceof LatentSubVector ? C : new LatentSubVector(C);
      this.T = T instanceof LatentSubVector ? T : new LatentSubVector(T);
      this.P = P instanceof LatentSubVector ? P : new LatentSubVector(P);
      this.V = V instanceof LatentSubVector ? V : new LatentSubVector(V);
    }
    // Convenience: profile.get("A","explosiveness", 0.5)
    get(group, key, fallback = 0.5) {
      const g = this[group];
      if (!g || typeof g.get !== "function") return fallback;
      return g.get(key, fallback);
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
  export class Player {
    constructor(rawRow) {
      this.raw = rawRow; // keep full row for debugging
  
      // Core identity
      this.teamId = rawRow.team_id;
      this.teamName = rawRow.team_name;
      this.position = rawRow.position;
      this.depth = toNumber(rawRow.depth, 1);
  
      // Prefer the first id column as playerId
      this.playerId = rawRow.id_0 ?? rawRow.id;
      this.firstName = rawRow.first_name;
      this.lastName = rawRow.last_name;
      this.displayName = `${this.firstName} ${this.lastName}`;
  
      // Overall ratings
      this.ratingOverall = toNumber(rawRow.rating_overall);
      this.ratingPos = toNumber(rawRow.rating_pos);
  
      // Build structured views
      this.seeds = this._buildSeeds(rawRow);
  
      // Build factor/trait lookups first so getFactor/getTrait work before latent overrides
      this.factors = this._buildFactors(rawRow);
      this.traits = this._buildTraits(rawRow);
  
      // Initial latent profile (will typically be replaced by random_models)
      this.latent = this._buildInitialLatent(rawRow);
  
      // Position-specific ratings bucket
      this.positionRatings = this._buildPositionRatings(rawRow);
    }
  
    _buildSeeds(row) {
      return {
        phys:      scale01From10000(row.phys_seed),
        cog:       scale01From10000(row.cog_seed),
        drive:     scale01From10000(row.drive_seed),
        stability: scale01From10000(row.stability_seed),
        social:    scale01From10000(row.social_seed),
        chaos:     scale01From10000(row.chaos_seed),
        env:       scale01From10000(row.env_seed),
      };
    }
  
    _buildFactors(row) {
      // Map both with and without the "factor_" prefix for convenience
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith("factor_")) {
          const name = k.slice("factor_".length);
          out[k] = scale01From10000(v);
          out[name] = scale01From10000(v);
        }
      }
      return out;
    }
  
    _buildTraits(row) {
      // Map both with and without the "trait_" prefix for convenience
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith("trait_")) {
          const name = k.slice("trait_".length);
          out[k] = scale01From10000(v);
          out[name] = scale01From10000(v);
        }
      }
      return out;
    }
  
    _buildInitialLatent(row) {
      // Athletic (A)
      const A = new LatentSubVector({
        explosiveness:        scale01From10000(row.factor_explosiveness),
        topSpeed:             scale01From10000(row.factor_top_speed),
        changeOfDirection:    scale01From10000(row.factor_change_of_direction),
        playStrength:         scale01From10000(row.factor_play_strength),
        durability:           scale01From10000(row.factor_durability),
  
        speedShort:           scale01From10000(row.trait_speed_5y),
        speedLong:            scale01From10000(row.trait_long_speed_reserve),
        agility:              scale01From10000(row.trait_short_area_quickness),
        power:                scale01From10000(row.trait_functional_strength_run),
        balance:              scale01From10000(row.trait_balance_control),
      });
  
      // Cognitive (C)
      const C = new LatentSubVector({
        decisionSpeed:        scale01From10000(row.factor_decision_speed),
        patternIQ:            scale01From10000(row.factor_pattern_iq),
        discipline:           scale01From10000(row.factor_discipline),
  
        motorLearning:        scale01From10000(row.factor_motor_learning_factor),
        processingSpeed:      scale01From10000(row.processing_speed),
        workingMemory:        scale01From10000(row.working_memory),
        patternRecognition:   scale01From10000(row.pattern_recognition),
        spatialReasoning:     scale01From10000(row.spatial_reasoning),
        attentionalControl:   scale01From10000(row.attentional_control),
        abstractLearningRate: scale01From10000(row.abstract_learning_rate),
      });
  
      // Technical (T)
      const T = new LatentSubVector({
        routeCraft:           scale01From10000(row.trait_route_deception),
        hands:                scale01From10000(row.trait_catch_hand_reliability),
        contestedCatch:       scale01From10000(row.trait_contested_catch_skill),
        pocketNavigation:     scale01From10000(row.trait_pocket_navigation),
        qbUnderPressure:      scale01From10000(row.trait_throwing_under_duress),
        qbOffScript:          scale01From10000(row.trait_off_script_playmaking),
        readProgression:      scale01From10000(row.trait_read_progression_speed),
        zoneCoverageInstincts:scale01From10000(row.trait_zone_coverage_instincts),
        manCoverageMirroring: scale01From10000(row.trait_man_coverage_mirroring),
        ballSkillsDB:         scale01From10000(row.trait_ball_skills_db),
        tackling:             scale01From10000(row.trait_open_field_tackling),
        blockingRunPOA:       scale01From10000(row.trait_blocking_run_point_of_attack),
        passProTechnique:     scale01From10000(row.trait_pass_pro_technique),
        visionBetweenTackles: scale01From10000(row.trait_vision_between_tackles),
        screenVision:         scale01From10000(row.trait_screen_vision),
        ballSecurity:         scale01From10000(row.trait_ball_security),
      });
  
      // Psyche (P)
      const P = new LatentSubVector({
        conscientiousness: scale01From10000(row.conscientiousness),
        grit:              scale01From10000(row.grit),
        riskTolerance:     scale01From10000(row.risk_tolerance),
        competitiveness:   scale01From10000(row.competitiveness),
        aggression:        scale01From10000(row.aggression),
        emotionalStability:scale01From10000(row.emotional_stability),
        impulsivity:       scale01From10000(row.impulsivity),
        sociability:       scale01From10000(row.sociability),
        leadershipDrive:   scale01From10000(row.leadership_drive),
        ruleOrientation:   scale01From10000(row.rule_orientation),
        creativity:        scale01From10000(row.creativity),
      });
  
      // Variance / environment (V)
      const V = new LatentSubVector({
        chaosSeed:          this.seeds?.chaos,
        stabilitySeed:      this.seeds?.stability,
        childhoodSES:       scale01From10000(row.childhood_ses),
        childhoodNutrition: scale01From10000(row.childhood_nutrition),
        sportsAccess:       scale01From10000(row.sports_access),
        academicAccess:     scale01From10000(row.academic_access),
        parentalSupport:    scale01From10000(row.parental_support),
        neighborhoodSafety: scale01From10000(row.neighborhood_safety),
        earlyPhysicalLabor: scale01From10000(row.early_physical_labor),
        earlyTrauma:        scale01From10000(row.early_trauma),
        // place-holders; random_models will replace with gameSigma / playSigma
        gameSigma:          0.06,
        playSigma:          0.18,
      });
  
      return new LatentProfile({ A, C, T, P, V });
    }
  
    _buildPositionRatings(row) {
      const ratings = {};
      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith("rating_")) {
          ratings[key] = toNumber(value);
        }
      }
      return ratings;
    }
  
    // ---- API expected by random_models.js & game_engine.js ----
    getFactor(name, fallback = 0.5) {
      const v = this.factors?.[name];
      return Number.isFinite(v) ? v : fallback;
    }
  
    getTrait(name, fallback = 0.5) {
      const v = this.traits?.[name];
      return Number.isFinite(v) ? v : fallback;
    }
  
    setLatentProfile(profile) {
      if (profile instanceof LatentProfile) {
        this.latent = profile;
      }
    }
  }
  
  // -----------------------------------------------------------------------------
  // Team model
  // -----------------------------------------------------------------------------
  export class Team {
    constructor(teamId, teamName, players) {
      this.teamId = teamId;
      this.teamName = teamName;
      this.roster = players.slice().sort((a, b) => a.depth - b.depth);
  
      this.depthChart = this._buildDepthChart();
      this.unitProfiles = this._buildUnitProfiles(); // baseline; can be overwritten
    }
  
    _buildDepthChart() {
      const chart = {};
      for (const p of this.roster) {
        if (!chart[p.position]) chart[p.position] = [];
        chart[p.position].push(p);
      }
      // Ensure sorted by depth
      for (const pos of Object.keys(chart)) {
        chart[pos].sort((a, b) => a.depth - b.depth);
      }
      return chart;
    }
  
    getPlayersByPosition(pos) {
      return this.depthChart[pos] ?? [];
    }
  
    // Compatibility alias used by random_models.js
    getDepthChart(pos) {
      return this.getPlayersByPosition(pos);
    }
  
    getStarter(pos) {
      const arr = this.getPlayersByPosition(pos);
      return arr.length ? arr[0] : null;
    }
  
    _meanRating(players, key) {
      const vals = players
        .map((p) => p.positionRatings[key])
        .filter((v) => Number.isFinite(v));
      if (!vals.length) return 50; // neutral-ish baseline
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  
    _buildUnitProfiles() {
      // Group by positions
      const QBs  = this.getPlayersByPosition("QB");
      const RBs  = this.getPlayersByPosition("RB");
      const WRs  = this.getPlayersByPosition("WR");
      const TEs  = this.getPlayersByPosition("TE");
      const FBs  = this.getPlayersByPosition("FB");
      const OTs  = [...this.getPlayersByPosition("LT"), ...this.getPlayersByPosition("RT")];
      const OGs  = [...this.getPlayersByPosition("LG"), ...this.getPlayersByPosition("RG")];
      const Cs   = this.getPlayersByPosition("C");
  
      const DTs   = this.getPlayersByPosition("DT");
      const EDGEs = this.getPlayersByPosition("EDGE");
      const LBs   = this.getPlayersByPosition("LB");
      const CBs   = this.getPlayersByPosition("CB");
      const Ss    = this.getPlayersByPosition("S");
  
      const Ks = this.getPlayersByPosition("K");
      const Ps = this.getPlayersByPosition("P");
  
      // Offense: pass / run profiles (same math you had)
      const qbPass       = this._meanRating(QBs,  "rating_QB_overall");
      const qbProcessing = this._meanRating(QBs,  "rating_QB_processing");
      const qbRisk       = this._meanRating(QBs,  "rating_QB_risk_taking");
  
      const wrHands = this._meanRating(WRs, "rating_WR_hands");
      const wrRoute = this._meanRating(WRs, "rating_WR_route");
  
      const teHands = this._meanRating(TEs, "rating_TE_hands");
      const teRoute = this._meanRating(TEs, "rating_TE_route");
  
      const rbRun        = this._meanRating(RBs, "rating_RB_overall");
      const rbInside     = this._meanRating(RBs, "rating_RB_runner_inside");
      const rbReceiving  = this._meanRating(RBs, "rating_RB_receiving");
      const fbLead       = this._meanRating(FBs, "rating_FB_lead_block");
  
      const olPass       = this._meanRating([...OTs, ...OGs, ...Cs], "rating_OL_pass_block");
      const olRun        = this._meanRating([...OTs, ...OGs, ...Cs], "rating_OL_run_block");
      const olMental     = this._meanRating([...OTs, ...OGs, ...Cs], "rating_OL_mental");
  
      const offense = {
        pass: {
          overall:
            0.40 * qbPass +
            0.20 * qbProcessing +
            0.10 * qbRisk +
            0.15 * wrHands +
            0.10 * wrRoute +
            0.05 * teHands,
          qbPass, qbProcessing, qbRisk,
          wrHands, wrRoute,
          teHands, teRoute,
          olPass,
        },
        run: {
          overall:
            0.35 * rbRun +
            0.15 * rbInside +
            0.10 * rbReceiving +
            0.10 * fbLead +
            0.30 * olRun,
          rbRun, rbInside, rbReceiving,
          fbLead, olRun, olMental,
        },
      };
  
      // Defense: coverage / run fit / pass rush
      const cbCoverage = this._meanRating(CBs,  "rating_CB_coverage_man");
      const cbZone     = this._meanRating(CBs,  "rating_CB_coverage_zone");
      const cbSpeed    = this._meanRating(CBs,  "rating_CB_speed");
  
      const sCoverage  = this._meanRating(Ss,   "rating_S_coverage");
      const sDeepRange = this._meanRating(Ss,   "rating_S_deep_range");
      const sSpeed     = this._meanRating(Ss,   "rating_S_speed");
  
      const lbCoverage = this._meanRating(LBs,  "rating_LB_coverage");
  
      const dtRun       = this._meanRating(DTs,   "rating_DT_run_def");
      const edgeRun     = this._meanRating(EDGEs, "rating_EDGE_run_def");
      const lbRun       = this._meanRating(LBs,   "rating_LB_run_def");
      const sRunSupport = this._meanRating(Ss,    "rating_S_run_support");
      const cbRunSupport= this._meanRating(CBs,   "rating_CB_run_support");
  
      const dtRush   = this._meanRating(DTs,   "rating_DT_pass_rush");
      const edgeRush = this._meanRating(EDGEs, "rating_EDGE_pass_rush");
      const lbBlitz  = this._meanRating(LBs,   "rating_LB_blitz");
  
      const defense = {
        coverage: {
          overall:
            0.35 * cbCoverage +
            0.15 * cbZone +
            0.20 * sCoverage +
            0.10 * sDeepRange +
            0.10 * lbCoverage +
            0.10 * Math.max(cbSpeed, sSpeed),
          cbCoverage, cbZone, sCoverage, sDeepRange, lbCoverage, cbSpeed, sSpeed,
        },
        runFit: {
          overall:
            0.30 * dtRun +
            0.25 * edgeRun +
            0.25 * lbRun +
            0.10 * sRunSupport +
            0.10 * cbRunSupport,
          dtRun, edgeRun, lbRun, sRunSupport, cbRunSupport,
        },
        passRush: {
          overall: 0.40 * edgeRush + 0.35 * dtRush + 0.25 * lbBlitz,
          dtRush, edgeRush, lbBlitz,
        },
      };
  
      // Special teams
      const kAcc     = this._meanRating(Ks, "rating_K_accuracy");
      const kPow     = this._meanRating(Ks, "rating_K_power");
      const kOverall = this._meanRating(Ks, "rating_K_overall");
  
      const pControl   = this._meanRating(Ps, "rating_P_control");
      const pFieldFlip = this._meanRating(Ps, "rating_P_field_flip");
      const pOverall   = this._meanRating(Ps, "rating_P_overall");
  
      const cbST    = this._meanRating(CBs, "rating_CB_special_teams");
      const lbST    = this._meanRating(LBs, "rating_LB_special_teams");
      const sST     = this._meanRating(Ss,  "rating_S_special_teams");
      const wrST    = this._meanRating(WRs, "rating_WR_special_teams");
      const rbReturn= this._meanRating(RBs, "rating_RB_return");
  
      const special = {
        kicking: {
          overall: 0.5 * kAcc + 0.5 * kPow,
          accuracy: kAcc,
          power: kPow,
          kOverall,
        },
        punting: {
          overall: 0.5 * pControl + 0.5 * pFieldFlip,
          control: pControl,
          fieldFlip: pFieldFlip,
          pOverall,
        },
        coverage: 0.35 * cbST + 0.35 * lbST + 0.30 * sST,
        returner: 0.5 * wrST + 0.3 * rbReturn + 0.2 * sST,
      };
  
      return { offense, defense, special };
    }
  
    // Allow random_models to overwrite unit profiles with its computed flavor
    setUnitProfiles(u) {
      if (u && u.offense && u.defense && u.special) {
        this.unitProfiles = u;
      }
    }
  }
  
  // -----------------------------------------------------------------------------
  // League model (wrapper used by random_models.js for iteration)
  // -----------------------------------------------------------------------------
  export class League {
    constructor(teams = [], playersById = new Map()) {
      this.teams = teams;
      this.playersById = playersById;
  
      // Handy map & lookups
      this.teamsById = new Map(teams.map(t => [t.teamId, t]));
    }
  
    listTeams() {
      return this.teams.slice();
    }
  
    getTeamById(teamId) {
      return this.teamsById.get(teamId) || null;
    }
  
    getPlayerById(playerId) {
      return this.playersById.get(String(playerId)) || null;
    }
  }
  
  // -----------------------------------------------------------------------------
  // CSV parsing & league builder
  // -----------------------------------------------------------------------------
  function parseCsv(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  
    if (!lines.length) return [];
  
    const headerParts = lines[0].split(",");
    // Handle duplicate column names (like 'id' appears twice)
    const headers = [];
    const nameCounts = {};
    for (const h of headerParts) {
      const base = h.trim();
      const count = nameCounts[base] ?? 0;
      const name = count === 0 ? base : `${base}_${count}`;
      nameCounts[base] = count + 1;
      headers.push(name);
    }
  
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length === 1 && parts[0] === "") continue;
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = parts[j] ?? "";
      }
      rows.push(row);
    }
    return rows;
  }
  
  /**
   * Build a League from layer3_rosters.csv text.
   */
  export function buildLeagueFromLayer3Csv(csvText) {
    const rawRows = parseCsv(csvText);
    const players = rawRows.map((row) => new Player(row));
  
    const teamsMap = groupBy(players, (p) => p.teamId);
    const teams = [];
  
    for (const [teamId, teamPlayers] of teamsMap.entries()) {
      const teamName = teamPlayers[0]?.teamName ?? teamId;
      teams.push(new Team(teamId, teamName, teamPlayers));
    }
  
    const playersById = new Map();
    for (const p of players) {
      if (p.playerId != null) {
        playersById.set(String(p.playerId), p);
      }
    }
  
    // Return a League instance (still exposes .teams and .playersById for legacy code)
    return new League(teams, playersById);
  }
  
  /**
   * Convenience loader for browser usage.
   * Assumes layer3_rosters.csv is served next to simulation.html OR at your default URL.
   *
   * Example:
   *   import { loadLeague } from "./data_models.js";
   *   const league = await loadLeague("./layer3_rosters.csv");
   *   // Back-compat: const { teams } = await loadLeague(...); still works.
   */
  export async function loadLeague(
    csvUrl = "https://raw.githubusercontent.com/aaronwolk00/game_sim/main/layer3_rosters.csv"
  ) {
    const res = await fetch(csvUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${csvUrl}: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return buildLeagueFromLayer3Csv(text);
  }
  