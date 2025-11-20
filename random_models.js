// random_models.js
// -----------------------------------------------------------------------------
// Randomness & Statistical Models
//
// This module provides:
//   - Seeded RNG and stream splitting
//   - Latent profile computation (A / C / T / P / V) from Layer2-style data
//   - Team unit profiles (offense, defense, special) built from rosters
//   - Layered variance: player form, team form, momentum hooks
//
// It does NOT simulate plays – that's for micro_engine.js / game_engine.js.
// -----------------------------------------------------------------------------

import {
    LatentProfile,
    LatentSubVector,
    Player,
    Team,
    League,
  } from "./data_models.js";
  
  // -----------------------------------------------------------------------------
  // RNG implementation & stream splitting
  // -----------------------------------------------------------------------------
  // We use a simple PCG-ish generator for reproducible uniform[0,1) draws,
  // and then derive normals etc. on top. You can swap this out later if needed.
  // -----------------------------------------------------------------------------
  
  export class Rng {
    constructor(seed = 1) {
      // Force into Uint32
      this._state = (seed >>> 0) || 1;
    }
  
    _nextUint32() {
      // xorshift32
      let x = this._state;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this._state = x >>> 0;
      return this._state;
    }
  
    next() {
      // uniform in [0,1)
      return this._nextUint32() / 0xffffffff;
    }
  
    /**
     * Normal(0,1) via Box–Muller.
     */
    nextNormal() {
      let u = 0;
      let v = 0;
      while (u === 0) u = this.next();
      while (v === 0) v = this.next();
      const mag = Math.sqrt(-2.0 * Math.log(u));
      const z = mag * Math.cos(2 * Math.PI * v);
      return z;
    }
  
    /**
     * Normal(mu, sigma).
     */
    normal(mu = 0, sigma = 1) {
      return mu + sigma * this.nextNormal();
    }
  
    /**
     * Return a derived RNG with a new seed based on this RNG's stream.
     */
    fork(tag = 0) {
      const bump = this._nextUint32() ^ (hashString(String(tag)) >>> 0);
      return new Rng(bump || 1);
    }
  }
  
  // Simple hash for fork tags.
  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  
  export function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  
  export function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  
  export function logistic(x) {
    return 1 / (1 + Math.exp(-x));
  }
  
  export function logit(p) {
    const eps = 1e-9;
    const v = clamp01(p);
    return Math.log((v + eps) / (1 - v + eps));
  }
  
  /**
   * Convenience: build named RNG streams from a single seed.
   */
  export function buildRngStreams(seed = 2025) {
    const core = new Rng(seed);
    return {
      core,
      // For long-lived state:
      playerForm: core.fork("playerForm"),
      gameContext: core.fork("gameContext"),
      drive: core.fork("drive"),
      play: core.fork("play"),
      env: core.fork("env"),
    };
  }
  
  // -----------------------------------------------------------------------------
  // Latent profile computation (A/C/T/P/V)
  // -----------------------------------------------------------------------------
  // We map your Layer2 "factor_*" and "trait_*" metrics (already 0..1 in
  // Player.factors/traits) into a set of latent vectors. This mapping is
  // intentionally simple and transparent so you can tune later.
  // -----------------------------------------------------------------------------
  
  // Helper to pull normalized factor/trait with fallback.
  function F(player, name, fallback = 0.5) {
    return player.getFactor(name, fallback);
  }
  function T(player, name, fallback = 0.5) {
    return player.getTrait(name, fallback);
  }
  
  /**
   * Compute the Athletic (A) latent vector for a player.
   * Values are 0..1, built from factors + key traits.
   */
  function computeAthleticLatent(player) {
    const expl = F(player, "explosiveness", 0.5);
    const topSpeed = F(player, "top_speed", 0.5);
    const cod = F(player, "change_of_direction", 0.5);
    const strength = F(player, "play_strength", 0.5);
    const durability = F(player, "durability", 0.5);
  
    const speed5 = T(player, "speed_5y", expl);
    const speed10 = T(player, "speed_10y", expl);
    const speed20 = T(player, "speed_20y", topSpeed);
    const burst = T(player, "burst_accel", expl);
    const longReserve = T(player, "long_speed_reserve", topSpeed);
    const shortQuick = T(player, "short_area_quickness", cod);
    const longMob = T(player, "long_area_mobility", cod);
    const funcRun = T(player, "functional_strength_run", strength);
    const funcPass = T(player, "functional_strength_pass", strength);
    const anchor = T(player, "anchor_strength", strength);
    const balance = T(player, "balance_control", cod);
  
    const A = {
      explosiveness: expl,
      topSpeed,
      changeOfDirection: cod,
      strength,
      durability,
      speedShort: (speed5 + speed10 + burst) / 3,
      speedLong: (speed20 + longReserve + longMob) / 3,
      agility: (shortQuick + cod + longMob) / 3,
      power: (funcRun + funcPass + anchor) / 3,
      balance,
    };
  
    return new LatentSubVector(A);
  }
  
  /**
   * Compute the Cognitive (C) latent vector.
   */
  function computeCognitiveLatent(player) {
    const decision = F(player, "decision_speed", 0.5);
    const pattern = F(player, "pattern_iq", 0.5);
    const discipline = F(player, "discipline", 0.5);
    const motor = F(player, "motor_learning_factor", 0.5);
  
    const readProg = T(player, "read_progression_speed", decision);
    const zoneCov = T(player, "zone_coverage_instincts", pattern);
    const manCov = T(player, "man_coverage_mirroring", pattern);
    const ballDb = T(player, "ball_skills_db", pattern);
    const runFit = T(player, "run_fit_discipline", discipline);
  
    const C = {
      decisionSpeed: decision,
      patternIQ: pattern,
      discipline,
      motorLearning: motor,
      coverageAwareness: (zoneCov + manCov + ballDb) / 3,
      runFitIQ: (runFit + discipline + pattern) / 3,
      qbProcessing: readProg,
    };
  
    return new LatentSubVector(C);
  }
  
  /**
   * Technical (T) latent vector – position-specific craft.
   */
  function computeTechnicalLatent(player) {
    const pos = player.position;
  
    // Receiving craft
    const route = T(player, "route_deception", 0.5);
    const release = T(player, "release_vs_press", 0.5);
    const catchHands = T(player, "catch_hand_reliability", 0.5);
    const contested = T(player, "contested_catch_skill", 0.5);
    const lateHands = T(player, "late_hands_craft", 0.5);
  
    // Line play
    const runBlockPOA = T(player, "blocking_run_point_of_attack", 0.5);
    const blockLvl2 = T(player, "blocking_second_level", 0.5);
    const passPro = T(player, "pass_pro_technique", 0.5);
  
    // QB / playmaking
    const pocketNav = T(player, "pocket_navigation", 0.5);
    const offScript = T(player, "off_script_playmaking", 0.5);
    const throwDuress = T(player, "throwing_under_duress", 0.5);
  
    // Tackling
    const tackle = T(player, "open_field_tackling", 0.5);
    const ballSecurity = T(player, "ball_security", 0.5);
    const fumbleRes = T(player, "fumble_resilience", 0.5);
  
    const base = {
      routeCraft: (route + release) / 2,
      hands: (catchHands + contested + lateHands) / 3,
      blockingRun: (runBlockPOA + blockLvl2) / 2,
      blockingPass: passPro,
      qbPocket: pocketNav,
      qbOffScript: offScript,
      qbUnderPressure: throwDuress,
      tackling: tackle,
      ballSecurity: (ballSecurity + fumbleRes) / 2,
    };
  
    // Tiny position-specific boosts (purely technical, no "talent" bias).
    if (pos === "WR" || pos === "TE") {
      base.routeCraft = clamp01(base.routeCraft * 1.08);
      base.hands = clamp01(base.hands * 1.04);
    } else if (pos === "C" || pos === "LG" || pos === "RG" || pos === "LT" || pos === "RT") {
      base.blockingRun = clamp01(base.blockingRun * 1.05);
      base.blockingPass = clamp01(base.blockingPass * 1.05);
    } else if (pos === "QB") {
      base.qbPocket = clamp01(base.qbPocket * 1.06);
      base.qbUnderPressure = clamp01(base.qbUnderPressure * 1.06);
    } else if (pos === "LB" || pos === "S") {
      base.tackling = clamp01(base.tackling * 1.05);
    }
  
    return new LatentSubVector(base);
  }
  
  /**
   * Psyche / Personality (P) latent vector.
   * We don't have all personality metrics here, so we approximate using factors.
   */
  function computePsycheLatent(player) {
    const discipline = F(player, "discipline", 0.5);
    const aggression = F(player, "aggression_style", 0.5);
    const leadership = F(player, "leadership_factor", 0.5);
    const creativity = F(player, "creativity_factor", 0.5);
  
    // We don't have explicit "emotional_stability" at Layer 2, so treat
    // durability and discipline as proxies.
    const durability = F(player, "durability", 0.5);
    const emotionalStability = clamp01((durability + discipline) / 2);
  
    const grit = clamp01((discipline + durability + leadership) / 3);
    const riskTolerance = clamp01((aggression + creativity) / 2);
  
    const P = {
      discipline,
      aggression,
      leadership,
      creativity,
      emotionalStability,
      grit,
      riskTolerance,
    };
  
    return new LatentSubVector(P);
  }
  
  /**
   * Variance / Environment / Chaos (V) latent vector.
   * For now we derive a "volatility" scalar mostly from aggression vs discipline
   * and emotional stability; later you can plug in explicit env traits.
   */
  function computeVarianceLatent(player, psycheSubVector) {
    const discipline = psycheSubVector.get("discipline", 0.5);
    const aggression = psycheSubVector.get("aggression", 0.5);
    const emotional = psycheSubVector.get("emotionalStability", 0.5);
    const creativity = psycheSubVector.get("creativity", 0.5);
  
    // Aggressive, creative, low-discipline, low-stability = high volatility.
    let volatilityBase =
      0.4 * aggression +
      0.3 * creativity +
      0.2 * (1 - discipline) +
      0.1 * (1 - emotional);
  
    volatilityBase = clamp01(volatilityBase);
  
    // Map 0..1 -> (mean=~0.8..1.2 range) for sigma scaling; keep 0.2 window.
    const gameSigma = 0.04 + 0.08 * volatilityBase; // std dev for game-form multiplier
    const playSigma = 0.12 + 0.12 * volatilityBase; // per-play noise factor
  
    const V = {
      volatility: volatilityBase,
      gameSigma,
      playSigma,
    };
  
    return new LatentSubVector(V);
  }
  
  /**
   * Full latent profile builder for one player.
   */
  export function computeLatentProfileForPlayer(player) {
    if (!(player instanceof Player)) {
      throw new Error("computeLatentProfileForPlayer expects a Player instance.");
    }
  
    const A = computeAthleticLatent(player);
    const C = computeCognitiveLatent(player);
    const Ttech = computeTechnicalLatent(player);
    const Ppsy = computePsycheLatent(player);
    const Vvar = computeVarianceLatent(player, Ppsy);
  
    return new LatentProfile({
      A,
      C,
      T: Ttech,
      P: Ppsy,
      V: Vvar,
    });
  }
  
  /**
   * Attach latent profiles to every player in a league.
   * This is cheap and can be done at load time.
   */
  export function assignLatentProfilesToLeague(league) {
    if (!(league instanceof League)) {
      throw new Error("assignLatentProfilesToLeague expects a League.");
    }
    for (const player of league.playersById.values()) {
      const profile = computeLatentProfileForPlayer(player);
      player.setLatentProfile(profile);
    }
  }
  
  // -----------------------------------------------------------------------------
  // Unit profiles (offense / defense / special)
  // -----------------------------------------------------------------------------
  // These are team-level summaries built from player latent profiles + ratings.
  // They will be used by the game engine & micro-engine to parameterize the
  // probability models for plays.
  // -----------------------------------------------------------------------------
  
  // Utility: average a list of numbers; returns fallback if list empty.
  function avg(nums, fallback = 0) {
    if (!nums || !nums.length) return fallback;
    let sum = 0;
    for (const x of nums) sum += x;
    return sum / nums.length;
  }
  
  /**
   * Select "starter-ish" players by position for profile computations.
   * Fallback: if not enough players, just use whatever is available.
   */
  function pickStarters(team, pos, count) {
    const list = team.getDepthChart(pos);
    if (!list || !list.length) return [];
    const byDepth = [...list].sort((a, b) => {
      const da = a.depth || 999;
      const db = b.depth || 999;
      if (da !== db) return da - db;
      return b.ratingOverall - a.ratingOverall;
    });
    return byDepth.slice(0, count);
  }
  
  /**
   * Compute offense unit profile for a team.
   * Returns an object like:
   *   {
   *     pass: 0..100,
   *     run: 0..100,
   *     protection: 0..100,
   *     explosiveness: 0..100,
   *     consistency: 0..100,
   *     qbReliance: 0..1,
   *   }
   */
  export function computeOffenseProfile(team) {
    const startersQB = pickStarters(team, "QB", 1);
    const startersRB = pickStarters(team, "RB", 1);
    const startersWR = pickStarters(team, "WR", 3);
    const startersTE = pickStarters(team, "TE", 1);
    const startersFB = pickStarters(team, "FB", 1);
    const startersOL = [
      ...pickStarters(team, "LT", 1),
      ...pickStarters(team, "LG", 1),
      ...pickStarters(team, "C", 1),
      ...pickStarters(team, "RG", 1),
      ...pickStarters(team, "RT", 1),
    ];
  
    const allSkill = [
      ...startersQB,
      ...startersRB,
      ...startersWR,
      ...startersTE,
      ...startersFB,
    ];
  
    // Helper to collect latent components.
    function collect(group, key, players) {
      return players.map((p) => p.latent.get(group, key, 0.5));
    }
  
    // Passing capability: QB processing & pocket + WR/TE route/hands.
    const qbPass =
      avg(collect("C", "qbProcessing", startersQB), 0.5) * 0.55 +
      avg(collect("T", "qbUnderPressure", startersQB), 0.5) * 0.45;
  
    const wrRoute = avg(collect("T", "routeCraft", startersWR), 0.5);
    const wrHands = avg(collect("T", "hands", startersWR), 0.5);
    const teRoute = avg(collect("T", "routeCraft", startersTE), 0.5);
    const teHands = avg(collect("T", "hands", startersTE), 0.5);
  
    const passCatchCraft =
      0.6 * avg([wrRoute, wrHands], 0.5) + 0.4 * avg([teRoute, teHands], 0.5);
  
    const passProtection = avg(collect("T", "blockingPass", startersOL), 0.5);
  
    const passScore =
      0.55 * qbPass + 0.30 * passCatchCraft + 0.15 * passProtection;
  
    // Run capability: RB elusiveness + vision, OL run block, FB/TE blocking.
    const rbElusiveness = avg(
      [
        avg(collect("A", "agility", startersRB), 0.5),
        avg(collect("T", "ballSecurity", startersRB), 0.5),
      ],
      0.5
    );
  
    const rbPower = avg(collect("A", "power", startersRB), 0.5);
    const olRunBlock = avg(collect("T", "blockingRun", startersOL), 0.5);
    const fbRunBlock = avg(collect("T", "blockingRun", startersFB), 0.5);
    const teRunBlock = avg(collect("T", "blockingRun", startersTE), 0.5);
  
    const runScore =
      0.40 * rbElusiveness +
      0.20 * rbPower +
      0.30 * olRunBlock +
      0.10 * avg([fbRunBlock, teRunBlock], 0.5);
  
    // Explosiveness: skill players' A.explosiveness + speedLong.
    const skillExpl = avg(collect("A", "explosiveness", allSkill), 0.5);
    const skillSpeedLong = avg(collect("A", "speedLong", allSkill), 0.5);
    const explosivenessScore =
      0.55 * skillExpl + 0.45 * skillSpeedLong;
  
    // Consistency: discipline & emotional stability of key offensive pieces.
    const psyDiscipline = avg(collect("P", "discipline", allSkill), 0.5);
    const psyStability = avg(
      collect("P", "emotionalStability", allSkill),
      0.5
    );
    const consistencyScore = 0.5 * psyDiscipline + 0.5 * psyStability;
  
    // QB reliance: how central QB is relative to rest of offense.
    const skillOverall = avg(allSkill.map((p) => p.ratingOverall / 100), 0.6);
    const qbOverall = avg(startersQB.map((p) => p.ratingOverall / 100), 0.6);
    const qbReliance = clamp01(
      0.5 + 0.5 * (qbOverall - skillOverall) // >0 favors QB-centric offense
    );
  
    // Map 0..1 -> 0..100 for final scores.
    const to100 = (x) => Math.round(clamp01(x) * 100);
  
    return {
      pass: to100(passScore),
      run: to100(runScore),
      protection: to100(passProtection),
      explosiveness: to100(explosivenessScore),
      consistency: to100(consistencyScore),
      qbReliance, // keep as 0..1
    };
  }
  
  /**
   * Compute defense unit profile for a team.
   * Returns an object like:
   *   {
   *     coverage: 0..100,
   *     passRush: 0..100,
   *     runFit: 0..100,
   *     tackling: 0..100,
   *     chaosPlays: 0..100,
   *     blitzAggression: 0..1,
   *   }
   */
  export function computeDefenseProfile(team) {
    const startersDT = pickStarters(team, "DT", 2);
    const startersEDGE = pickStarters(team, "EDGE", 2);
    const startersLB = pickStarters(team, "LB", 3);
    const startersCB = pickStarters(team, "CB", 3);
    const startersS = pickStarters(team, "S", 2);
  
    const front7 = [...startersDT, ...startersEDGE, ...startersLB];
    const secondary = [...startersCB, ...startersS];
    const allDef = [...front7, ...secondary];
  
    function collect(group, key, players) {
      return players.map((p) => p.latent.get(group, key, 0.5));
    }
  
    // Coverage: secondary coverage awareness + ball skills.
    const secCovAwareness = avg(collect("C", "coverageAwareness", secondary), 0.5);
    const secPattern = avg(collect("C", "patternIQ", secondary), 0.5);
    const coverageScore =
      0.6 * secCovAwareness + 0.4 * secPattern;
  
    // Pass rush: EDGE + DT explosiveness + strength.
    const edgeExpl = avg(collect("A", "explosiveness", startersEDGE), 0.5);
    const edgeStrength = avg(collect("A", "power", startersEDGE), 0.5);
    const dtExpl = avg(collect("A", "explosiveness", startersDT), 0.5);
    const dtStrength = avg(collect("A", "power", startersDT), 0.5);
    const passRushScore =
      0.35 * edgeExpl +
      0.25 * edgeStrength +
      0.20 * dtExpl +
      0.20 * dtStrength;
  
    // Run fit: front-7 run IQ + tackling + strength.
    const frontRunIQ = avg(collect("C", "runFitIQ", front7), 0.5);
    const frontTackle = avg(collect("T", "tackling", front7), 0.5);
    const frontStrength = avg(collect("A", "power", front7), 0.5);
  
    const runFitScore =
      0.40 * frontRunIQ +
      0.35 * frontTackle +
      0.25 * frontStrength;
  
    // Tackling general: all defenders.
    const tacklingScore = avg(collect("T", "tackling", allDef), 0.5);
  
    // Chaos plays: aggression + volatility.
    const aggression = avg(collect("P", "aggression", allDef), 0.5);
    const volatility = avg(collect("V", "volatility", allDef), 0.5);
    const chaosScore = clamp01(0.6 * aggression + 0.4 * volatility);
  
    // Blitz aggression: slider 0..1 used in game engine's call mix.
    const blitzAggression = clamp01(
      0.5 * aggression + 0.2 * volatility + 0.3 * (1 - avg(collect("P", "discipline", allDef), 0.5))
    );
  
    const to100 = (x) => Math.round(clamp01(x) * 100);
  
    return {
      coverage: to100(coverageScore),
      passRush: to100(passRushScore),
      runFit: to100(runFitScore),
      tackling: to100(tacklingScore),
      chaosPlays: to100(chaosScore),
      blitzAggression,
    };
  }
  
  /**
   * Compute special teams profile.
   * Uses K, P, plus generic special_teams_value traits.
   */
  export function computeSpecialTeamsProfile(team) {
    const ks = pickStarters(team, "K", 1);
    const ps = pickStarters(team, "P", 1);
    const allST = [...ks, ...ps];
  
    function collect(group, key, players) {
      return players.map((p) => p.latent.get(group, key, 0.5));
    }
  
    // Use technical ballSecurity and "strength" as crude proxies here.
    const kQuality =
      avg(collect("T", "ballSecurity", ks), 0.5) * 0.4 +
      avg(collect("A", "power", ks), 0.5) * 0.6;
    const pQuality =
      avg(collect("T", "ballSecurity", ps), 0.5) * 0.4 +
      avg(collect("A", "power", ps), 0.5) * 0.6;
  
    const stReliability = avg(collect("P", "discipline", allST), 0.5);
    const stVolatility = avg(collect("V", "volatility", allST), 0.5);
  
    const kickingScore = (kQuality + pQuality) / 2;
    const coverageScore = clamp01(stReliability * (1 - 0.5 * stVolatility));
  
    const to100 = (x) => Math.round(clamp01(x) * 100);
  
    return {
      kicking: to100(kickingScore),
      coverage: to100(coverageScore),
      volatility: to100(stVolatility),
    };
  }
  
  /**
   * Bulk: compute and attach unit profiles for all teams.
   */
  export function computeAllTeamUnitProfiles(league) {
    if (!(league instanceof League)) {
      throw new Error("computeAllTeamUnitProfiles expects a League.");
    }
    for (const team of league.listTeams()) {
      const off = computeOffenseProfile(team);
      const def = computeDefenseProfile(team);
      const st = computeSpecialTeamsProfile(team);
      team.setUnitProfiles({
        offense: off,
        defense: def,
        special: st,
      });
    }
  }
  
  // -----------------------------------------------------------------------------
  // Form / variance / momentum helpers
  // -----------------------------------------------------------------------------
  // These will be used by the game engine to apply per-game, per-drive, and
  // per-play multipliers to underlying probabilities.
  // -----------------------------------------------------------------------------
  
  /**
   * Sample a game-level form multiplier for a player.
   * Returns a scalar centered ~1.0, with sigma derived from latent V + P:
   *
   *   m_game ~ Normal(1, gameSigma), clamped to ~[0.75, 1.35] by default.
   */
  export function samplePlayerGameForm(player, rng, clampRange = [0.75, 1.35]) {
    const sigma = player.latent.V.get("gameSigma", 0.06);
    const mu = 1.0;
    const raw = rng.normal(mu, sigma);
    return Math.max(clampRange[0], Math.min(clampRange[1], raw));
  }
  
  /**
   * Sample a per-play execution noise factor for a player.
   * Returns a scalar multiplier around 1, with player-specific sigma.
   */
  export function samplePlayerPlayNoise(player, rng, clampRange = [0.5, 1.8]) {
    const sigma = player.latent.V.get("playSigma", 0.18);
    const raw = rng.normal(1.0, sigma);
    return Math.max(clampRange[0], Math.min(clampRange[1], raw));
  }
  
  /**
   * Momentum state is modeled as a scalar m in [-1, +1].
   *  0   = neutral
   *  >0  = offense has momentum
   *  <0  = defense has momentum
   *
   * This helper nudges momentum based on an "event impact" magnitude in [0,1],
   * and also uses team psyche to dampen or amplify swings.
   */
  export function updateMomentum(prevMomentum, eventImpact, offenseTeam, defenseTeam, rng) {
    // eventImpact: fumble, big TD, pick-six, etc. 0 small, 1 huge.
    const impact = clamp01(eventImpact);
  
    // Use team-wide discipline & emotional stability as damping factors.
    const offDisc = teamPsychMean(offenseTeam, "discipline");
    const defDisc = teamPsychMean(defenseTeam, "discipline");
    const offStab = teamPsychMean(offenseTeam, "emotionalStability");
    const defStab = teamPsychMean(defenseTeam, "emotionalStability");
  
    const offDamp = 0.4 * offDisc + 0.6 * offStab;
    const defDamp = 0.4 * defDisc + 0.6 * defStab;
  
    // Higher damping means less crazy swings.
    const avgDamp = clamp01((offDamp + defDamp) / 2);
    const maxSwing = lerp(0.4, 1.4, 1 - avgDamp); // 0.4..1.4 range
  
    const swingDirection = impact >= 0 ? 1 : -1;
    const baseSwing = maxSwing * impact * swingDirection;
  
    // Inject a bit of randomness so not perfectly deterministic.
    const randomJitter = rng.normal(0, 0.1 * impact);
  
    let next = prevMomentum + baseSwing + randomJitter;
    // Small natural regression to 0 each event.
    next *= 0.9;
  
    // Clamp to [-1, 1]
    if (next > 1) next = 1;
    if (next < -1) next = -1;
  
    return next;
  }
  
  /**
   * Team-level psyche mean helper for momentum.
   */
  function teamPsychMean(team, key) {
    const vals = [];
    for (const p of team.roster) {
      vals.push(p.latent.P.get(key, 0.5));
    }
    return avg(vals, 0.5);
  }
  
  // -----------------------------------------------------------------------------
  // Composite convenience: prepare league for simulation
  // -----------------------------------------------------------------------------
  // This is a helpful "one call" to run after loading layer3_rosters and before
  // simulating games.
  // -----------------------------------------------------------------------------
  
  /**
   * Prepare a League for simulation:
   *   - attach latent profiles to all players
   *   - compute team-level unit profiles
   *
   * (Ratings / overall scores remain up to the Python pipeline or another JS
   *  module; this is focused on latent + unit flavor.)
   */
  export function prepareLeagueForSimulation(league) {
    assignLatentProfilesToLeague(league);
    computeAllTeamUnitProfiles(league);
  }
  