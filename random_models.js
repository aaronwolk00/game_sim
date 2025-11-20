// random_models.js
// -----------------------------------------------------------------------------
// Randomness & Statistical Models (standalone, no imports)
//
// Provides:
//   - Seeded RNG and stream splitting
//   - Light latent-profile wrappers compatible with either:
//       • players that already have {latent: {A,C,T,P,V}} (from data_models.js)
//       • or players missing those (we derive sane fallbacks)
//   - Team unit profiles (offense / defense / special) built from rosters
//   - Form & momentum helpers
//   - One-call `prepareLeagueForSimulation(league)`
//
// Notes:
//   • Duck-typed across Player/Team/League shapes. No hard instanceof checks.
//   • Safe with your current game_engine.js (which doesn’t import this file).
//   • Does NOT simulate plays – micro_engine.js / game_engine.js do that.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// RNG implementation & stream splitting
// -----------------------------------------------------------------------------
export class Rng {
    constructor(seed = 1) {
      this._state = (seed >>> 0) || 1; // force Uint32
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
      return this._nextUint32() / 0xffffffff; // [0,1)
    }
    nextNormal() {
      // Box–Muller: N(0,1)
      let u = 0, v = 0;
      while (u === 0) u = this.next();
      while (v === 0) v = this.next();
      const mag = Math.sqrt(-2.0 * Math.log(u));
      return mag * Math.cos(2 * Math.PI * v);
    }
    normal(mu = 0, sigma = 1) {
      return mu + sigma * this.nextNormal();
    }
    fork(tag = 0) {
      const bump = this._nextUint32() ^ (hashString(String(tag)) >>> 0);
      return new Rng(bump || 1);
    }
  }
  
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
  
  /** Build named RNG streams so different model layers don’t correlate. */
  export function buildRngStreams(seed = 2025) {
    const core = new Rng(seed);
    return {
      core,
      playerForm: core.fork("playerForm"),
      gameContext: core.fork("gameContext"),
      drive: core.fork("drive"),
      play: core.fork("play"),
      env: core.fork("env"),
    };
  }
  
  // -----------------------------------------------------------------------------
  // Lightweight latent profile wrappers
  // -----------------------------------------------------------------------------
  
  /** Minimal sub-vector with `.get(key, fallback)` accessor. */
  class LatentSubVector {
    constructor(obj = {}) {
      this._ = obj || {};
    }
    get(key, fallback = 0.5) {
      const v = this._[key];
      return Number.isFinite(v) ? v : fallback;
    }
    set(key, value) {
      this._[key] = value;
    }
    toObject() {
      return { ...this._ };
    }
  }
  
  /** Minimal profile with groups A,C,T,P,V and nested `.get(group,key,fb)`. */
  class LatentProfile {
    constructor({ A, C, T, P, V }) {
      this.A = new LatentSubVector(A);
      this.C = new LatentSubVector(C);
      this.T = new LatentSubVector(T);
      this.P = new LatentSubVector(P);
      this.V = new LatentSubVector(V);
    }
    get(group, key, fallback = 0.5) {
      const g = this[group];
      if (!g || typeof g.get !== "function") return fallback;
      return g.get(key, fallback);
    }
    toObject() {
      return {
        A: this.A.toObject(),
        C: this.C.toObject(),
        T: this.T.toObject(),
        P: this.P.toObject(),
        V: this.V.toObject(),
      };
    }
  }
  
  /**
   * Ensure player.latent is a LatentProfile instance.
   * If data_models.js already produced {latent:{A,C,T,P,V}}, we wrap it.
   * If not, we build a conservative profile from whatever is available.
   */
  function ensureLatentProfile(player) {
    if (player && player.latent instanceof LatentProfile) return player.latent;
  
    // Case: data_models.js built a plain object with groups A,C,T,P,V
    if (
      player &&
      player.latent &&
      player.latent.A &&
      player.latent.C &&
      player.latent.T &&
      player.latent.P &&
      player.latent.V
    ) {
      // Also derive volatility/gameSigma/playSigma if missing.
      const Vobj = { ...(player.latent.V || {}) };
      if (!Number.isFinite(Vobj.volatility)) {
        const chaos = numOr(Vobj.chaosSeed, 0.5);
        const stab = numOr(Vobj.stabilitySeed, 0.5);
        Vobj.volatility = clamp01(0.6 * chaos + 0.4 * (1 - stab));
      }
      if (!Number.isFinite(Vobj.gameSigma)) {
        Vobj.gameSigma = 0.04 + 0.08 * clamp01(Vobj.volatility);
      }
      if (!Number.isFinite(Vobj.playSigma)) {
        Vobj.playSigma = 0.12 + 0.12 * clamp01(Vobj.volatility);
      }
      const prof = new LatentProfile({
        A: player.latent.A,
        C: player.latent.C,
        T: player.latent.T,
        P: player.latent.P,
        V: Vobj,
      });
      player.latent = prof; // attach wrapper in-place
      return prof;
    }
  
    // Fallback: build a bland-but-safe profile from player.ratingOverall & seeds/traits if present.
    const base = clamp01((numOr(player?.ratingOverall, 60) / 100));
    const Pdisc = clamp01(numOr(player?.seeds?.stability, 0.55));
    const Pemo  = clamp01(numOr(player?.seeds?.stability, 0.55));
    const chaos = clamp01(numOr(player?.seeds?.chaos, 0.45));
    const vol = clamp01(0.6 * chaos + 0.4 * (1 - Pdisc));
    const profile = new LatentProfile({
      A: {
        explosiveness: base,
        topSpeed: base,
        changeOfDirection: base,
        strength: base,
        durability: base,
        shortAreaQuickness: base,
        longSpeedReserve: base,
      },
      C: {
        decisionSpeed: base,
        patternIQ: base,
        discipline: Pdisc,
        readProgressionSpeed: base,
        runFitDiscipline: base,
        zoneCoverageInstincts: base,
        manCoverageMirroring: base,
        ballSkillsDB: base,
      },
      T: {
        routeDeception: base,
        releaseVsPress: base,
        catchReliability: base,
        contestedCatch: base,
        sidelineWizardry: base,
        pocketNavigation: base,
        offScriptPlaymaking: base,
        throwingUnderDuress: base,
        passProTechnique: base,
        blockingRunPointOfAttack: base,
        openFieldTackling: base,
        ballSecurityTrait: base,
      },
      P: {
        discipline: Pdisc,
        emotionalStability: Pemo,
        aggression: 0.5,
        creativity: 0.5,
      },
      V: {
        volatility: vol,
        gameSigma: 0.04 + 0.08 * vol,
        playSigma: 0.12 + 0.12 * vol,
      },
    });
    player.latent = profile;
    return profile;
  }
  
  function numOr(v, fb = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  
  // -----------------------------------------------------------------------------
  // Latent helpers (key mapping from your data_models latent field names)
  // -----------------------------------------------------------------------------
  
  // Athletic composites
  function latentA_agility(p) {
    const L = ensureLatentProfile(p);
    const cod = L.A.get("changeOfDirection", 0.5);
    const shortQ = L.A.get("shortAreaQuickness", 0.5);
    return (cod + shortQ) / 2;
  }
  function latentA_power(p) {
    const L = ensureLatentProfile(p);
    // Use strength + functional proxies if present
    const str = L.A.get("strength", 0.5);
    const frun = L.A.get("functionalStrengthRun", str);
    const fpass = L.A.get("functionalStrengthPass", str);
    return (str + frun + fpass) / 3;
  }
  function latentA_speedLong(p) {
    const L = ensureLatentProfile(p);
    const longReserve = L.A.get("longSpeedReserve", 0.5);
    const top = L.A.get("topSpeed", 0.5);
    return (longReserve + top) / 2;
  }
  
  // Cognitive composites
  function latentC_qbProcessing(p) {
    const L = ensureLatentProfile(p);
    // Prefer readProgressionSpeed; fallback to decisionSpeed
    const readProg = L.T.get?.("readProgressionSpeed", NaN); // some versions stored in T
    if (Number.isFinite(readProg)) return readProg;
    return L.C.get("readProgressionSpeed", L.C.get("decisionSpeed", 0.5));
  }
  function latentC_runFitIQ(p) {
    const L = ensureLatentProfile(p);
    return L.C.get("runFitDiscipline", 0.5);
  }
  function latentC_coverageAwareness(p) {
    const L = ensureLatentProfile(p);
    const z = L.C.get("zoneCoverageInstincts", 0.5);
    const m = L.C.get("manCoverageMirroring", 0.5);
    const b = L.C.get("ballSkillsDB", 0.5);
    return (z + m + b) / 3;
  }
  
  // Technical composites
  function latentT_routeCraft(p) {
    const L = ensureLatentProfile(p);
    const r = L.T.get("routeDeception", 0.5);
    const rel = L.T.get("releaseVsPress", 0.5);
    return (r + rel) / 2;
  }
  function latentT_hands(p) {
    const L = ensureLatentProfile(p);
    const h = L.T.get("catchReliability", 0.5);
    const cc = L.T.get("contestedCatch", 0.5);
    const sw = L.T.get("sidelineWizardry", 0.5);
    return (h + cc + sw) / 3;
  }
  function latentT_blockingRun(p) {
    const L = ensureLatentProfile(p);
    return L.T.get("blockingPointOfAttack", L.T.get("blocking_run_point_of_attack", 0.5));
  }
  function latentT_blockingPass(p) {
    const L = ensureLatentProfile(p);
    return L.T.get("passProTechnique", 0.5);
  }
  function latentT_qbUnderPressure(p) {
    const L = ensureLatentProfile(p);
    return L.T.get("throwingUnderDuress", 0.5);
  }
  function latentT_tackling(p) {
    const L = ensureLatentProfile(p);
    return L.T.get("openFieldTackling", 0.5);
  }
  function latentT_ballSecurity(p) {
    const L = ensureLatentProfile(p);
    return L.T.get("ballSecurityTrait", 0.5);
  }
  
  // Psyche & Variance
  function latentP_disc(p) { return ensureLatentProfile(p).P.get("discipline", 0.5); }
  function latentP_emo(p)  { return ensureLatentProfile(p).P.get("emotionalStability", 0.5); }
  function latentP_aggr(p) { return ensureLatentProfile(p).P.get("aggression", 0.5); }
  function latentV_vol(p)  { return ensureLatentProfile(p).V.get("volatility", 0.5); }
  function latentV_gameSigma(p) { return ensureLatentProfile(p).V.get("gameSigma", 0.06); }
  function latentV_playSigma(p) { return ensureLatentProfile(p).V.get("playSigma", 0.18); }
  
  // -----------------------------------------------------------------------------
  // League/Team/Player traversal (duck-typed)
  // -----------------------------------------------------------------------------
  function listTeams(league) {
    if (!league) return [];
    if (typeof league.listTeams === "function") return league.listTeams();
    if (Array.isArray(league.teams)) return league.teams;
    // Some code may pass a single team instead of league
    if (Array.isArray(league)) return league;
    return [];
  }
  function listPlayers(league) {
    if (!league) return [];
    if (league.playersById && typeof league.playersById.values === "function") {
      return Array.from(league.playersById.values());
    }
    const all = [];
    for (const t of listTeams(league)) {
      if (Array.isArray(t?.roster)) all.push(...t.roster);
    }
    return all;
  }
  function playersByPosition(team, pos) {
    if (!team) return [];
    if (typeof team.getPlayersByPosition === "function") return team.getPlayersByPosition(pos);
    if (team.depthChart && Array.isArray(team.depthChart[pos])) return team.depthChart[pos];
    // fallback: filter roster
    return (team.roster || []).filter(p => p.position === pos);
  }
  function pickStarters(team, pos, count) {
    const list = playersByPosition(team, pos);
    if (!list.length) return [];
    const byDepth = [...list].sort((a, b) => {
      const da = numOr(a.depth, 999);
      const db = numOr(b.depth, 999);
      if (da !== db) return da - db;
      return numOr(b.ratingOverall, 0) - numOr(a.ratingOverall, 0);
    });
    return byDepth.slice(0, count);
  }
  function avg(arr, fb = 0) {
    const nums = arr.filter(n => Number.isFinite(n));
    if (!nums.length) return fb;
    let s = 0;
    for (const x of nums) s += x;
    return s / nums.length;
  }
  
  // -----------------------------------------------------------------------------
  // Unit profiles (offense / defense / special)
  // -----------------------------------------------------------------------------
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
  
    const allSkill = [...startersQB, ...startersRB, ...startersWR, ...startersTE, ...startersFB];
  
    // Passing capability: QB processing + under pressure; WR/TE craft+hands; OL pass pro
    const qbPass =
      0.55 * avg(startersQB.map(latentC_qbProcessing), 0.5) +
      0.45 * avg(startersQB.map(latentT_qbUnderPressure), 0.5);
  
    const wrRoute = avg(startersWR.map(latentT_routeCraft), 0.5);
    const wrHands = avg(startersWR.map(latentT_hands), 0.5);
    const teRoute = avg(startersTE.map(latentT_routeCraft), 0.5);
    const teHands = avg(startersTE.map(latentT_hands), 0.5);
    const passCatchCraft = 0.6 * avg([wrRoute, wrHands], 0.5) + 0.4 * avg([teRoute, teHands], 0.5);
  
    const passProtection = avg(startersOL.map(latentT_blockingPass), 0.5);
  
    const passScore = 0.55 * qbPass + 0.30 * passCatchCraft + 0.15 * passProtection;
  
    // Run capability: RB agility/ball security/power; OL/FB/TE blocking
    const rbElusiveness = avg(
      [
        avg(startersRB.map(latentA_agility), 0.5),
        avg(startersRB.map(latentT_ballSecurity), 0.5),
      ],
      0.5
    );
    const rbPower = avg(startersRB.map(latentA_power), 0.5);
    const olRunBlock = avg(startersOL.map(latentT_blockingRun), 0.5);
    const fbRunBlock = avg(startersFB.map(latentT_blockingRun), 0.5);
    const teRunBlock = avg(startersTE.map(latentT_blockingRun), 0.5);
  
    const runScore =
      0.40 * rbElusiveness +
      0.20 * rbPower +
      0.30 * olRunBlock +
      0.10 * avg([fbRunBlock, teRunBlock], 0.5);
  
    // Explosiveness: skill explosiveness + long speed
    const skillExpl = avg(allSkill.map(p => ensureLatentProfile(p).A.get("explosiveness", 0.5)), 0.5);
    const skillSpeedLong = avg(allSkill.map(latentA_speedLong), 0.5);
    const explosivenessScore = 0.55 * skillExpl + 0.45 * skillSpeedLong;
  
    // Consistency: discipline & emotional stability
    const psyDiscipline = avg(allSkill.map(latentP_disc), 0.5);
    const psyStability = avg(allSkill.map(latentP_emo), 0.5);
    const consistencyScore = 0.5 * psyDiscipline + 0.5 * psyStability;
  
    // QB reliance: compare QB overall to others, normalized to [0,1]
    const skillOverall = avg(allSkill.map(p => numOr(p.ratingOverall, 60) / 100), 0.6);
    const qbOverall = avg(startersQB.map(p => numOr(p.ratingOverall, 60) / 100), 0.6);
    const qbReliance = clamp01(0.5 + 0.5 * (qbOverall - skillOverall));
  
    const to100 = (x) => Math.round(clamp01(x) * 100);
  
    return {
      pass: to100(passScore),
      run: to100(runScore),
      protection: to100(passProtection),
      explosiveness: to100(explosivenessScore),
      consistency: to100(consistencyScore),
      qbReliance,
    };
  }
  
  export function computeDefenseProfile(team) {
    const startersDT = pickStarters(team, "DT", 2);
    const startersEDGE = pickStarters(team, "EDGE", 2);
    const startersLB = pickStarters(team, "LB", 3);
    const startersCB = pickStarters(team, "CB", 3);
    const startersS = pickStarters(team, "S", 2);
  
    const front7 = [...startersDT, ...startersEDGE, ...startersLB];
    const secondary = [...startersCB, ...startersS];
    const allDef = [...front7, ...secondary];
  
    const secCovAwareness = avg(secondary.map(latentC_coverageAwareness), 0.5);
    const secPattern = avg(secondary.map(p => ensureLatentProfile(p).C.get("patternIQ", 0.5)), 0.5);
    const coverageScore = 0.6 * secCovAwareness + 0.4 * secPattern;
  
    const edgeExpl = avg(startersEDGE.map(p => ensureLatentProfile(p).A.get("explosiveness", 0.5)), 0.5);
    const edgeStrength = avg(startersEDGE.map(latentA_power), 0.5);
    const dtExpl = avg(startersDT.map(p => ensureLatentProfile(p).A.get("explosiveness", 0.5)), 0.5);
    const dtStrength = avg(startersDT.map(latentA_power), 0.5);
    const passRushScore = 0.35 * edgeExpl + 0.25 * edgeStrength + 0.20 * dtExpl + 0.20 * dtStrength;
  
    const frontRunIQ = avg(front7.map(latentC_runFitIQ), 0.5);
    const frontTackle = avg(front7.map(latentT_tackling), 0.5);
    const frontStrength = avg(front7.map(latentA_power), 0.5);
    const runFitScore = 0.40 * frontRunIQ + 0.35 * frontTackle + 0.25 * frontStrength;
  
    const tacklingScore = avg(allDef.map(latentT_tackling), 0.5);
  
    const aggression = avg(allDef.map(latentP_aggr), 0.5);
    const volatility = avg(allDef.map(latentV_vol), 0.5);
    const chaosScore = clamp01(0.6 * aggression + 0.4 * volatility);
  
    const blitzAggression = clamp01(
      0.5 * aggression + 0.2 * volatility + 0.3 * (1 - avg(allDef.map(latentP_disc), 0.5))
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
  
  export function computeSpecialTeamsProfile(team) {
    const ks = pickStarters(team, "K", 1);
    const ps = pickStarters(team, "P", 1);
    const allST = [...ks, ...ps];
  
    const kQuality = 0.4 * avg(ks.map(latentT_ballSecurity), 0.5) + 0.6 * avg(ks.map(latentA_power), 0.5);
    const pQuality = 0.4 * avg(ps.map(latentT_ballSecurity), 0.5) + 0.6 * avg(ps.map(latentA_power), 0.5);
  
    const stReliability = avg(allST.map(latentP_disc), 0.5);
    const stVolatility = avg(allST.map(latentV_vol), 0.5);
  
    const kickingScore = (kQuality + pQuality) / 2;
    const coverageScore = clamp01(stReliability * (1 - 0.5 * stVolatility));
  
    const to100 = (x) => Math.round(clamp01(x) * 100);
  
    return {
      kicking: to100(kickingScore),
      coverage: to100(coverageScore),
      volatility: to100(stVolatility),
    };
  }
  
  /** Compute & attach unit profiles to every team in a league-like object. */
  export function computeAllTeamUnitProfiles(league) {
    for (const team of listTeams(league)) {
      const off = computeOffenseProfile(team);
      const def = computeDefenseProfile(team);
      const st = computeSpecialTeamsProfile(team);
      team.unitProfiles = { offense: off, defense: def, special: st };
    }
  }
  
  // -----------------------------------------------------------------------------
  // Form / variance / momentum helpers
  // -----------------------------------------------------------------------------
  export function samplePlayerGameForm(player, rng, clampRange = [0.75, 1.35]) {
    const sigma = latentV_gameSigma(player);
    const raw = rng.normal(1.0, sigma);
    return Math.max(clampRange[0], Math.min(clampRange[1], raw));
  }
  
  export function samplePlayerPlayNoise(player, rng, clampRange = [0.5, 1.8]) {
    const sigma = latentV_playSigma(player);
    const raw = rng.normal(1.0, sigma);
    return Math.max(clampRange[0], Math.min(clampRange[1], raw));
  }
  
  export function updateMomentum(prevMomentum, eventImpact, offenseTeam, defenseTeam, rng) {
    const impact = clamp01(eventImpact);
  
    const offDisc = teamPsychMean(offenseTeam, "discipline");
    const defDisc = teamPsychMean(defenseTeam, "discipline");
    const offStab = teamPsychMean(offenseTeam, "emotionalStability");
    const defStab = teamPsychMean(defenseTeam, "emotionalStability");
  
    const offDamp = clamp01(0.4 * offDisc + 0.6 * offStab);
    const defDamp = clamp01(0.4 * defDisc + 0.6 * defStab);
    const avgDamp = clamp01((offDamp + defDamp) / 2);
  
    const maxSwing = lerp(0.4, 1.4, 1 - avgDamp);
    const swingDirection = impact >= 0 ? 1 : -1;
    const baseSwing = maxSwing * impact * swingDirection;
  
    const randomJitter = rng.normal(0, 0.1 * impact);
  
    let next = prevMomentum + baseSwing + randomJitter;
    next *= 0.9; // regression to 0
    if (next > 1) next = 1;
    if (next < -1) next = -1;
    return next;
  }
  
  function teamPsychMean(team, key) {
    const vals = [];
    for (const p of team.roster || []) {
      const L = ensureLatentProfile(p);
      vals.push(L.P.get(key, 0.5));
    }
    return avg(vals, 0.5);
  }
  
  // -----------------------------------------------------------------------------
  // Composite: prepare league for simulation
  // -----------------------------------------------------------------------------
  /**
   * - Ensure every player has a LatentProfile wrapper
   * - Compute team unit profiles
   */
  export function assignLatentProfilesToLeague(league) {
    for (const p of listPlayers(league)) ensureLatentProfile(p);
  }
  export function prepareLeagueForSimulation(league) {
    assignLatentProfilesToLeague(league);
    computeAllTeamUnitProfiles(league);
  }
  
  // End of file
  