// game_engine.js
// -----------------------------------------------------------------------------
// High-level NFL-style game engine for Layer3 teams.
//
// This file intentionally has **no external imports** other than
// what simulation.html will import from it. It only relies on the shape
// of the Team objects produced by data_models.js:
//
//   team.teamId        (string)
//   team.teamName      (string)
//   team.unitProfiles  (offense / defense / special)
//   team.getStarter(pos), team.depthChart[pos]
//
// Exports:
//   - simulateGame(homeTeam, awayTeam, options?) -> GameResult
//   - simulateGameSeries(homeTeam, awayTeam, n, options?) -> [GameResult]
//   - formatGameSummary(result) -> string (human-readable summary)
// -----------------------------------------------------------------------------

import { sampleRunOutcome, samplePassOutcome } from './micro_engine.js';
import { updateMomentum } from "./random_models.js";

// -----------------------------------------------------------------------------
// PRNG (deterministic, seedable) – Mulberry32
// -----------------------------------------------------------------------------
class RNG {
    constructor(seed) {
      // Force seed into 32-bit uint
      this._state = seed >>> 0;
      if (this._state === 0) {
        this._state = 0x12345678;
      }
    }
  
    next() {
      // Returns float in [0, 1)
      let t = (this._state += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  
    nextInt(max) {
      return Math.floor(this.next() * max);
    }
  
    nextRange(min, max) {
      return min + (max - min) * this.next();
    }

    normal(mean = 0, std = 1) {
        // Box–Muller using this RNG's stream
        let u = 0, v = 0;
        while (u === 0) u = this.next();
        while (v === 0) v = this.next();
        const mag = Math.sqrt(-2.0 * Math.log(u));
        const z = mag * Math.cos(2 * Math.PI * v);
        return mean + std * z;
    }
  }
  
  // -----------------------------------------------------------------------------
  // Math helpers
  // -----------------------------------------------------------------------------
  function clamp(x, min, max) {
    return x < min ? min : x > max ? max : x;
  }
  
  function logistic(x) {
    return 1 / (1 + Math.exp(-x));
  }
  
  // Box-Muller sampling for N(0, 1)
  function normal01(rng) {
    let u = 0,
      v = 0;
    while (u === 0) u = rng.next();
    while (v === 0) v = rng.next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const z0 = mag * Math.cos(2.0 * Math.PI * v);
    return z0;
  }
  
  function normal(rng, mean = 0, std = 1) {
    return mean + std * normal01(rng);
  }

  function getKickerRatingsForSide(state, side, specialOffOverride = null) {
    const kicker = side === "home" ? state.homeKicker : state.awayKicker;
    const specialOff = specialOffOverride ||
      getUnitProfiles(side === "home" ? state.homeTeam : state.awayTeam).special;
  
    const unitAcc = specialOff?.kicking?.accuracy;
    const unitPow = specialOff?.kicking?.power;
  
    let kAcc = Number.isFinite(unitAcc) ? unitAcc : 31.5;
    let kPow = Number.isFinite(unitPow) ? unitPow : 38.5;
  
    if (kicker) {
      if (Number.isFinite(kicker.rating_K_accuracy)) {
        kAcc = kicker.rating_K_accuracy;
      }
      if (Number.isFinite(kicker.rating_K_power)) {
        kPow = kicker.rating_K_power;
      }
    }
  
    return { kicker, kAcc, kPow };
  }
  
  // Simple kicker-based XP model: ~league 93–95% with spread by accuracy.
  function computeXpMakeProb(state, offenseSide) {
    const { kAcc } = getKickerRatingsForSide(state, offenseSide);
    const MEAN_ACC = 31.5;
    const STD_ACC  = 10.1;
  
    const accZ = STD_ACC > 0 ? (kAcc - MEAN_ACC) / STD_ACC : 0;
  
    // Base ~0.94, +/- ~0.03 over the league
    let p = 0.94 + 0.03 * accZ;
    return clamp(p, 0.88, 0.99);
  }
  
  // Team/units-based 2-pt model: uses offense vs defense ratings.
  function computeTwoPointMakeProb(state, offenseSide) {
    const { offenseTeam, defenseTeam } =
      offenseSide === "home"
        ? { offenseTeam: state.homeTeam, defenseTeam: state.awayTeam }
        : { offenseTeam: state.awayTeam, defenseTeam: state.homeTeam };
  
    const off = getUnitProfiles(offenseTeam).offense;
    const def = getUnitProfiles(defenseTeam).defense;
  
    const offPass = off.pass?.overall ?? 50;
    const offRun  = off.run?.overall  ?? 50;
    const defRun  = def.runFit?.overall ?? 50;
    const defCov  = def.coverage?.overall ?? 50;
  
    const offMean = (offPass + offRun) / 2;
    const defMean = (defRun + defCov) / 2;
    const diff    = offMean - defMean;  // + means offense is better
  
    // Base around 0.47 with ±0.08 or so based on diff
    let p = 0.47 + 0.0025 * diff;
    return clamp(p, 0.35, 0.60);
  }
  


  // -------------------------- Timing helpers -----------------------------------
  function isTwoMinute(state) {
    return (state.quarter === 2 || state.quarter === 4) && state.clockSec <= 120;
  }
  
  function isLateGameHurry(state, offenseSide) {
    const diff =
      offenseSide === "home"
        ? state.score.home - state.score.away
        : state.score.away - state.score.home;
  
    // Hurry-up if: late in 2nd (<= 1:30) or late in 4th (<= 4:00) and behind/tied.
    return (
      (state.quarter === 2 && state.clockSec <= 75) ||
      (state.quarter === 4 && state.clockSec <= 120 && diff <= 0) ||
      (state.quarter === 4 && state.clockSec <= 240 && diff <= -9)
    );
  }
  
  /** Seconds the play itself consumes (ball in play only). */
  function estimateInPlayTime(outcome, rng) {
    const t = (a, b) => Math.round(rng.nextRange(a, b));
  
    switch (outcome.playType) {
      case "run": {
        const long = (outcome.yardsGained || 0) >= 10;
        return t(long ? 6 : 4, long ? 10 : 8); // ~4–10s
      }
      case "pass":
        if (outcome.sack)       return t(6, 9);
        if (outcome.incomplete) return t(4, 6);
        return t(4, 8);
      case "field_goal":        return t(5, 8);
      case "punt":              return t(8, 12);
      default:                  return t(4, 7);
    }
  }
  
  /**
   * Seconds that run off the game clock between snaps (snap-to-snap minus
   * the in-play time). Only when the clock should be running.
   * If the prior play stops the clock to the next snap (incomplete, OOB in 2:00,
   * scoring, turnover, punt), this returns 0.
   */
   function estimateBetweenPlayTime(state, outcome, preState, rng, offenseSide) {
    const cfg = state.cfg || {};
  
    // If the clock should be stopped until the next snap, there is no between-play runoff.
    if (
      outcome.touchdown ||
      outcome.safety ||
      outcome.punt ||
      outcome.fieldGoalAttempt ||
      outcome.turnover ||
      outcome.incomplete ||
      state.clockSec <= 0
    ) {
      return 0;
    }
  
    // Clock manager plan (if not set yet, compute a lightweight default)
    const plan = state._clockPlan || clockManager(
      state, preState, outcome, offenseSide,
      offenseSide === "home" ? "away" : "home",
      { clockStopsAfterPlay: false }
    );
  
    // Baseline (normal vs hurry) — then bias with milk-clock/hurry intent
    const hurry = isLateGameHurry(state, offenseSide);
    let base = Math.round(
      rng.nextRange(
        hurry ? cfg.betweenPlayHurryMin : cfg.betweenPlayNormalMin,
        hurry ? cfg.betweenPlayHurryMax : cfg.betweenPlayNormalMax
      )
    );
  
    // Steer toward the plan's pace target
    if (Number.isFinite(plan.paceTargetSec)) {
      // Mix target in without whipsawing randomness
      base = Math.round(0.5 * base + 0.5 * plan.paceTargetSec);
    }
  
    // Extra seconds first-down chain movement (unless in 2:00 windows)
    const gainedFirst =
      preState &&
      Number.isFinite(preState.distance) &&
      !outcome.turnover &&
      !outcome.punt &&
      !outcome.fieldGoalAttempt &&
      (outcome.yardsGained || 0) >= preState.distance;
  
    const twoMin = (state.quarter === 2 || state.quarter === 4) && state.clockSec <= 120;
    if (gainedFirst && !twoMin) {
      base += Math.round(rng.nextRange(2, 4));
    }
  
    // One-time “quarter break setup”
    if (state._quarterBreakSetup) {
      base += (cfg.quarterBreakSetupExtra || 0);
      state._quarterBreakSetup = false;
    }
  
    // Respect the play-clock cap for the next snap (40s normally, 25s after admin)
    const playCap = Math.max(3, (state.playClockSec ?? cfg.playClockNormal) - 1);
    return clamp(base, 0, playCap);
  }
  
  
  
  
  
  // -----------------------------------------------------------------------------
  // Game config / types
  // -----------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    quarterLengthSec: 900,
    numQuarters: 4,
    maxOvertimeQuarters: 1,
    allowTies: true,
  
    // Micro layer (kept)
    baseRunMean: 3.0,
    baseRunStd: 2.5,
    basePassMean: 5.0,
    basePassStd: 5.0,
    sackMeanLoss: -6,
    turnoverBaseProb: 0.02,
  
    // FG (kept but unused by new FG model)
    fgBaseProb: 0.82,          // unused now
    fgAccuracyWeight: 0.0025,  // unused now

    // FG range tuning for 4th-down decisions (not make %)
    fgBaseMaxDist: 56,         // avg “max realistic attempt” for a middling K
    fgMaxDistSpread: 4.5,      // how many yards legIndex can shift range
  
    // Punting realism
    puntBaseDistance: 45,
    puntStd: 7,
  
    // Kickoffs
    // Keep your old key if you want, but the new code uses the league average + team tilt:
    kickoffTouchbackRate: 0.85,     // legacy; ignored by doKickoff()
    kickoffTouchbackLeagueAvg: 0.65, // <-- NEW: base league average used by getKickoffTouchbackRate()
  
    // PAT strategy/quality knobs
    xpMakeProb: 0.94,
    twoPtMakeProb: 0.48,
  
    // Pace knobs
    betweenPlayNormalMin: 30,
    betweenPlayNormalMax: 40,
    betweenPlayHurryMin: 6,
    betweenPlayHurryMax: 18,
    oobRestartMin: 26,
    oobRestartMax: 36,

    // Play clock (NFL-style)
    playClockNormal: 40,
    playClockAdmin: 25,

    // Timeout / icing tweaks
    timeoutAdminSeconds: 0,   // how many game seconds a timeout consumes
    iceKickerPenalty: 0.02,   // reduce FG make prob by ~2% when iced
  
    // First play after a quarter break
    quarterBreakSetupExtra: 6,
  
    // League targeting & team tilt (for YPC/YPA and punts/game) ----
    targetYPC: 4.4,           // league yards/rush you want the sim to hover around
    targetYPA: 7.3,           // league yards/pass (incl. incompletions)
    runScaleGlobal: 0.51,     // gentle global nudge; tune after a 1k-game run
    passScaleGlobal: 1.09,    // gentle global nudge; tune after a 1k-game run
  
    useRealBaselines: false,  // flip to true when you pass per-team tables
    realBaselines: null,      // shape: { [teamName|id]: { ypc, ypa, punts, tb } }
  
    puntBaselinePerTeam: 3.7, // league-ish per-team punts/game target
  
    // Logging verbosity
    keepPlayByPlay: true,
  };
  
  
  
  function createConfig(options = {}) {
    return { ...DEFAULT_CONFIG, ...options };
  }
  
  // -----------------------------------------------------------------------------
  // Game state structures
  // -----------------------------------------------------------------------------
  function createInitialGameState(homeTeam, awayTeam, cfg, rng) {
    const homeKicker = homeTeam.getStarter("K");
    const awayKicker = awayTeam.getStarter("K");
  
    const homeQB = homeTeam.getStarter("QB");
    const awayQB = awayTeam.getStarter("QB");
  
    return {
      cfg,
      rng,
      homeTeam,
      awayTeam,

      // Play clock (for next snap)
      playClockSec: 40,          // 40 by default, 25 after admin stoppages
      _milkClock: false,         // ephemeral: offense intends to bleed clock
      _icedKicker: false,        // set when defense ices the kicker before a FG
      _clockPlan: null,          // last clockManager plan (pace/timeout/bounds)
  
      // Score
      score: { home: 0, away: 0 },
  
      // Clock
      quarter: 1,
      clockSec: cfg.quarterLengthSec,
  
      // Possession: home receives first by default; you can randomize if you like.
      possession: "home",
  
      // Field position: yards from offense goal line (0..100)
      ballYardline: 25, // after touchback-style starting position
  
      // Down & distance
      down: 1,
      distance: 10,
  
      // Drive meta
      driveId: 1,
      playId: 1,
  
      // Kickers / QBs (may be null -> we handle gracefully)
      homeKicker,
      awayKicker,
      homeQB,
      awayQB,
  
      // Momentum: offensive momentum per side (−1 .. +1, 0 = neutral)
      momentum: {
        home: 0,
        away: 0,
      },
  
      // Timeouts: 3 per half, tracked separately.
      // quarter <= 2 -> H1, quarter >= 3 -> H2.
      timeouts: {
        home: { H1: 3, H2: 3 },
        away: { H1: 3, H2: 3 },
      },
  
      // Clock intent for the NEXT offensive snap by side
      clockIntent: {
        home: {
          forceSpike: false,
          forceKneel: false,
          boundsPreference: "normal", // "normal" | "sideline" | "middle"
        },
        away: {
          forceSpike: false,
          forceKneel: false,
          boundsPreference: "normal",
        },
      },
  
      // Logs
      drives: [],
      plays: [],
      events: [],
      isFinal: false,
      winner: null,
  
      playerStats: {},
    };
  }
  
  
  function cloneScore(score) {
    return { home: score.home, away: score.away };
  }

  function getMomentumMultiplier(state, side, role) {
    // side: "home" | "away"
    // role: "offense" | "defense"
    const m = state.momentum?.[side] ?? 0; // -1..1
  
    // Keep it subtle: +/- ~5–7% on offense, +/- ~4–5% on defense
    if (role === "offense") {
      return 1 + 0.06 * m;   // if m=1 → 1.06, if m=-1 → 0.94
    } else {
      // Defense gets opposite sign influence when *they* have momentum:
      return 1 + 0.05 * m;
    }
  }
  
  
  // -----------------------------------------------------------------------------
  // Team helpers
  // -----------------------------------------------------------------------------
  function getOffenseDefense(state) {
    const offenseTeam =
      state.possession === "home" ? state.homeTeam : state.awayTeam;
    const defenseTeam =
      state.possession === "home" ? state.awayTeam : state.homeTeam;
    const offenseSide = state.possession;
    const defenseSide = offenseSide === "home" ? "away" : "home";
  
    return { offenseTeam, defenseTeam, offenseSide, defenseSide };
  }
  
  function getUnitProfiles(team) {
    // Defensive coding in case unitProfiles are missing/misnamed
    const up = team.unitProfiles || {};
    return {
      offense: up.offense || {
        pass: { overall: 60 },
        run: { overall: 60 },
      },
      defense: up.defense || {
        coverage: { overall: 60 },
        runFit: { overall: 60 },
        passRush: { overall: 60 },
      },
      special: up.special || {
        kicking: { overall: 60, accuracy: 60, power: 60 },
        punting: { overall: 60, control: 60, fieldFlip: 60 },
        coverage: 60,
        returner: 60,
      },
    };
  }

  function getTeamKey(team) {
    return team?.teamName || team?.teamId || "Unknown";
  }
  
  function getTeamBaseline(cfg, team) {
    if (!cfg.useRealBaselines || !cfg.realBaselines) return null;
    const key = getTeamKey(team);
    return cfg.realBaselines[key] || null;
  }
  
  // Smooth non-linear scaler: pushes toward target but doesn’t explode extremes.
  function smoothScale(actual, target, alpha = 0.65) {
    if (!Number.isFinite(actual) || !Number.isFinite(target) || target <= 0) return 1;
    return Math.pow(actual / target, alpha);
  }
  
  // Offense-leaning yard scalers (defense still matters via micro-engine)
  function computeRunScale(state, offenseTeam) {
    const { cfg } = state;
    const base = cfg.runScaleGlobal || 1;
    const b = getTeamBaseline(cfg, offenseTeam);
    const teamTilt = b?.ypc ? smoothScale(b.ypc, cfg.targetYPC, 0.75) : 1;
    return clamp(base * teamTilt, 0.80, 1.40);
  }
  
  function computePassScale(state, offenseTeam) {
    const { cfg } = state;
    const base = cfg.passScaleGlobal || 1;
    const b = getTeamBaseline(cfg, offenseTeam);
    const teamTilt = b?.ypa ? smoothScale(b.ypa, cfg.targetYPA, 0.70) : 1;
    return clamp(base * teamTilt, 0.80, 1.45);
  }
  
  // Team punt tendency bias: negative => go a bit more, positive => punt a bit more
  function computePuntBias(state, offenseTeam) {
    const { cfg } = state;
    const b = getTeamBaseline(cfg, offenseTeam);
    if (!b?.punts || !cfg.puntBaselinePerTeam) return 0;
    const rel = (b.punts - cfg.puntBaselinePerTeam) / cfg.puntBaselinePerTeam;
    return clamp(rel, -0.40, 0.40); // ±40% envelope
  }

  // -----------------------------------------------------------------------------
  // Diagnostics: log 4th-down decisions for offline analysis.
  // Writes to state.events when keepPlayByPlay is enabled.
  // -----------------------------------------------------------------------------
  function logFourthDownDecision(state, info) {
    if (!state.cfg?.keepPlayByPlay) return;
    try {
      state.events.push({
        type: "fourth_down_decision",
        quarter: info.quarter,
        clockSec: info.clockSec,
        offenseSide: info.offenseSide,
        offenseTeamId: info.offenseTeamId,
        offenseTeamName: info.offenseTeamName,
        defenseTeamId: info.defenseTeamId,
        defenseTeamName: info.defenseTeamName,
        down: info.down,
        distance: info.distance,
        yardline: info.yardline,
        scoreDiff: info.scoreDiff,
        inFgRange: info.inFgRange,
        rawKickDist: info.rawKickDist,
        decision: info.decision,          // "field_goal" | "punt" | "go_for_it"
        epFG: info.epFG ?? null,
        epGo: info.epGo ?? null,
        epPunt: info.epPunt ?? null,
        fgMakeProb: info.fgMakeProb ?? null,
        convProb: info.convProb ?? null,
        puntSkill: info.puntSkill ?? null,
      });
    } catch (e) {
      // don't blow up sim if logging fails
      console.warn("4th-down decision logging failed:", e);
    }
  }


  // -----------------------------------------------------------------------------
  // Approximate drive Expected Points from a yardline (0–100 from offense goal)
  // Smooth logistic, slightly boosted very close to the goal.
  // Reused by 4th-down decision logic and any EP-style diagnostics.
  // -----------------------------------------------------------------------------
  function approxDriveEP(state, yardline) {
    const y = clamp(Math.round(yardline), 1, 99);
    const x = (y - 50) / 18;           // center around midfield

    // Base logistic: ~[-0.8 .. ~4.5] over the field
    let ep = -0.9 + 4.9 * (1 / (1 + Math.exp(-x)));

    const toTD = 100 - y;

    // Extra boost inside the 10: value of “first & goal” situations
    if (toTD <= 10) {
      const t = clamp((10 - toTD) / 10, 0, 1);   // 10 → 0, 0 → 1
      ep += 0.6 * t;
    }

    return ep;
  }

  
  // Team-specific kickoff touchback rate
  function getKickoffTouchbackRate(state, kickingTeam) {
    const { cfg } = state;
    const baseLeague = Number.isFinite(cfg.kickoffTouchbackLeagueAvg) ? cfg.kickoffTouchbackLeagueAvg : 0.65;
  
    const teamB = getTeamBaseline(cfg, kickingTeam);
    const teamTB = Number.isFinite(teamB?.tb) ? teamB.tb : null;
  
    const kPow = (getUnitProfiles(kickingTeam).special?.kicking?.power ?? 38.5);
    const powerAdj = (kPow - 38.5) * 0.004; // ±0.16 tops (40–100), typically smaller
  
    let rate = (teamTB != null ? teamTB : baseLeague) + powerAdj;
    return clamp(rate, 0.10, 0.95);
  }
  

  // -----------------------------------------------------------------------------
  // Player helpers & stat accumulation
  // -----------------------------------------------------------------------------

  function getPlayerKey(player) {
    if (!player) return null;
    return (
      player.playerId ||
      player.id ||
      player.ID ||
      player.uid ||
      player.name ||
      player.fullName ||
      player.displayName ||
      null
    );
  }
  
  function getPlayerName(player) {
    if (!player) return "";
    return (
      player.displayName ||
      player.fullName ||
      player.name ||
      player.playerName ||
      player.shortName ||
      String(player.playerId || player.id || "")
    );
  }
  
  function ensurePlayerRow(state, player, side) {
    if (!player) return null;
    const key = getPlayerKey(player);
    if (!key) return null;
  
    const team = side === "home" ? state.homeTeam : state.awayTeam;
  
    if (!state.playerStats[key]) {
      state.playerStats[key] = {
        playerId: key,
        name: getPlayerName(player),
        teamId: team?.teamId ?? null,
        teamName: team?.teamName ?? null,
        side, // "home" | "away"
        position: player.position || player.pos || null,
  
        // passing
        passAtt: 0,
        passCmp: 0,
        passYds: 0,
        passTD: 0,
        passInt: 0,
  
        // rushing
        rushAtt: 0,
        rushYds: 0,
        rushTD: 0,
  
        // receiving
        targets: 0,
        receptions: 0,
        recYds: 0,
        recTD: 0,
  
        // placekicking
        fgAtt: 0,
        fgMade: 0,
        xpAtt: 0,
        xpMade: 0,
  
        // punting
        puntAtt: 0,
        puntYds: 0,
      };
    }
  
    return state.playerStats[key];
  }
  
  
  // Pull out key offensive skill players from depth chart / starters
  function getOffensiveSkillPlayers(team) {
    const qb = team.getStarter?.("QB") || null;
  
    // Depth chart can be an object like { WR: [...], RB: [...], TE: [...] }
    const dc = team.depthChart || {};
  
    const rbList = dc["RB"] || dc["HB"] || [];
    const wrList = dc["WR"] || [];
    const teList = dc["TE"] || [];
  
    const rb1 = rbList[0] || null;
    const rb2 = rbList[1] || null;
  
    const wr1 = wrList[0] || null;
    const wr2 = wrList[1] || null;
    const wr3 = wrList[2] || null;
    const wr4 = wrList[3] || null;
  
    const te1 = teList[0] || null;
    const te2 = teList[1] || null;
  
    return { qb, rb1, rb2, wr1, wr2, wr3, wr4, te1, te2 };
  }
  
  // Choose a receiving target from skill group
  function chooseReceivingTarget(skill, rng) {
    const { rb1, rb2, wr1, wr2, wr3, wr4, te1, te2 } = skill;
    const candidates = [];
  
    function add(player, baseWeight) {
      if (!player) return;
      candidates.push({ p: player, w: baseWeight });
    }
  
    // Rough modern NFL-ish target split:
    // WRs ~55–65%, TEs ~20–25%, RBs ~15–20%.
    // We implement that as relative weights; actual shares depend
    // on who is on the field.
  
    // Wide receivers
    add(wr1, 5.0);   // primary
    add(wr2, 3.6);   // strong secondary
    add(wr3, 2.3);   // slot / tertiary
    add(wr4, 0.4);   
  
    // Tight ends — give TE2 a real but smaller slice
    add(te1, 3.0);
    add(te2, 1.0);   // this alone should push TE2 into the 5–8% range
  
    // Running backs in the pass game
    add(rb1, 2.0);
    add(rb2, 1.2);
  
    if (!candidates.length) return null;
  
    const totalW = candidates.reduce((sum, c) => sum + c.w, 0);
    let r = rng.nextRange(0, totalW);
  
    for (const c of candidates) {
      if (r < c.w) {
        return c.p;
      }
      r -= c.w;
    }
  
    // Fallback; numerically we should never get here
    return candidates[candidates.length - 1].p;
  }
  



  // -----------------------------------------------------------------------------
  // Drive / Play Loop
  // -----------------------------------------------------------------------------
  
  function simulateGame(homeTeam, awayTeam, options = {}) {
    const cfg = createConfig(options);
    const seed =
      typeof options.seed === "number"
        ? options.seed
        : (Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 1e9);

    cfg.seed = seed;
    const rng = new RNG(seed);
  
    const state = createInitialGameState(homeTeam, awayTeam, cfg, rng);

    state.seed = seed;
  
    // --- Opening kickoff (coin toss -> who kicks) ---
    const kickingSide = rng.next() < 0.5 ? "home" : "away";
    // Receiving side has the first drive
    state.possession = (kickingSide === "home") ? "away" : "home";
    state.driveId = 1;

    // Start the receiving team's drive (log it), then execute the kickoff.
    // The kickoff log will show at 15:00 (see Patch B/C for logging changes).
    startNewDrive(state, null, "Opening kickoff");
    doKickoff(state, kickingSide);

  
    while (!state.isFinal) {
      simulateDrive(state);
  
      if (isEndOfRegulation(state) && !state.isFinal) {
        handleEndOfQuarterOrGame(state);
      }
    }
  
    return buildGameResult(state);
  }

  
  
// Simulate a single drive: from current state until change of possession
// (score, turnover, punt, turnover-on-downs, end of half/game).
// Simulate a single drive: from current state until change of possession
// (score, turnover, punt, turnover-on-downs, end of half/game).
function simulateDrive(state) {
    const driveId        = state.driveId;   // capture this drive's ID up front
    const startingScore   = cloneScore(state.score);
    const startingQuarter = state.quarter;
    const startingClock   = state.clockSec;
    const { offenseSide } = getOffenseDefense(state);
    const offenseTeam     = offenseSide === "home" ? state.homeTeam : state.awayTeam;
  
    const startingPlayIndex = state.plays.length;
    const drivePlays = [];
    let driveOver = false;
  
    while (!driveOver && !state.isFinal) {
      const playLog = simulatePlay(state);
      drivePlays.push(playLog);
  
      if (playLog.endOfDrive) {
        driveOver = true;
      }
  
      // End of quarter/game: we always break the drive here
      if (state.clockSec <= 0) {
        handleEndOfQuarterOrGame(state);
        driveOver = true;
      }
    }
  
    // --- Post-drive bookkeeping before we finalize the drive row ---

    const lastPlay = drivePlays[drivePlays.length - 1] || null;
    const isTD     = !!lastPlay?.touchdown;
    const isFG     = lastPlay?.playType === "field_goal";
    const isFGGood = !!lastPlay?.fieldGoalGood;
    const isFGMiss = isFG && !isFGGood;
    const isSafety = !!lastPlay?.safety;

    // If the last play was a TD and there is still time on the clock,
    // perform a PAT decision and log it as a play belonging to THIS drive.
    if (isTD && state.clockSec > 0) {
      const patLog = handlePAT(state, offenseSide);
      if (patLog) {
        drivePlays.push(patLog); // keep PAT together with scoring drive
      }
    }

    // Aggregate basic drive stats
    const totalYards = drivePlays.reduce((sum, p) => {
      const y = typeof p.yardsGained === "number" ? p.yardsGained : 0;
      if (p.playType === "run" || p.playType === "pass") return sum + y;
      return sum;
    }, 0);

    // Duration = sum of per-play clockRunoff for all plays in this drive
    const durationSec = state.plays.reduce(
      (sum, p) =>
        p.driveId === driveId
          ? sum + (Number.isFinite(p.clockRunoff) ? p.clockRunoff : 0)
          : sum,
      0
    );

    // --- Drive result label + event/log injection for end-of-quarter ---
    let resultText = "Turnover on downs";

    // Detect true quarter expiration (not a 4th-down failure)
    const quarterExpired = state.clockSec <= 0 && !lastPlay?.turnover && !isTD && !isFG && !isSafety;

    if (quarterExpired) {
      resultText = "End of quarter";

      // 🔹 Add a “quarter end” play to the log so PBP shows it
      const clockStr = formatClockFromSec(0);
      const desc = `End of Q${state.quarter}`;
      const log = {
        playId: state.playId++,
        driveId,
        quarter: state.quarter,
        clockSec: 0,
        clock: clockStr,
        gameClock: clockStr,
        offense: offenseSide,
        defense: offenseSide === "home" ? "away" : "home",
        offenseTeamId: offenseTeam.teamId,
        defenseTeamId:
          offenseSide === "home" ? state.awayTeam.teamId : state.homeTeam.teamId,
        offenseTeamName: offenseTeam.teamName,
        defenseTeamName:
          offenseSide === "home" ? state.awayTeam.teamName : state.homeTeam.teamName,
        playType: "admin",
        text: desc,
        description: desc,
        desc,
        downAndDistance: "",
        tags: ["ENDQTR"],
        isScoring: false,
        isTurnover: false,
        highImpact: false,
        yardsGained: 0,
        timeElapsed: 0,
        clockRunoff: 0,
        turnover: false,
        touchdown: false,
        safety: false,
        fieldGoalAttempt: false,
        fieldGoalGood: false,
        punt: false,
        endOfDrive: true,
      };
      state.plays.push(log);
      state.events.push({
        type: "quarter_end_play",
        quarter: state.quarter,
        description: desc,
        score: cloneScore(state.score),
      });
    } else if (lastPlay) {
      if (isTD) resultText = "TD";
      else if (isFG && isFGGood) resultText = "FG Good";
      else if (isFG && !isFGGood) resultText = "FG Miss";
      else if (isSafety) resultText = "Safety";
      else if (lastPlay.punt) resultText = "Punt";
      else if (lastPlay.turnover) resultText = "Turnover";
    }

    // --- Finalize the drive row ---
    const playIndices = drivePlays.map((_, idx) => startingPlayIndex + idx);

    state.drives.push({
      driveId,
      offense: offenseSide,
      teamId: offenseTeam.teamId,
      offenseTeamId: offenseTeam.teamId,
      result: resultText,
      startQuarter: startingQuarter,
      endQuarter: state.quarter,
      startClockSec: startingClock,
      endClockSec: state.clockSec,
      durationSec,
      yards: totalYards,
      playCount: drivePlays.length,
      playIndices,
      startScore: startingScore,
      endScore: cloneScore(state.score),
    });

  
    // Decide how the next drive should start
    if (!state.isFinal && state.clockSec > 0) {
      const quarterBreakOnly =
        state.quarter !== startingQuarter &&
        state.clockSec === state.cfg.quarterLengthSec &&
        !isTD && !isFG && !isSafety;
  
      if (quarterBreakOnly) {
        // Same offense continues; same ball spot; same down & distance.
        state.driveId += 1;
        startNewDrive(state, lastPlay, "Quarter End");
        return;
      }
  
      if (isTD || (isFG && isFGGood)) {
        // Score -> kickoff (new NFL rule: touchback to the 35).
        // Flip possession and start the new drive first so the kickoff play
        // is recorded under the receiving team's driveId.
        state.possession   = offenseSide === "home" ? "away" : "home";
        state.down         = 1;
        state.distance     = 10;
        state.driveId     += 1;
        startNewDrive(state, lastPlay, "Kickoff after score");
  
        doKickoff(state, /*kickingSide=*/ offenseSide);
        return;
      }
  
      if (isSafety) {
        // Scoring defense already has possession from applyPlayOutcome.
        // Approximate free kick result by placing at own 35 and log a kickoff-like play.
        state.ballYardline = 35;
        state.down         = 1;
        state.distance     = 10;
        state.driveId     += 1;
        startNewDrive(state, lastPlay, "Free kick after safety");
        addSpecialPlayLog(state, {
          specialType: "free_kick",
          description: "Free kick: touchback to the 35",
          timeElapsed: 0,
          offenseSide: offenseSide === "home" ? "away" : "home",
          yardsGained: 0,
        });
        return;
      }
  
      if (isFGMiss) {
        // Missed FG → defense takes over at spot or 20/25 depending on distance
        const missSpot = Math.round(state.ballYardline);
        state.possession = offenseSide === "home" ? "away" : "home";
        
        // NFL rule approximation: place at the spot of the kick (LOS + 7)
        // But minimum at the 20-yard line for long-range misses
        const newYard = Math.max(20, 100 - Math.min(99, missSpot + 7));
        state.ballYardline = newYard;
        
        state.down     = 1;
        state.distance = 10;
        state.driveId += 1;
        startNewDrive(state, lastPlay, "Change of possession after missed FG");
        return;
      }
      
  
      // Punts / interceptions / fumbles / turnover on downs: possession and spot
      // are already set by applyPlayOutcome. Just start the next drive.
      state.down     = 1;
      state.distance = 10;
      state.driveId += 1;
      startNewDrive(state, lastPlay, "New drive after change of possession");
    }
  }
  
  
  
  // Register a new drive meta entry (start placeholder)
  function startNewDrive(state, priorPlay, reason) {
    if (!state.cfg.keepPlayByPlay) return;
    const { offenseSide } = getOffenseDefense(state);
    state.playClockSec = state.cfg.playClockAdmin;
    state.events.push({
      type: "drive_start",
      driveId: state.driveId,
      offense: offenseSide,
      quarter: state.quarter,
      clockSec: state.clockSec,
      ballYardline: state.ballYardline,
      reason,
      priorPlayId: priorPlay ? priorPlay.playId : null,
    });
  }
  
  /* ----------------------- Helpers added for realism ------------------------ */
  
/**
 * Logs a PAT (XP or 2-pt) as its own play and mutates the score.
 * PAT is an **untimed** down — we do NOT change state.clockSec.
 * Assumes the TD points (6) have already been added.
 *
 * @param {Object} state
 * @param {"home"|"away"} scoringSide     // side that scored the TD
 * @param {{home:number,away:number}} [scoreBeforePAT] // score just after TD, before PAT
 */
  function handlePAT(state, scoringSide, scoreBeforePAT) {
    const rng = state.rng;
    const cfg = state.cfg || {};

    // 🔹 Define these BEFORE using them
    const offenseSide = scoringSide;
    const defenseSide = scoringSide === "home" ? "away" : "home";
    const offenseTeam = offenseSide === "home" ? state.homeTeam : state.awayTeam;
    const defenseTeam = defenseSide === "home" ? state.homeTeam : state.awayTeam;

    // PAT quality based on kicker / units
    const xpMakeProb    = computeXpMakeProb(state, offenseSide);
    const twoPtMakeProb = computeTwoPointMakeProb(state, offenseSide);

    // Score snapshot *before* PAT (after TD already applied)
    const scoreBefore = scoreBeforePAT || cloneScore(state.score);

    const scoreDiff =
      offenseSide === "home"
        ? state.score.home - state.score.away
        : state.score.away - state.score.home;

    const lateQ4 = (state.quarter >= 4 && state.clockSec <= 120);
    let attemptTwo = false;

    if (lateQ4 && scoreDiff === -2) {
      attemptTwo = true;                       // textbook "down 2" situation
    } else if (lateQ4 && scoreDiff < 0) {
      attemptTwo = rng.next() < 0.30;          // trailing late → sometimes aggressive
    } else {
      attemptTwo = rng.next() < 0.05;          // occasional 2-pt try earlier
    }

    // Identify kicker (for XP stats / PBP)
    const kicker =
      offenseSide === "home" ? state.homeKicker : state.awayKicker;
    const kickerRow = kicker ? ensurePlayerRow(state, kicker, offenseSide) : null;
    const kickerId   = getPlayerKey(kicker);
    const kickerName = getPlayerName(kicker);

    let made = false;
    let desc = "";
    let points = 0;

    if (attemptTwo) {
      // 2-point conversion
      made = rng.next() < twoPtMakeProb;
      if (made) {
        points = 2;
        if (offenseSide === "home") state.score.home += 2;
        else                        state.score.away += 2;
        desc = "two-point try is good";
        state.events.push({
          type: "score",
          subtype: "two_point",
          offense: offenseSide,
          points,
          quarter: state.quarter,
          clockSec: state.clockSec,  // same as TD time (untimed)
          score: cloneScore(state.score),
        });
      } else {
        desc = "two-point try fails";
      }
    } else {
      // Extra point (kick)
      made = rng.next() < xpMakeProb;

      if (kickerRow) {
        kickerRow.xpAtt += 1;
        if (made) kickerRow.xpMade += 1;
      }

      if (made) {
        points = 1;
        if (offenseSide === "home") state.score.home += 1;
        else                        state.score.away += 1;
        desc = "extra point is good";
        state.events.push({
          type: "score",
          subtype: "extra_point",
          offense: offenseSide,
          points,
          quarter: state.quarter,
          clockSec: state.clockSec,  // same as TD time (untimed)
          score: cloneScore(state.score),
        });
      } else {
        desc = "extra point is no good";
      }
    }

    // Score snapshot *after* PAT decision
    const scoreAfter = cloneScore(state.score);
    const clockStr   = formatClockFromSec(state.clockSec);

    // PBP text: use kicker name on XP, team on 2-pt
    let playText;
    if (attemptTwo) {
      playText = `${offenseTeam.teamName} ${desc}`;
    } else if (kickerName) {
      playText = `${kickerName} ${desc}`;
    } else {
      playText = `${offenseTeam.teamName} ${desc}`;
    }

    const log = {
      playId: state.playId++,
      driveId: state.driveId,           // PAT stays with the scoring drive
      quarter: state.quarter,
      clockSec: state.clockSec,         // unchanged (untimed)
      clock: clockStr,
      gameClock: clockStr,
      offense: offenseSide,
      defense: defenseSide,
      offenseTeamId: offenseTeam.teamId,
      defenseTeamId: defenseTeam.teamId,
      offenseTeamName: offenseTeam.teamName,
      defenseTeamName: defenseTeam.teamName,
      down: null,
      distance: null,
      ballYardline: null,
      decisionType: attemptTwo ? "two_point" : "extra_point",
      playType:    attemptTwo ? "two_point" : "extra_point",
      text: playText,
      description: playText,
      desc: playText,
      downAndDistance: "",
      tags: attemptTwo
        ? (made ? ["2PT", "SCORE"] : ["2PT"])
        : (made ? ["XP", "SCORE"] : ["XP"]),
      isScoring: made,
      isTurnover: false,
      highImpact: made,
      yardsGained: 0,
      timeElapsed: 0,          // PAT is *untimed*
      clockRunoff: 0,
      turnover: false,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
      points,                  // 0/1/2 – convenient for UI
      scoreBefore,
      scoreAfter,

      // kicker info only meaningful on XP
      kickerId:   attemptTwo ? null : kickerId,
      kickerName: attemptTwo ? null : kickerName,
    };

    state.plays.push(log);
    return log;
  }




  export function shouldAttemptTwo({
    offenseScore, defenseScore, quarter, secondsLeft,
    offenseTimeouts, defenseTimeouts, tryForTwoAggression = 0.0
  }) {
    const lead = offenseScore - defenseScore;         // before the try
    const late = (quarter === 4 && secondsLeft <= 180); // last 3:00
  
    // Default chart-ish rules
    // Trailing:
    if (lead === -2) return true;               // try to tie
    if (lead === -1) return true;               // take the lead
    // Tied:
    if (lead === 0)  return false;              // go up 7, not 8, by default
    // Leading:
    if (lead === 1)  return true;               // 1 -> 3 is often fine
    if (lead === 2)  return false;              // 2 -> 4 is rarely worth it
    if (lead >= 3 && lead <= 6) return false;   // 3–6 -> 5–8: generally kick
    if (lead >= 7 && lead <= 8) return false;   // already a “one-score”
    
    // Late-game overrides: be even *less* aggressive when already ahead or tied.
    if (late && lead >= 0) return false;
  
    // Small team slider if you want some flavor:
    return Math.random() < tryForTwoAggression * 0.25;
  }

  export function mustGoForIt({
    quarter, secondsLeft, distance, fieldPosYds,
    scoreDiff, offenseHasBall, timeoutsOffense, timeoutsDefense
  }) {
    if (!offenseHasBall) return false;
  
    const late = (quarter === 4);
    if (!late) return false;
  
    // If trailing one score (<=8) inside 90s, *never* punt regardless of 4th & distance.
    const oneScoreBehind = (scoreDiff < 0 && (-scoreDiff) <= 8);
    if (oneScoreBehind && secondsLeft <= 90) return true;
  
    // If trailing any amount with <= 40s and ≤ 1 timeout, punting is pointless.
    if (scoreDiff < 0 && secondsLeft <= 40 && timeoutsOffense <= 1) return true;
  
    // If down 2+ scores, you also don't punt under 2:00 unless it’s 4th-and-25+ at your own 5, etc.
    if (scoreDiff <= -9 && secondsLeft <= 120 && fieldPosYds < 20 && distance >= 20) {
      // Allow a very rare punt as a field-position hail mary; otherwise go.
      return true;
    }
    return false;
  }
  
  export function victoryFormationAvailable({
    quarter,
    secondsLeft,
    offenseLead,
    timeoutsDefense,
    playClock = 40,
  }) {
    // Must be leading in the 4th with time on the clock
    if (quarter !== 4 || offenseLead <= 0) return false;
    if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return false;
  
    // Don't even *think* about kneeling outside the last ~3 minutes.
    // This keeps teams from going into victory too early even if the math
    // would technically allow a multi-kneel sequence.
    if (secondsLeft > 120) return false;
  
    // Very rough but conservative "safe windows" by number of defensive timeouts.
    // These assume:
    // - You’ll take all available downs (up to 4 snaps),
    // - Defense uses TOs optimally after plays,
    // - You let the play clock bleed between snaps when TOs are gone.
    //
    // The idea: if secondsLeft is *less* than these numbers, you can kneel
    // every snap and never give the ball back.
    let safeWindow;
  
    switch (timeoutsDefense) {
      case 0:
        // With no timeouts, you can usually kill 2 full play clocks +
        // some slack (e.g. 1:20–1:30 range in real games).
        safeWindow = 3 * playClock;   // ~85s with a 40s clock
        break;
  
      case 1:
        // One timeout lets them stop one between-play bleed.
        // You still can usually burn > 1 full clock + a bit.
        safeWindow = 2* playClock + 5;       // ~45s
        break;
  
      case 2:
        // Two timeouts: they can stop things twice, so you need the clock
        // already pretty low before you can just kneel it out.
        safeWindow = 41;                  // ~half a minute
        break;
  
      default: // 3+ timeouts
        // Three timeouts: they can stop almost every between-play bleed.
        // You basically need the clock almost dead.
        safeWindow = 5;                  // very conservative
        break;
    }
  
    return secondsLeft <= safeWindow;
  }
  
  function getDefenseTimeouts(state, defenseSide) {
    const halfKey = state.quarter <= 2 ? "H1" : "H2";
    return state.timeouts?.[defenseSide]?.[halfKey] ?? 0;
  }


  // ----- Timeout / Play-clock helpers & Clock Manager --------------------------

function halfKeyForQuarter(q) { return q <= 2 ? "H1" : "H2"; }

function getTimeouts(state, side) {
  const hk = halfKeyForQuarter(state.quarter);
  return state.timeouts?.[side]?.[hk] ?? 0;
}

function consumeTimeout(state, side, reason = "timeout", displayClockSec = state.clockSec) {
  const hk = halfKeyForQuarter(state.quarter);
  if (!state.timeouts?.[side]) return false;
  if (state.timeouts[side][hk] <= 0) return false;

  state.timeouts[side][hk] -= 1;

  // Play clock becomes 25s after admin stoppage.
  state.playClockSec = state.cfg.playClockAdmin;

  // Log as an admin/special play (no yard change)
  addSpecialPlayLog(state, {
    specialType: "timeout",
    description: `${side.toUpperCase()} timeout — ${reason}`,
    timeElapsed: state.cfg.timeoutAdminSeconds || 0,
    offenseSide: side,      // the side that called it (for UI coloring)
    yardsGained: 0,
    displayClockSec
  });
  return true;
}

/**
 * Defense can "ice" the kicker before a high-leverage FG.
 * If used, logs a timeout and sets a one-shot flag that FG sim will read.
 */
 function maybeIceKicker(state, offenseSide, defenseSide) {
  const q = state.quarter;
  const snapClock = state.clockSec;
  const hk = halfKeyForQuarter(q);
  const defTO = state.timeouts?.[defenseSide]?.[hk] ?? 0;

  const offScore = offenseSide === "home" ? state.score.home : state.score.away;
  const defScore = offenseSide === "home" ? state.score.away : state.score.home;
  const margin = Math.abs(offScore - defScore);

  const lateHalf = (q === 2 && snapClock <= 60) || (q === 4);
  if (!lateHalf || defTO <= 0) return false;

  // Only ice in high-leverage, one-score-ish spots
  const shouldIce = (margin <= 3) || (q === 4 && snapClock <= 180);
  if (!shouldIce) return false;

  const ok = consumeTimeout(state, defenseSide, "ice the kicker", state.clockSec);
  if (ok) state._icedKicker = true;
  return ok;
}


/**
 * Decide pace (hurry vs milk), sideline preference, and whether to call an
 * immediate timeout after this snap. Called each snap; its outputs are used
 * by between-play timing and to insert admin plays.
 */
 function clockManager(state, preState, outcomeOrNull, offenseSide, defenseSide, { clockStopsAfterPlay }) {
  const q          = preState?.quarter ?? state.quarter;
  const snapClock  = preState?.clockSec ?? state.clockSec;

  const offScore = offenseSide === "home" ? state.score.home : state.score.away;
  const defScore = offenseSide === "home" ? state.score.away : state.score.home;
  const lead     = offScore - defScore; // from offense POV

  const offTO = getTimeouts(state, offenseSide);
  const defTO = getTimeouts(state, defenseSide);

  // ---- Pace target (hurry vs normal vs milk) ----
  let paceTarget = isLateGameHurry(state, offenseSide)
    ? (state.cfg.betweenPlayHurryMin + state.cfg.betweenPlayHurryMax) * 0.35
    : (state.cfg.betweenPlayNormalMin + state.cfg.betweenPlayNormalMax) * 0.35;

  // Milk clock if leading late in the 4th
  state._milkClock = false;
  if (q === 4 && snapClock <= 300 && lead > 0) {
    paceTarget += 8;
    state._milkClock = true;
  }
  // Extra hurry when trailing late
  if (q === 4 && snapClock <= 300 && lead < 0) {
    paceTarget -= 6;
  }
  paceTarget = clamp(paceTarget, 4, 38);

  // Bounds preference (used by your run/pass OOB modeling)
  const boundsPreference =
    ((q === 2 || q === 4) && snapClock <= 120 && lead <= 0)
      ? "sideline"
      : "normal";

  // ---- Timeouts after this play (offense *or* defense) ----
  let timeoutOffense = false;
  let timeoutDefense = false;

  if (!clockStopsAfterPlay && (q === 2 || q === 4) && snapClock > 0) {
    // Offensive 2-minute drill / save-half timeout
    if (offTO > 0) {
      const urgent   = (snapClock <= 120 && lead <= 0); // behind/tied late in half
      const saveHalf = (q === 2 && snapClock <= 35);    // pocket ~30–35s before half
      if (urgent || saveHalf) {
        timeoutOffense = true;
      }
    }

    // Defensive “stop the clock” timeouts when trailing late
    if (defTO > 0 && lead > 0) { // defense is behind
      // Very rough: use TOs in last ~2:30 of 4Q or last ~1:00 of 2Q
      const late4  = (q === 4 && snapClock <= 150);
      const late2  = (q === 2 && snapClock <= 60);
      if (late4 || late2) {
        timeoutDefense = true;
      }
    }
  }

  return {
    paceTargetSec: paceTarget,
    boundsPreference,
    timeoutOffense,
    timeoutDefense,
    tenSecRunoff: false, // hook if you ever want 10-second runoff logic
  };
}


  

  
  /**
   * Logs a kickoff play (time may be 0–6s) and sets the receiving team's
   * starting field position. Uses new rule: kickoff touchback to the 35.
   * Expects that state.possession already points to the RECEIVING team and
   * a new drive has been started.
   */
   function doKickoff(state, kickingSide) {
    const rng = state.rng;
  
    // Identify kicking & receiving teams
    const kickingTeam   = kickingSide === "home" ? state.homeTeam : state.awayTeam;
    const receivingSide = (kickingSide === "home") ? "away" : "home";
    const receivingTeam = receivingSide === "home" ? state.homeTeam : state.awayTeam;
  
    // NEW: use per-team touchback rate
    const touchbackRate = getKickoffTouchbackRate(state, kickingTeam);
    const isTouchback   = rng.next() < touchbackRate;
  
    let desc = "";
    let timeElapsed = 0;
  
    if (isTouchback) {
      // Touchback (new rule: own 35)
      const preClock = state.clockSec;
      timeElapsed = Math.round(rng.nextRange(0, 2));
      state.clockSec = Math.max(0, state.clockSec - timeElapsed);
  
      state.ballYardline = 35;
      state.down = 1;
      state.distance = 10;
  
      desc = `${kickingTeam.teamName} kickoff: touchback. ${receivingTeam.teamName} start at 35`;
  
      addSpecialPlayLog(state, {
        specialType: "kickoff",
        description: desc,
        timeElapsed,
        offenseSide: kickingSide,
        yardsGained: 0,
        displayClockSec: preClock,
      });
      return;
    }
  
    // Returned kick: choose a catch point and a return distance
    const catchAt = Math.round(rng.nextRange(-2, 5));             // -2..0 end zone, 0..5 near GL
    const returnYds = clamp(Math.round(normal(rng, 24, 8)), 10, 60);
    const endYard = clamp(Math.max(0, catchAt) + returnYds, 1, 99);
  
    const preClock = state.clockSec;
    timeElapsed = Math.max(2, Math.round(rng.nextRange(3, 6)));
    state.clockSec = Math.max(0, state.clockSec - timeElapsed);
  
    state.ballYardline = endYard;
    state.down = 1;
    state.distance = 10;
  
    const fromText = (catchAt <= 0) ? "end zone" : `OWN ${catchAt}`;
    desc = `${kickingTeam.teamName} kickoff returned ${returnYds} yards from the ${fromText} to the OWN ${endYard}`;
  
    addSpecialPlayLog(state, {
      specialType: "kickoff",
      description: desc,
      timeElapsed,
      offenseSide: kickingSide,
      yardsGained: 0,
      displayClockSec: preClock,
    });
  }
  
  
  /**
   * Generic helper to append a special play log (kickoff, free_kick, admin plays).
   */
   function addSpecialPlayLog(state, opts) {
    const {
      specialType,
      description,
      timeElapsed = 0,
      offenseSide,  // "home" | "away" for who performed the special action
      yardsGained = 0,
      displayClockSec = null
    } = opts || {};
  
    const offenseTeam = offenseSide === "home" ? state.homeTeam : state.awayTeam;
    const defenseSide = offenseSide === "home" ? "away" : "home";
    const defenseTeam = offenseSide === "home" ? state.awayTeam : state.homeTeam;
  
    const logClock   = (displayClockSec != null) ? displayClockSec : state.clockSec;
    const clockStr   = formatClockFromSec(logClock);
    const scoreSnap  = cloneScore(state.score);
  
    const log = {
      playId: state.playId++,
      driveId: state.driveId, // current drive (e.g., new drive for kickoff)
      quarter: state.quarter,
      clockSec: logClock,
      clock: clockStr,
      gameClock: clockStr,
      offense: offenseSide,
      defense: defenseSide,
      offenseTeamId: offenseTeam.teamId,
      defenseTeamId: defenseTeam.teamId,
      offenseTeamName: offenseTeam.teamName,
      defenseTeamName: defenseTeam.teamName,
      down: null,
      distance: null,
      ballYardline: state.ballYardline,
      decisionType: specialType,
      playType: specialType,
      text: description,
      description,
      desc: description,
      downAndDistance: "",
      tags: [specialType.toUpperCase()],
      isScoring: false,
      isTurnover: false,
      highImpact: false,
      yardsGained,
      timeElapsed,
      clockRunoff: timeElapsed,    // all admin time counts toward drive duration
      turnover: false,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
      scoreBefore: scoreSnap,
      scoreAfter: scoreSnap,
    };
  
    state.plays.push(log);
    return log;
  }
  

  function updateClockIntentForKneel(state) {
    const { offenseSide, defenseSide } = getOffenseDefense(state);
    const intent = state.clockIntent?.[offenseSide];
    if (!intent) return;
  
    // Only care in the 4th quarter with time left
    if (state.quarter !== 4 || state.clockSec <= 0) return;
  
    const secondsLeft = state.clockSec;
  
    // Offense lead from the offense’s POV
    const offenseScore =
      offenseSide === "home" ? state.score.home : state.score.away;
    const defenseScore =
      offenseSide === "home" ? state.score.away : state.score.home;
    const offenseLead = offenseScore - defenseScore;
  
    if (offenseLead <= 0) return;
  
    // Use defense timeouts + play clock to see if kneel-out is possible
    const timeoutsDefense = getDefenseTimeouts(state, defenseSide);
  
    const canKneel = victoryFormationAvailable({
      quarter: state.quarter,
      secondsLeft,
      offenseLead,
      timeoutsDefense,
      playClock: 40, // tweak if you ever expose this in cfg
    });
  
    if (canKneel) {
      intent.forceKneel = true;
    }
  }
  
  function updateClockIntent(state) {
    const { offenseSide } = getOffenseDefense(state);
    const intent = state.clockIntent?.[offenseSide];
    if (!intent) return;
  
    // Reset per-snap flags (we’ll re-decide every play)
    intent.forceSpike = false;
    intent.forceKneel = false;
    intent.boundsPreference = "normal";
  
    // 1) Victory formation / kneel logic (may set forceKneel = true)
    updateClockIntentForKneel(state);
  
    const quarter     = state.quarter;
    const secondsLeft = state.clockSec;
    const halfKey     = quarter <= 2 ? "H1" : "H2";
  
    const timeoutsOffense =
      state.timeouts?.[offenseSide]?.[halfKey] ?? 0;
  
    const offenseScore =
      offenseSide === "home" ? state.score.home : state.score.away;
    const defenseScore =
      offenseSide === "home" ? state.score.away : state.score.home;
    const scoreDiff = offenseScore - defenseScore;
  
    // Only do extra clock logic late in halves
    const lateHalf = (quarter === 2 || quarter === 4) && secondsLeft > 0;
    if (!lateHalf) return;
  
    // 2) When behind or tied late, favor sideline plays
    if (scoreDiff <= 0 && secondsLeft <= 120) {
      intent.boundsPreference = "sideline";
    }
  
    // 3) Simple spike logic:
    //    - behind or tied
    //    - near scoring range
    //    - < ~25s, > 8s
    //    - no timeouts
    //    - not 4th down
    const yardline       = state.ballYardline; // 0–100 from offense goal
    const inScoringRange = yardline >= 50 && yardline <= 95; // opp 40–10
  
    if (
      !intent.forceKneel &&          // don’t spike if we’re just icing the game
      scoreDiff <= 0 &&
      secondsLeft <= 25 &&
      secondsLeft >= 8 &&
      timeoutsOffense === 0 &&
      inScoringRange &&
      state.down >= 1 &&
      state.down <= 3
    ) {
      intent.forceSpike = true;
    }
  }
  

// Play simulation
function simulatePlay(state) {
  const { rng } = state;

  // Update any clock / intent state (hurry-up, spike preferences, etc.)
  updateClockIntent(state);

  const {
    offenseTeam,
    defenseTeam,
    offenseSide,
    defenseSide,
  } = getOffenseDefense(state);

  const offenseUnits = getUnitProfiles(offenseTeam).offense;
  const defenseUnits = getUnitProfiles(defenseTeam).defense;
  const specialOff   = getUnitProfiles(offenseTeam).special;

  const puntBias = computePuntBias(state, offenseTeam);

  // Snapshot of state *before* the play for logging and D&D text
  const preState = {
    down:     state.down,
    distance: state.distance,
    yardline: state.ballYardline,
    clockSec: state.clockSec,
    quarter:  state.quarter,
  };

  // Score snapshot before play (for PBP)
  const scoreBefore = cloneScore(state.score);

  // Pre-snap clock plan (pace/bounds)
  state._clockPlan = clockManager(
    state, preState, null,
    offenseSide,
    defenseSide,
    { clockStopsAfterPlay: false }
  );

  // Timeouts for current half
  const halfKey = state.quarter <= 2 ? "H1" : "H2";
  const timeoutsOffense =
    state.timeouts?.[offenseSide]?.[halfKey] ?? 0;
  const timeoutsDefense =
    state.timeouts?.[defenseSide]?.[halfKey] ?? 0;

  const offenseScore =
    offenseSide === "home" ? state.score.home : state.score.away;
  const defenseScore =
    offenseSide === "home" ? state.score.away : state.score.home;

  // Victory formation: override everything if we can mathematically kill the game
  if (
    victoryFormationAvailable({
      quarter:        state.quarter,
      secondsLeft:    state.clockSec,
      offenseLead:    offenseScore - defenseScore,
      timeoutsDefense,
      playClock:      40,
    })
  ) {
    const decision    = { type: "kneel" };
    const kneelBefore = cloneScore(state.score); // essentially same as scoreBefore here
    const playOutcome = simulateKneelPlay(state, rng);

    applyPlayOutcomeToState(state, playOutcome, preState);

    const playLog = buildPlayLog(
      state,
      decision,
      playOutcome,
      preState,
      offenseSide,
      defenseSide,
      offenseTeam,
      defenseTeam,
      kneelBefore
    );
    state.plays.push(playLog);
    return playLog;
  }

  // Situation context passed into the play-caller
  // Identify kicker for this offense
  const kicker =
    offenseSide === "home" ? state.homeKicker : state.awayKicker;

  // Prefer player-level ratings; fall back to unit profile; then league-ish defaults
  const kickerAcc =
    kicker && Number.isFinite(kicker.rating_K_accuracy)
      ? kicker.rating_K_accuracy
      : (specialOff.kicking?.accuracy ?? 31.5);

  const kickerPow =
    kicker && Number.isFinite(kicker.rating_K_power)
      ? kicker.rating_K_power
      : (specialOff.kicking?.power ?? 38.6);

  // Environment hook: you can set these on state.environment or state.weather later.
  const fgEnvAdjust =
    (state.environment && Number.isFinite(state.environment.fgRangeDelta))
      ? state.environment.fgRangeDelta
      : (state.weather && Number.isFinite(state.weather.fgRangeDelta))
        ? state.weather.fgRangeDelta
        : 0;

  const fgBaseMaxDist   = state.cfg.fgBaseMaxDist ?? 56;
  const fgMaxDistSpread = state.cfg.fgMaxDistSpread ?? 4.5;

  const situation = {
    down:     preState.down,
    distance: preState.distance,
    yardline: preState.yardline,
    quarter:  preState.quarter,
    clockSec: preState.clockSec,
    scoreDiff:
      offenseSide === "home"
        ? state.score.home - state.score.away
        : state.score.away - state.score.home,
    puntBias,
    offMomentum:   state.momentum?.[offenseSide] ?? 0,
    timeoutsOffense,
    timeoutsDefense,
    clockIntent:   state.clockIntent?.[offenseSide] ?? null,

    // NEW: FG decision context
    kickerAcc,
    kickerPow,
    fgEnvAdjust,
    fgBaseMaxDist,
    fgMaxDistSpread,
  };


  const decision = choosePlayType(
    situation,
    offenseUnits,
    defenseUnits,
    specialOff,
    rng
  );

  let playOutcome;
  switch (decision.type) {
    case "run":
      playOutcome = simulateRunPlay(state, offenseUnits, defenseUnits, rng);
      break;
    case "pass":
      playOutcome = simulatePassPlay(state, offenseUnits, defenseUnits, rng);
      break;
    case "field_goal":
      maybeIceKicker(state, offenseSide, defenseSide);
      playOutcome = simulateFieldGoal(state, offenseUnits, specialOff, rng);
      break;
    case "punt":
      playOutcome = simulatePunt(state, specialOff, rng);
      break;
    case "kneel":
      playOutcome = simulateKneelPlay(state, rng);
      break;
    case "spike":
      playOutcome = simulateSpikePlay(state, rng);
      break;
    default:
      playOutcome = simulateRunPlay(state, offenseUnits, defenseUnits, rng);
  }

  applyPlayOutcomeToState(state, playOutcome, preState);

  const playLog = buildPlayLog(
    state,
    decision,
    playOutcome,
    preState,
    offenseSide,
    defenseSide,
    offenseTeam,
    defenseTeam,
    scoreBefore
  );
  state.plays.push(playLog);

  return playLog;
}

  
  

  

// Choose between run / pass / FG / punt with realistic FG + punt distribution
function choosePlayType(situation, offenseUnits, defenseUnits, specialOff, rng) {
  const {
    down,
    distance,
    yardline,
    quarter,
    clockSec,
    scoreDiff,
    puntBias: _puntBias = 0,
    offMomentum = 0,
    clockIntent = null,
    timeoutsOffense = 0,
  } = situation;

  const offPass  = offenseUnits.pass?.overall     ?? 50;
  const offRun   = offenseUnits.run?.overall      ?? 50;
  const defCover = defenseUnits.coverage?.overall ?? 50;
  const defRun   = defenseUnits.runFit?.overall   ?? 50;

  // Helper: rough drive EP by yardline (offense perspective).
  // yardline = 0..100 from offense goal
  const approxEP = (y) => {
    const yClamped = clamp(y, 1, 99);
    const dist = 100 - yClamped; // yards to opponent goal
    if (dist >= 80) return 0.4;   // own 20 or worse
    if (dist >= 65) return 0.9;   // own 35-ish
    if (dist >= 50) return 1.3;   // near midfield
    if (dist >= 40) return 1.8;   // opp 40
    if (dist >= 30) return 2.3;   // opp 30
    if (dist >= 20) return 3.0;   // red zone
    if (dist >= 10) return 3.8;   // inside 10
    if (dist >= 3)  return 4.4;   // goal-to-go
    return 4.9;                   // inside ~3
  };

  // ---------------- Hard clock overrides: kneel / spike ----------------
  if (clockIntent) {
    if (clockIntent.forceKneel && clockSec > 0 && down >= 1 && down <= 4) {
      return { type: "kneel" };
    }
    if (clockIntent.forceSpike && clockSec > 0 && down >= 1 && down <= 3) {
      return { type: "spike" };
    }
  }

  // ---------------- Momentum wiring ----------------
  const m = clamp(offMomentum, -1, 1);
  const basePuntBias = clamp(_puntBias, -0.40, 0.40);
  const puntBias     = clamp(basePuntBias - 0.20 * m, -0.40, 0.40);

  // ---------------- Base run/pass tendency ----------------
  const passAdv = (offPass - defCover) / 18;
  let basePassProb = logistic(passAdv) - 0.14;

  const isObviousPass =
    (down === 3 && distance >= 6) ||
    (down === 4 && distance >= 3);

  const isObviousRun =
    distance <= 2 && down <= 3 && yardline <= 80;

  if (isObviousPass) basePassProb = Math.max(basePassProb, 0.65);
  if (isObviousRun)  basePassProb = Math.min(basePassProb, 0.32);

  if (quarter >= 4 && clockSec <= 120 && scoreDiff < 0) {
    basePassProb = Math.max(basePassProb, 0.75);
  }

  basePassProb += 0.03 * m;
  basePassProb = clamp(basePassProb, 0.30, 0.72);

  // -------------------------------------------------------------------
  // Late-clock FG override on ANY down (1st–3rd as well as 4th)
  // -------------------------------------------------------------------
  (function lateClockFgOverride() {
    const isEndOfHalf = (quarter === 2 || quarter === 4);
    if (!isEndOfHalf || clockSec <= 0) return;

    const veryLate   = clockSec <= 6;   // basically one snap left
    const lateWindow = clockSec <= 12;  // one play + hurry FG, maybe

    const yardsToGoalLate = 100 - yardline;
    const rawKickDistLate = yardsToGoalLate + 17;

    const kAcc = Number.isFinite(situation.kickerAcc)
      ? situation.kickerAcc
      : (specialOff.kicking?.accuracy ?? 31.5);

    const kPow = Number.isFinite(situation.kickerPow)
      ? situation.kickerPow
      : (specialOff.kicking?.power ?? 38.6);

    const meanAcc = 31.5;
    const stdAcc  = 10.08;
    const meanPow = 38.63;
    const stdPow  = 10.26;

    const accZ = stdAcc > 0 ? (kAcc - meanAcc) / stdAcc : 0;
    const powZ = stdPow > 0 ? (kPow - meanPow) / stdPow : 0;
    const legZ = 0.3 * accZ + 0.7 * powZ;

    const baseMax = situation.fgBaseMaxDist   ?? 56;
    const spread  = situation.fgMaxDistSpread ?? 4.5;

    let maxFgDist = baseMax + spread * legZ;

    const envAdj = Number.isFinite(situation.fgEnvAdjust)
      ? situation.fgEnvAdjust
      : 0;
    maxFgDist += envAdj;
    maxFgDist = clamp(maxFgDist, 45, 72);

    const inFgRangeLate = rawKickDistLate <= maxFgDist;
    if (!inFgRangeLate) return;

    const postDiff = scoreDiff + 3;
    const fgHelpsInQ4 = (scoreDiff <= 0 && postDiff >= 0);

    let shouldKickNow = false;

    if (quarter === 4) {
      if (veryLate && fgHelpsInQ4) {
        shouldKickNow = true;
      }
    } else {
      if (veryLate || (lateWindow && timeoutsOffense === 0)) {
        shouldKickNow = true;
      }
    }

    if (shouldKickNow) {
      situation._forceFieldGoal = true;
    }
  })();

  if (situation._forceFieldGoal) {
    return { type: "field_goal" };
  }

  // ---------------------------------------------------------------------
  // 4th-DOWN LOGIC (FG / PUNT / GO) – FG + punt EP use field position,
  // kicker, and punter quality instead of flat league constants.
  // ---------------------------------------------------------------------
  if (down === 4) {
    const yardsToGoal = 100 - yardline;
    const rawKickDist = yardsToGoal + 17;

    const kAcc = Number.isFinite(situation.kickerAcc)
      ? situation.kickerAcc
      : (specialOff.kicking?.accuracy ?? 31.5);

    const kPow = Number.isFinite(situation.kickerPow)
      ? situation.kickerPow
      : (specialOff.kicking?.power ?? 38.6);

    const meanAcc = 31.5;
    const stdAcc  = 10.08;
    const meanPow = 38.63;
    const stdPow  = 10.26;

    const accZ = stdAcc > 0 ? (kAcc - meanAcc) / stdAcc : 0;
    const powZ = stdPow > 0 ? (kPow - meanPow) / stdPow : 0;
    const legZ = 0.3 * accZ + 0.7 * powZ;

    const baseMax = situation.fgBaseMaxDist   ?? 56;
    const spread  = situation.fgMaxDistSpread ?? 4.5;

    let maxFgDist = baseMax + spread * legZ;

    const envAdj = Number.isFinite(situation.fgEnvAdjust)
      ? situation.fgEnvAdjust
      : 0;
    maxFgDist += envAdj;
    maxFgDist = clamp(maxFgDist, 45, 72);

    const inFgRange = rawKickDist <= maxFgDist;

    const secLeft = clockSec;
    const oneScore = Math.abs(scoreDiff) <= 8;
    const under2   = (quarter >= 4 && secLeft <= 120);
    const under5   = (quarter >= 4 && secLeft <= 300);

    const deepOwn  = yardline <= 35;
    const midField = yardline > 35 && yardline < 50;
    const plusTerr = yardline >= 50;

    const shortYds = distance <= 2;
    const medYds   = distance > 2 && distance <= 6;
    const longYds  = distance > 5;

    const goPlayType = () =>
      rng.next() < basePassProb ? "pass" : "run";

    // ----------------------------
    // HARD end-game overrides
    // ----------------------------

    // (A) Very late, one-score game: never punt; FG only if it ties / takes lead.
    if (quarter === 4 && oneScore && secLeft <= 90) {
      if (inFgRange && scoreDiff >= -3 && scoreDiff <= 0) {
        if (shortYds) {
          let goProb = 0.30;
          goProb += (-puntBias) * 0.20;
          goProb = clamp(goProb, 0.10, 0.65);
          if (rng.next() < goProb) return { type: goPlayType() };
        }
        return { type: "field_goal" };
      }

      // If FG doesn’t tie or lead (down 4–8), must go.
      return { type: goPlayType() };
    }

    // (B) Trailing by any amount with <=60s: punting is pointless
    if (quarter === 4 && scoreDiff < 0 && secLeft <= 60) {
      return { type: goPlayType() };
    }

    // (C) Down 2+ scores late: never punt
    if (quarter === 4 && scoreDiff <= -9 && secLeft <= 210) {
      return { type: goPlayType() };
    }

    // ----------------------------
    // 1) Deep in own territory
    // ----------------------------
    if (deepOwn) {
      const desperate = quarter >= 3 && scoreDiff < -14 && shortYds;
      let goProb = desperate ? 0.25 : 0.03;
      goProb += (-puntBias) * (desperate ? 0.20 : 0.08);
      goProb = clamp(goProb, 0.00, 0.55);

      if (rng.next() < goProb) return { type: goPlayType() };
      return { type: "punt" };
    }

    // ----------------------------
    // 2) Midfield (own 36 – opp 39)
    // ----------------------------
    if (midField) {
      // Midfield long FGs: only very rare and only in range + late/close.
      if (inFgRange && rawKickDist >= 63) {
        const lateClose = (quarter >= 4 && oneScore);
        if (lateClose) {
          let kickProb = 0.50;
          if (scoreDiff < 0) kickProb += 0.10;
          kickProb += (puntBias) * 0.10;
          kickProb = clamp(kickProb, 0.30, 0.75);

          if (rng.next() < kickProb) return { type: "field_goal" };
        }
      }

      if (shortYds) {
        let goProb = 0.25;
        if (quarter >= 2) goProb += 0.10;
        if (scoreDiff < 0) goProb += 0.15;
        if (under5 && oneScore && scoreDiff < 0) goProb += 0.20;
        goProb += (-puntBias) * 0.25;
        goProb = clamp(goProb, 0.25, 0.75);

        if (rng.next() < goProb) return { type: goPlayType() };
        return { type: "punt" };
      }

      const yolo = clamp((-puntBias) * 0.20, 0.00, 0.30);
      if (rng.next() < yolo) return { type: goPlayType() };
      return { type: "punt" };
    }

    // ----------------------------
    // 3) Plus territory (opp 40+): main FG vs GO vs PUNT decision
    // ----------------------------
    if (plusTerr) {
      const yardsToGoalPlus = 100 - yardline;
      const isRedZone       = yardsToGoalPlus <= 20;
      const inside10        = yardsToGoalPlus <= 10;
      const goalLine        = yardsToGoalPlus <= 2;   // 1–2 yard line

      const sweetSpot = (yardline >= 50 && yardline <= 95); // opp 40–15
      const chipZone  = isRedZone && inside10;
      const longZone  = yardline < 50 && inFgRange;

      const goPlayTypeLocal = () =>
        rng.next() < basePassProb ? "pass" : "run";

      // -------- HARD goal-line anti-chip-FG rule ----------
      // If it's 4th and short at the 1–2, you basically never kick
      // *unless* the clock situation absolutely forces "take the points".
      if (goalLine && shortYds) {
        // FG ties or takes the lead from offense POV
        const fgSwingsGame =
          scoreDiff <= 0 && (scoreDiff + 3) >= 0;

        const endOfHalfDesperation =
          (quarter === 2 && clockSec <= 15);

        const endOfGameCritical =
          (quarter === 4 && clockSec <= 35 && fgSwingsGame);

        // In all other situations: just *go* from the 1–2.
        if (!endOfHalfDesperation && !endOfGameCritical) {
          return { type: goPlayType() };
        }
      }

      // ---- Approximate FG make probability (same flavor as simulateFieldGoal) ----
      const rawKickDistFG = yardsToGoalPlus + 17;

      const powerShift = 4.5 * legZ;
      const effDist    = Math.max(18, rawKickDistFG - powerShift);

      const tooFarMult = clamp(1 - (effDist - 65) / 10, 0, 1);
      const baseCenter = 56;
      const baseScale  = 6.0;
      const accCenterShift = 1.4 * accZ;
      const center     = baseCenter + accCenterShift;

      const xFG = (effDist - center) / baseScale;
      let fgMakeProb = (1 / (1 + Math.exp(xFG))) * tooFarMult;

      if (effDist <= 40) {
        const t = clamp((40 - effDist) / 22, 0, 1);
        fgMakeProb += 0.03 + 0.07 * t;
      }
      fgMakeProb = clamp(fgMakeProb, 0.00, 0.985);

      // ---- 4th-down conversion probability by distance ----
      let convProb;
      if (shortYds)      convProb = 0.65;
      else if (medYds)   convProb = 0.40;
      else               convProb = 0.15;

      // ---- EP if we GO (depends on exact yardline, not just "red zone") ----
      const expGainOnConv = Math.min(distance + 1, 6);
      const ySuccess      = clamp(yardline + expGainOnConv, 1, 99);
      const epSuccess     = approxEP(ySuccess);

      const oppStartOnFail = 100 - yardline; // opponent gets ball at LOS
      const oppEPOnFail    = approxEP(oppStartOnFail);

      let goEP = convProb * epSuccess + (1 - convProb) * (-0.9 * oppEPOnFail);

      // ---- EP if we KICK FG ----
      let fgEP = 3 * fgMakeProb; // scoreboard EP; KO aftermath ignored for simplicity

      // ---- EP if we PUNT (depends on punter + pin vs touchback) ----
      const MEAN_CTRL = 30.94;
      const STD_CTRL  = 10.95;
      const MEAN_FLIP = 41.75;
      const STD_FLIP  = 9.78;

      const pControl   = specialOff.punting?.control   ?? MEAN_CTRL;
      const pFieldFlip = specialOff.punting?.fieldFlip ?? MEAN_FLIP;

      const zCtrl = STD_CTRL > 0 ? (pControl   - MEAN_CTRL) / STD_CTRL : 0;
      const zFlip = STD_FLIP > 0 ? (pFieldFlip - MEAN_FLIP) / STD_FLIP : 0;
      const puntSkillIndex = 0.4 * zCtrl + 0.6 * zFlip;

      const basePuntDist = 47;
      const expPuntDist  = clamp(basePuntDist + 5.5 * puntSkillIndex, 25, 75);

      const grossLanding = yardline + expPuntDist;
      const oppStartY = grossLanding >= 100
        ? 20               // touchback
        : Math.max(1, 100 - Math.round(grossLanding));

      const oppEP = approxEP(oppStartY);

      // Map opponent EP into a positive "punt utility" ~[0.4, 1.1]
      let puntEP = 1.2 - 0.25 * oppEP;
      puntEP = clamp(puntEP, 0.2, 0.6);

      // ---- Game context tweaks ----
      const lateQ4   = (quarter === 4 && clockSec <= 300);
      const oneScoreLate = Math.abs(scoreDiff) <= 8;

      if (lateQ4 && scoreDiff < 0 && oneScoreLate) {
        // trailing one score late → favor GO over pure EP
        goEP  += 0.4;
        puntEP -= 0.2;
      } else if (lateQ4 && scoreDiff > 0 && oneScoreLate) {
        // small lead late → FGs/punts relatively more attractive
        fgEP   += 0.2;
        puntEP += 0.2;
      }

      // ---- Team style from puntBias (conservative vs aggressive) ----
      const style = clamp(puntBias, -0.4, 0.4);
      if (style > 0) { // conservative
        fgEP   *= 1 + 0.15 * style;
        goEP   *= 1 - 0.35 * style;
        puntEP *= 1 + 0.45 * style;
      } else {         // aggressive
        const a = -style;
        fgEP   *= 1 - 0.05 * a;
        goEP   *= 1 + 0.45 * a;
        puntEP *= 1 - 0.35 * a;
      }

      // ---- Special-case tweaks inside chip zone (inside opp 10) ----
      if (chipZone && shortYds) {
        if ((quarter === 2 && clockSec <= 40) ||
            (quarter === 4 && scoreDiff >= 0 && clockSec <= 180)) {
          // End-of-half or protecting lead → take the points a bit more
          fgEP += 0.5;
          goEP -= 0.4;
        } else {
          // Normal mid-game: favor going for TD, not chip FG
          fgEP -= 0.7;
          goEP += 0.4;
        }
      }

      // ---- Long FGs: smooth downweighting, not hard cutoff ----
      if (rawKickDistFG >= 57) {
        const longFactor = clamp(1 - (rawKickDistFG - 57) / 12, 0.15, 1);
        fgEP *= longFactor;
      }

      // ---- Convert EPs into decision weights via softmax ----
      const temp = 0.9;
      const wFG  = Math.exp(fgEP / temp);
      const wGo  = Math.exp(goEP / temp);
      const wP   = Math.exp(puntEP / temp);

      const totalW = wFG + wGo + wP;
      const r = rng.next() * totalW;

      if (r < wFG) return { type: "field_goal" };
      if (r < wFG + wGo) return { type: goPlayTypeLocal() };
      return { type: "punt" };
    }

    // ----------------------------
    // 4) Fallback conservative behavior
    // ----------------------------
    if (inFgRange && !shortYds) {
      let kickProb = 0.65;
      if (scoreDiff >= 0 && under5) kickProb += 0.05;
      kickProb += (puntBias) * 0.05;
      kickProb = clamp(kickProb, 0.45, 0.85);

      if (rng.next() < kickProb) return { type: "field_goal" };
      return { type: goPlayType() };
    }

    const tinyGo = clamp((-puntBias) * 0.10, 0.00, 0.25);
    if (rng.next() < tinyGo) return { type: goPlayType() };
    return { type: "punt" };
  }

  // ---------------- Non-4th downs: run vs pass ----------------
  return rng.next() < basePassProb ? { type: "pass" } : { type: "run" };
}




  // ------------------------ Clock-management plays -----------------------------

  function simulateKneelPlay(state, rng) {
      // Simple kneeldown: small loss, short in-play time, clock will run
      const yards = rng.nextRange(-3, -1);
      const inPlayTime = rng.nextRange(1.5, 2.5); // ~1–2s
    
      return {
        playType: "run",   // treated like a run for chains logic
        yardsGained: yards,
        inPlayTime,
        timeElapsed: inPlayTime,
        turnover: false,
        interception: false,
        sack: false,
        completion: false,
        incomplete: false,
        outOfBounds: false,
        touchdown: false,
        safety: false,
        fieldGoalAttempt: false,
        fieldGoalGood: false,
        punt: false,
        endOfDrive: false,
        kneel: true,
      };
    }
  
  function simulateSpikePlay(state, rng) {
    // Immediate incomplete pass to stop clock; no yards
    const inPlayTime = rng.nextRange(1, 1.5); // ~1–2s
  
    return {
      playType: "pass",  // important so the incomplete/clock logic kicks in
      yardsGained: 0,
      inPlayTime,
      timeElapsed: inPlayTime,
      turnover: false,
      interception: false,
      sack: false,
      completion: false,
      incomplete: true,   // so applyPlayOutcome treats this like an incompletion
      outOfBounds: false,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
      spike: true,
    };
  }
  
  
  
  
  
  
  
  // ------------------------ Run play -----------------------------------------
  function simulateRunPlay(state, offenseUnits, defenseUnits, rng) {
        const runUnit   = offenseUnits.run || {};
        const defRun    = defenseUnits.runFit || {};
        let   runOff    = runUnit.overall ?? 50;   // changed to let
        let   frontRunD = defRun.overall ?? 50;    // changed to let
    
        const yardline = state.ballYardline;
        const down     = state.down;
        const distance = state.distance;
    
        const { offenseTeam, offenseSide, defenseSide } = getOffenseDefense(state);
        const skill = getOffensiveSkillPlayers(offenseTeam);
        
        // Choose rusher with a more realistic distribution
        const candidates = [];
        
        // RB usage: RB1 heavy, RB2 meaningful
        if (skill.rb1) candidates.push({ p: skill.rb1, w: 64 });
        if (skill.rb2) candidates.push({ p: skill.rb2, w: 25 });
        
        // Occasional WR carries (jet sweeps, end-arounds)
        if (skill.wr3) candidates.push({ p: skill.wr3, w: 3 });
        if (skill.wr2) candidates.push({ p: skill.wr2, w: 2 });
        
        // Rare designed QB run
        if (skill.qb)  candidates.push({ p: skill.qb, w: 6 });
        
        let rusher = null;
        if (candidates.length) {
          let totalW = candidates.reduce((s,c)=>s + c.w, 0);
          let r = rng.nextRange(0, totalW);
          for (const c of candidates) {
            if (r < c.w) { rusher = c.p; break; }
            r -= c.w;
          }
        }
        
        // Fallback
        if (!rusher) rusher = skill.rb1 || skill.qb || null;        
    
        // Apply momentum multipliers
        const offMult = getMomentumMultiplier(state, offenseSide, "offense");
        const defMult = getMomentumMultiplier(state, defenseSide, "defense");
    
        runOff    = clamp(runOff    * offMult,  10, 99);
        frontRunD = clamp(frontRunD * defMult,  10, 99);
    
    
        const rusherRow = ensurePlayerRow(state, rusher, offenseSide);
        const rusherId   = getPlayerKey(rusher);
        const rusherName = getPlayerName(rusher);
    
        // Box heuristic
        let boxCount = 7;
        if (yardline < 10 || yardline > 90) boxCount = 8;
        if (distance >= 8)                 boxCount = 6;
        if (down === 1 && distance >= 10)  boxCount = 6;
    
        let boxLightness = 0;
        if (boxCount <= 6) boxLightness = 0.7;
        else if (boxCount >= 8) boxLightness = -0.7;
    
        const params = {
        olRunBlockRating: runOff,
        rbVisionRating: runOff,
        rbPowerRating: runOff,
        rbElusivenessRating: runOff,
        frontRunDefRating: frontRunD,
        boxCount,
        boxLightness,
        yardline,
        down,
        distance,
        };
    
        const micro   = sampleRunOutcome(params, rng) || {};
        const raw     = Number.isFinite(micro.yardsGained) ? micro.yardsGained : 0;
        const maxGain = Math.max(0, 100 - state.ballYardline);
        const runScale = computeRunScale(state, (offenseSide === "home" ? state.homeTeam : state.awayTeam));
        const yards = Math.round(clamp(raw * runScale, -4, maxGain));
    
        const prospective = state.ballYardline + yards;
        const touchdown   = prospective >= 100;
        const safety      = prospective <= 0;
    
        // damp fumbles a bit
        const rawFumble = !!micro.fumble;
        const fumble    = rawFumble && (rng.next() < 0.6);

        // --- Out-of-bounds modeling for runs ---
        let outOfBounds = false;
        if (!touchdown && !safety) {
          // Base chance: small fraction of runs end OOB
          let pOOB = 0.06;

          const scoreDiff =
            offenseSide === "home"
              ? state.score.home - state.score.away
              : state.score.away - state.score.home;

          const late =
            (state.quarter === 2 && state.clockSec <= 120) ||
            (state.quarter === 4 && state.clockSec <= 300);

          const clockIntent = state.clockIntent?.[offenseSide] || null;

          if (late && scoreDiff <= 0) pOOB += 0.06; // trailing late => hug sideline more
          if (clockIntent && clockIntent.boundsPreference === "sideline") {
            pOOB += 0.08;
          }

          if (rng.next() < pOOB) outOfBounds = true;
        }

    
        // in-play time – if your micro engine gives it, use that, else estimate
        const inPlayTime = Number.isFinite(micro.timeElapsed)
        ? clamp(micro.timeElapsed, 3, 8.5)
        : clamp(3 + Math.abs(yards) * 0.2 + rng.nextRange(-0.5, 0.5), 3.5, 8.5);
    
        // --- accumulate rushing stats for rusher ---
        if (rusherRow) {
        rusherRow.rushAtt += 1;
        rusherRow.rushYds += yards;
        if (touchdown) rusherRow.rushTD += 1;
        }
    
        return {
        playType: "run",
        yardsGained: yards,
        inPlayTime,
        timeElapsed: inPlayTime,   // legacy field, used by clock
        turnover: fumble,
        interception: false,
        sack: false,
        completion: false,
        incomplete: false,
        outOfBounds,        // OOB flag handled by macro clock logic if you want later
        touchdown,
        safety,
        fieldGoalAttempt: false,
        fieldGoalGood: false,
        punt: false,
        endOfDrive: false,
        micro,
    
        // NEW: player wiring
        rusherId,
        rusherName,
        };
    }
  
  
  
  // ------------------------ Pass play ------------------------------------------
  function simulatePassPlay(state, offenseUnits, defenseUnits, rng) {
    const passUnit = offenseUnits.pass || {};
    const cover    = defenseUnits.coverage || {};
    const rush     = defenseUnits.passRush || {};
    let   passOff  = passUnit.overall ?? 50;  // changed to let
    let   coverDef = cover.overall ?? 50;     // changed to let
    let   rushDef  = rush.overall ?? 50;      // changed to let
  
    const yardline = state.ballYardline;
    const down     = state.down;
    const distance = state.distance;
  
    const { offenseTeam, offenseSide, defenseSide } = getOffenseDefense(state); // include defenseSide
    const skill = getOffensiveSkillPlayers(offenseTeam);
    const qb   = skill.qb || offenseTeam.getStarter?.("QB") || null;
    const rec  = chooseReceivingTarget(skill, rng);
  
    const offMult = getMomentumMultiplier(state, offenseSide, "offense");
    const defMult = getMomentumMultiplier(state, defenseSide, "defense");
  
    passOff  = clamp(passOff  * offMult, 10, 99);
    coverDef = clamp(coverDef * defMult, 10, 99);
    rushDef  = clamp(rushDef  * defMult, 10, 99);
  
    const qbRow  = ensurePlayerRow(state, qb, offenseSide);
    const recRow = ensurePlayerRow(state, rec, offenseSide);
  
    const passerId   = getPlayerKey(qb);
    const passerName = getPlayerName(qb);
    const receiverId   = getPlayerKey(rec);
    const receiverName = getPlayerName(rec);
  
    const coverageType =
      (down === 3 && distance <= 6) ? "man" :
      (down === 2 && distance >= 8) ? "zone" : "mixed";
  
    // Score diff from offense POV
    const scoreDiff =
      state.possession === "home"
        ? state.score.home - state.score.away
        : state.score.away - state.score.home;
  
    let situationalAggression = 0.5;
    if (down >= 3 && distance >= 7) situationalAggression = 0.6;
    if (state.quarter >= 4 && scoreDiff < 0) situationalAggression = 0.7;
  
    let throwAggressiveness = 0.45;
    if (distance >= 10) throwAggressiveness += 0.1;
    if (state.quarter >= 4 && scoreDiff < 0) throwAggressiveness += 0.15;
    throwAggressiveness = clamp(throwAggressiveness, 0.25, 0.9);
  
    const params = {
      qbAccuracyRating: passOff,
      qbProcessingRating: passOff,
      qbUnderPressureRating: passOff - 5,
      olPassBlockRating: passOff,
      dlPassRushRating: rushDef,
      wrRouteRating: passOff,
      wrReleaseRating: passOff,
      wrSpeedRating: clamp(passOff + 5, 10, 99),
      wrHandsRating: clamp(passOff, 10, 99),
      wrContestedCatchRating: clamp(passOff - 2, 10, 99),
      dbManRating: coverDef,
      dbZoneRating: coverDef,
      dbPressRating: clamp(coverDef - 2, 10, 99),
      dbSpeedRating: clamp(coverDef + 2, 10, 99),
      dbBallSkillsRating: coverDef,
      yardline,
      down,
      distance,
      coverageType,
      situationalAggression,
      throwAggressiveness,
    };
  
    const micro   = samplePassOutcome(params, rng) || {};
    let   raw     = Number.isFinite(micro.yardsGained) ? micro.yardsGained : 0; // changed to let
    const maxGain = Math.max(0, 100 - state.ballYardline);
    const passScale = computePassScale(state, (offenseSide === "home" ? state.homeTeam : state.awayTeam));
    let   yards = Math.round(clamp(raw * passScale, -10, maxGain));             // changed to let
  
    const sackRaw         = !!micro.sack;
    const completionRaw   = !!micro.completion;
    const interceptionRaw = !!micro.interception;
    const fumbleRaw       = !!micro.fumble;
  
    // Dampen raw turnover flags from micro-engine
    const interception = interceptionRaw && (rng.next() < 0.50);
    const fumble       = fumbleRaw       && (rng.next() < 0.50);
    const turnover     = interception || fumble;
  
    const sack       = sackRaw && (rng.next() < 0.55);
    let completion = completionRaw && !interception;
  
    // Incomplete if we didn't complete, and no INT/sack/fumble
    let incomplete = !completion && !interception && !sack && !fumble;

    // Completion boost: occasionally turn an "incomplete" into a
    // short checkdown completion, mostly affecting % but not much yardage.
    if (incomplete && !sack && !interception && !fumble) {
      const boost = 0.29; // tune 0.18–0.25 if needed
      if (rng.next() < boost) {
        completion = true;
        incomplete = false;

        // Small checkdown gain, capped so YPA doesn't blow up
        const extra = clamp(Math.round(normal(rng, 3, 2)), 0, 7);
        yards = clamp(yards + extra, -10, maxGain);
      }
    }

  
    const prospective = state.ballYardline + yards;
    const touchdown   = prospective >= 100;
    const safety      = prospective <= 0;


    // --- Out-of-bounds modeling for completed passes ---
    let outOfBounds = false;
    if (completion && !touchdown && !safety) {
      let pOOB = 0.27; // completions more likely OOB than runs

      const clockIntent = state.clockIntent?.[offenseSide] || null;
      const late =
        (state.quarter === 2 && state.clockSec <= 120) ||
        (state.quarter === 4 && state.clockSec <= 300);

      if (late && scoreDiff <= 0) pOOB += 0.08;
      if (clockIntent && clockIntent.boundsPreference === "sideline") {
        pOOB += 0.15;
      }

      if (rng.next() < pOOB) outOfBounds = true;
    }

  
    const inPlayTime = Number.isFinite(micro.timeElapsed)
      ? clamp(micro.timeElapsed, 3.5, 8.5)
      : clamp(
          3 +
            (sack ? 1.5 : 0) +
            (completion ? 0.2 * Math.max(0, yards) : 0) +
            rng.nextRange(-0.5, 0.5),
          3,
          8.5
        );
  
    // --- accumulate QB stats ---
    // Treat sacks as dropbacks but *not* official pass attempts.
    if (qbRow) {
      const ballThrown = !sack; // true for completions, incompletions, INTs

      if (ballThrown) {
        // Official pass attempt
        qbRow.passAtt += 1;

        if (completion) {
          qbRow.passCmp += 1;
          qbRow.passYds += yards;
          if (touchdown) qbRow.passTD += 1;
        }

        if (interception) {
          qbRow.passInt += 1;
        }
      }
    }

  
    // --- accumulate receiver stats ---
    if (recRow) {
      recRow.targets += 1;
      if (completion) {
        recRow.receptions += 1;
        recRow.recYds     += yards;
        if (touchdown) recRow.recTD += 1;
      }
    }
  
    return {
      playType: "pass",
      yardsGained: yards,
      inPlayTime,
      timeElapsed: inPlayTime,
      turnover,
      interception,
      sack,
      completion,
      incomplete,
      outOfBounds,  // you can wire explicit OOB later if desired
      touchdown,
      safety,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
      micro,
  
      // NEW: player wiring
      passerId,
      passerName,
      receiverId,
      receiverName,
    };
  }
  
  
  
  

  
  
// ------------------------ Field goal ----------------------------------------
function simulateFieldGoal(state, offenseUnits, specialOff, rng) {
  const { cfg } = state;
  const { offenseSide } = getOffenseDefense(state);

  // Geometric distance: LOS -> goalposts
  const yardsToGoal = 100 - state.ballYardline;
  const rawDistance = yardsToGoal + 17; // standard NFL: LOS + 17

  // ---- Kicker ability: prefer player ratings if present, else unit profile ----
  const kicker = offenseSide === "home" ? state.homeKicker : state.awayKicker;

  const unitAcc = specialOff?.kicking?.accuracy;
  const unitPow = specialOff?.kicking?.power;

  // Defaults are based on your league-wide means for K units
  let kAcc = Number.isFinite(unitAcc) ? unitAcc : 31.5;
  let kPow = Number.isFinite(unitPow) ? unitPow : 38.5;

  if (kicker) {
    // If your player objects carry these fields, we prefer them
    if (Number.isFinite(kicker.rating_K_accuracy)) {
      kAcc = kicker.rating_K_accuracy;
    }
    if (Number.isFinite(kicker.rating_K_power)) {
      kPow = kicker.rating_K_power;
    }
  }

  // Normalize vs league-ish distribution (from your table)
  const MEAN_ACC = 31.5;
  const STD_ACC  = 10.1;
  const MEAN_POW = 38.6;
  const STD_POW  = 10.3;

  const accZ = STD_ACC > 0 ? (kAcc - MEAN_ACC) / STD_ACC : 0;
  const powZ = STD_POW > 0 ? (kPow - MEAN_POW) / STD_POW : 0;

  // Leg index: mostly power, some accuracy
  const legIndex = 0.6 * powZ + 0.4 * accZ;


  // Stronger leg "shrinks" the effective distance in a smooth way
  // Roughly ±6–7 yds for extremes, usually ±2–4 yds
  const powerShift = 4.5 * legIndex;

  // Environment hook: thin air, wind, rain, etc. Interpret fgRangeDelta
  // as "extra yards of range" (same sign convention as in choosePlayType).
  const fgEnvAdjust =
    (state.environment && Number.isFinite(state.environment.fgRangeDelta))
      ? state.environment.fgRangeDelta
      : (state.weather && Number.isFinite(state.weather.fgRangeDelta))
        ? state.weather.fgRangeDelta
        : 0;

  const effDist = Math.max(18, rawDistance - powerShift - fgEnvAdjust);
  const tooFarMult = clamp(1 - (effDist - 65) / 10, 0, 1)


  // ---- Smooth logistic baseline (no hard-coded per-distance table) ----
  // Think: average NFL-ish kicker is around 50/50 somewhere in low-50s.
  const baseCenter = 56;   // effective distance where an average leg is ~50/50
  const baseScale  = 6.0;  // smaller => steeper drop with distance

  // More accurate kickers shift the center *out* a bit (they stay good longer)
  const accCenterShift = 1.4 * accZ;  // ± few yards for extremes
  const center         = baseCenter + accCenterShift;

  // Logistic make curve
  const x    = (effDist - center) / baseScale;
  let makeP  = (1 / (1 + Math.exp(x))) * tooFarMult;

  // ---- Short-range smoothing (chip shots are *very* reliable, but not perfect) ----
  if (effDist <= 40) {
    // 40 → +~0.03, 18 → +~0.10, scaled smoothly
    const t = clamp((40 - effDist) / 22, 0, 1);  // 18..40 → 1..0
    makeP += 0.03 + 0.07 * t;
  }

  // ---- Long-range damping (65+ becomes truly low percentage, but continuous) ----
  if (rawDistance >= 65) {
    const extra = (rawDistance - 65) / 5;  // 65 → 0, 70 → +1, etc
    const factor = Math.exp(-0.7 - 0.30 * extra); // smooth exponential shrink
    makeP *= factor;
  }

  // ---- Context pressure: late + close + long slightly harder ----
  const lateQuarter = state.quarter === 4 || (state.quarter === 2 && state.clockSec <= 60);
  const closeGame   = Math.abs(state.score.home - state.score.away) <= 3;
  const longKick    = effDist >= 45;

  if (lateQuarter && closeGame && longKick) {
    makeP *= 0.97;  // small tilt, not a step function
  }

  // ---- Icing the kicker: one-shot penalty when _icedKicker is set ----
  if (state._icedKicker) {
    const icePenalty = cfg.iceKickerPenalty ?? 0.02; // default ~2%
    makeP *= (1 - icePenalty);
    state._icedKicker = false; // consume flag
  }

  // Final clamp: smooth, but never 0 or 1
  makeP = clamp(makeP, 0.02, 0.995);

  const made = rng.next() < makeP;

  // Live clock on FGs: 5–9 seconds is a good range
  const timeElapsed = rng.nextRange(5, 9);

  // Kicker stats
  const kickerRow = kicker ? ensurePlayerRow(state, kicker, offenseSide) : null;
  const kickerId   = getPlayerKey(kicker);
  const kickerName = getPlayerName(kicker);

  if (kickerRow) {
    kickerRow.fgAtt += 1;
    if (made) kickerRow.fgMade += 1;
  }

  // Scoring handled in applyPlayOutcomeToState
  return {
    playType: "field_goal",
    yardsGained: 0,
    timeElapsed,
    turnover: !made,           // miss -> ball to defense
    touchdown: false,
    safety: false,
    fieldGoalAttempt: true,
    fieldGoalGood: made,
    punt: false,
    endOfDrive: true,
    kickDistance: rawDistance, // for charts by distance
    effectiveDistance: effDist,
    makeProb: makeP,           // handy for debugging / calibration
    offenseSide,
    kickerId,
    kickerName,
  };
}


  
  
  
  
// ------------------------ Punt ----------------------------------------------
function simulatePunt(state, specialOff, rng) {
    const { cfg } = state;
    const { offenseSide, offenseTeam } = getOffenseDefense(state);
  
    const pControl   = specialOff.punting?.control   ?? 30.9;
    const pFieldFlip = specialOff.punting?.fieldFlip ?? 41.8;
  
    const base = cfg.puntBaseDistance;
    const adv  = (pControl + pFieldFlip - 72.7) / 5; // around average => 0
    const mean = base + adv;
    const std  = cfg.puntStd;
  
    let distance = normal(rng, mean, std);
    distance = clamp(distance, 25, 75);

    // Chance they aim for a coffin corner inside opp 10, trading distance for pin
    let targetCorner = false;
    if (state.ballYardline >= 50) {
      const lead =
        offenseSide === "home"
          ? state.score.home - state.score.away
          : state.score.away - state.score.home;
      if (lead >= 0) {
        const pCorner = 0.45; // about half the time when punting in plus territory
        targetCorner = rng.next() < pCorner;
      }
    }

    if (targetCorner) {
      // Take a few yards off for directional control
      distance -= rng.nextRange(3, 8);
    }
  
    const timeElapsed = rng.nextRange(5, 10);
  
    // Identify punter: prefer P, fall back to K if needed
    const punter =
      offenseTeam.getStarter?.("P") ||
      offenseTeam.getStarter?.("K") ||
      null;
  
    const punterRow = punter ? ensurePlayerRow(state, punter, offenseSide) : null;
    const punterId   = getPlayerKey(punter);
    const punterName = getPlayerName(punter);
  
    if (punterRow) {
      punterRow.puntAtt += 1;
      punterRow.puntYds += distance;
    }
  
    return {
      playType: "punt",
      yardsGained: 0,
      timeElapsed,
      turnover: true,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: true,
      puntDistance: distance,
      offenseSide,
      endOfDrive: true,
  
      punterId,
      punterName,
    };
  }

  // put near applyPlayOutcomeToState in game_engine.js

function computeMomentumImpact(outcome, preState, offenseSide, state) {
    // Base: no impact for routine plays
    let impact = 0;
  
    const yards = Number.isFinite(outcome.yardsGained) ? outcome.yardsGained : 0;
    const down  = preState.down;
    const dist  = preState.distance;
  
    // 1) Scoring plays
    if (outcome.touchdown) {
      impact += 0.9;  // huge swing for offense
    } else if (outcome.fieldGoalGood) {
      impact += 0.6;
    } else if (outcome.safety) {
      // from offense POV, disaster
      impact -= 0.9;
    }
  
    // 2) Turnovers (non-safety)
    if (outcome.turnover && !outcome.safety && !outcome.fieldGoalAttempt && !outcome.punt) {
      impact -= 0.8;
    }
  
    // 3) Explosive plays for offense (20+ gains)
    if ((outcome.playType === "run" || outcome.playType === "pass") && yards >= 20) {
      impact += 0.4;
    }
  
    // 4) Drive-ending negative: sack or TFL on key down
    if (outcome.sack && yards <= -7 && down >= 3) {
      impact -= 0.5;
    }

      // Missed FG: medium negative for the offense
    if (outcome.fieldGoalAttempt && !outcome.fieldGoalGood) {
      impact -= 0.4;
    }
  
    // 5) 3-and-out or big stop: handle at drive-level if you want.
    //   You can pass a small negative impact from simulateDrive
    //   when a drive is 3 plays and ends without points.
  
    // Clamp to [-1, 1] just in case multiple conditions add up
    if (impact > 1) impact = 1;
    if (impact < -1) impact = -1;
    return impact;
  }
  
  function applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide) {
    if (!state.momentum) {
      state.momentum = { home: 0, away: 0 };
    }
  
    try {
      const impact = computeMomentumImpact(outcome, preState, offenseSide, state);
      if (!impact) return;
  
      const offenseTeam = offenseSide === "home" ? state.homeTeam : state.awayTeam;
      const defenseTeam = offenseSide === "home" ? state.awayTeam : state.homeTeam;
  
      const prevOff = state.momentum[offenseSide] ?? 0;
      const prevDef = state.momentum[defenseSide] ?? 0;
  
      const newOff = updateMomentum(prevOff,  impact, offenseTeam, defenseTeam, state.rng);
      const newDef = updateMomentum(prevDef, -impact, defenseTeam, offenseTeam, state.rng);
  
      state.momentum[offenseSide] = newOff;
      state.momentum[defenseSide] = newDef;
    } catch (e) {
      console.warn("Momentum update failed:", e);
    }
  }
  

  
  
  // -----------------------------------------------------------------------------
  // Apply outcome to game state
  // -----------------------------------------------------------------------------
  function applyPlayOutcomeToState(state, outcome, preState) {
    const { offenseSide, defenseSide } = getOffenseDefense(state);
    const rng = state.rng;
  
    const playType =
      outcome.playType ||
      (outcome.fieldGoalAttempt ? "field_goal" : outcome.punt ? "punt" : "run");
  
    const isRun  = playType === "run";
    const isPass = playType === "pass";
    const isFG   = !!outcome.fieldGoalAttempt;
    const isPunt = !!outcome.punt;
  
    const isCompletion   = !!outcome.completion;
    const isSack         = !!outcome.sack;
    const isInterception = !!outcome.interception;
    const isTurnover     = !!outcome.turnover;
  
    const isIncompletion =
      isPass && !isCompletion && !isInterception && !isSack;
  
    const isScorePlay = !!(
      outcome.touchdown ||
      outcome.safety ||
      outcome.fieldGoalGood
    );
  
    // Any play that actually flips who has the ball at the end of the down
    const isChangeOfPossessionPlay =
      isPunt || isTurnover || outcome.safety || (isFG && !outcome.fieldGoalGood);
  
    // ---------------- Clock: in-play + between-play (contextual) ----------------
    const prevClock = state.clockSec;
  
    // Prefer simulator-provided in-play time; else estimate from context
    let inPlayTime = Number.isFinite(outcome.inPlayTime)
      ? outcome.inPlayTime
      : estimateInPlayTime(
          { playType, sack: isSack, incomplete: isIncompletion },
          rng
        );
  
    // Snap→whistle sanity clamp (live action only)
    inPlayTime = clamp(inPlayTime, 4.7, 9.0);
  
    // Late-clock windows where going out of bounds actually stops the clock
    const under2FirstHalf =
      state.quarter === 2 && prevClock <= 120;
    const under5Fourth =
      state.quarter === 4 && prevClock <= 300;
    const clockStopsWindow = under2FirstHalf || under5Fourth;
  
    // Only treat explicit out-of-bounds as a rule stoppage in those windows
    const oobStopsClock = !!outcome.outOfBounds && clockStopsWindow;
  
    // Clock is stopped after: incompletions always, plus late-window OOB.
    const clockStopsAfterPlay =
      isIncompletion || oobStopsClock;
  
    // ---- Use clock manager to guide pace & timeout decisions for THIS snap ----
    const plan = clockManager(
      state, preState, outcome, offenseSide, defenseSide,
      { clockStopsAfterPlay }
    );
    state._clockPlan = plan; // so between-play timing can read paceTargetSec, etc.
    
    let between = clockStopsAfterPlay
      ? 0
      : estimateBetweenPlayTime(state, outcome, preState, rng, offenseSide);
    
    // Timeouts AFTER the play, before the next snap.
    // We treat both offense and defense symmetrically here.
    if (!clockStopsAfterPlay && state.clockSec > 0) {
      if (plan.timeoutOffense) {
        const ok = consumeTimeout(state, offenseSide, "save clock", state.clockSec);
        if (ok) {
          between = 0; // timeout stops the clock instead of letting runoff happen
        }
      } else if (plan.timeoutDefense) {
        const ok = consumeTimeout(state, defenseSide, "stop clock", state.clockSec);
        if (ok) {
          between = 0;
        }
      }
    }
    
  
    // Apply total runoff, enforce 2:00 warnings in 2Q and 4Q
    let newClock = Math.max(0, prevClock - (inPlayTime + between));
  
    if (
      (state.quarter === 2 || state.quarter === 4) &&
      prevClock > 120 &&
      newClock < 120
    ) {
      newClock = 120;
    }
  
    const clockRunoff = Math.max(0, prevClock - newClock);
    outcome.clockRunoff = clockRunoff; // used by drives/TOP
    state.playClockSec = state.cfg.playClockNormal;
    state.clockSec = newClock;
  
    // ---------- Special case: Incomplete pass — no yardline change ----------
    if (isIncompletion) {
      // Series handling at prior LOS
      if (state.down === 4) {
        // Turnover on downs at the LOS
        const spotLOS = preState ? preState.yardline : state.ballYardline;
        state.possession    = (offenseSide === "home") ? "away" : "home";
        state.ballYardline  = 100 - clamp(spotLOS, 1, 99);
        state.down          = 1;
        state.distance      = 10;
        outcome.endOfDrive  = true;
  
        state.events.push({
          type: "turnover_on_downs",
          offense: offenseSide,
          defense: defenseSide,
          quarter: state.quarter,
          clockSec: state.clockSec,
          score: cloneScore(state.score),
        });
      } else {
        // Just the next down; distance & spot unchanged
        state.down += 1;
      }
      state.playId += 1;
      return;
    }
  
    // ------------------------------- Results ------------------------------------
  
    // Field goal
    if (isFG) {
      if (outcome.fieldGoalGood) {
        if (offenseSide === "home") state.score.home += 3;
        else                        state.score.away += 3;
  
        state.events.push({
          type: "score",
          subtype: "field_goal",
          offense: offenseSide,
          points: 3,
          quarter: state.quarter,
          clockSec: state.clockSec,
          score: cloneScore(state.score),
        });
      }
  
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
  
      // Drive ends; next drive (kickoff or change) handled in simulateDrive
      state.down = 1;
      state.distance = 10;
      state.playClockSec = state.cfg.playClockAdmin; // admin setup after FG try
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // Punt – flip field
    if (isPunt) {
      const los = state.ballYardline; // 0–100 from offense goal
      const distance = Math.max(0, outcome.puntDistance || 0);
      const landing = los + distance;
  
      state.possession = offenseSide === "home" ? "away" : "home";
  
      if (landing >= 100) {
        // Punt into end zone → touchback to receiving 20
        state.ballYardline = 20;
      } else {
        // Flip field for receiving team
        state.ballYardline = Math.max(1, 100 - Math.round(landing));
      }
  
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
  
      state.down = 1;
      state.distance = 10;
      state.playClockSec = state.cfg.playClockAdmin; // change of possession/admin
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // Normal offensive play (run/pass)
    let newYard = state.ballYardline + (outcome.yardsGained || 0);
  
    // Safety candidate (ball carrier driven back toward own end zone)
    if (newYard <= 0) {
      const fieldPos  = state.ballYardline; // where the play started
      const yardsLoss = outcome.yardsGained < 0 ? -outcome.yardsGained : 0;
  
      // Only a subset of these become true safeties. Most end up as being tackled
      // very close to the goal line.
      let safetyProb = 0;
  
      if (fieldPos <= 2 && yardsLoss >= 2) {
        safetyProb = 0.38; // very backed up and big loss
      } else if (fieldPos <= 5 && yardsLoss >= 3) {
        safetyProb = 0.22;
      } else if (fieldPos <= 8 && yardsLoss >= 5) {
        safetyProb = 0.05;
      }
  
      if (rng.next() < safetyProb) {
        // True safety
        if (defenseSide === "home") {
          state.score.home += 2;
        } else {
          state.score.away += 2;
        }
        state.events.push({
          type: "score",
          subtype: "safety",
          offense: defenseSide,
          points: 2,
          quarter: state.quarter,
          clockSec: state.clockSec,
          score: cloneScore(state.score),
        });
  
        // Defense gets the ball after a safety (approximate at own 25)
        state.possession   = defenseSide;
        state.ballYardline = 25;
        state.down         = 1;
        state.distance     = 10;
        state.playClockSec = state.cfg.playClockAdmin; // change of possession/admin
        outcome.safety     = true;
        outcome.endOfDrive = true;
        applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
        state.playId += 1;
        return;
      } else {
        // Not a safety — just pinned at the 1.
        newYard = 1;
      }
    }
  
    // Touchdown (PAT handled later in simulateDrive → handlePAT)
    if (newYard >= 100) {
      if (offenseSide === "home") state.score.home += 6;
      else                        state.score.away += 6;
  
      state.events.push({
        type: "score",
        subtype: "touchdown",
        offense: offenseSide,
        points: 6,
        quarter: state.quarter,
        clockSec: state.clockSec,
        score: cloneScore(state.score),
      });
  
      outcome.touchdown   = true;
      outcome.endOfDrive  = true;
      state.playClockSec  = state.cfg.playClockAdmin; // admin setup before PAT/kickoff
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
      state.playId += 1;
      return;
    }
  
    // Turnover (non-FG / non-punt)
    if (isTurnover) {
      state.possession   = offenseSide === "home" ? "away" : "home";
      // New offense gets ball where play ended, flipped to their perspective
      state.ballYardline = 100 - clamp(newYard, 1, 99);
      state.down         = 1;
      state.distance     = 10;
      state.playClockSec = state.cfg.playClockAdmin; // change of possession/admin
      outcome.endOfDrive = true;
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
      state.playId += 1;
  
      state.events.push({
        type: "turnover",
        offense: offenseSide,
        defense: defenseSide,
        quarter: state.quarter,
        clockSec: state.clockSec,
        score: cloneScore(state.score),
      });
      return;
    }
  
    // No score, no turnover: advance ball & handle series
    // IMPORTANT: ballYardline is always "yards from CURRENT offense goal line".
    // So we *do not* flip it for the away team here.
    state.ballYardline = clamp(newYard, 1, 99);
  
    const yardsToFirst = state.distance - (outcome.yardsGained || 0);
    const gainedFirst = yardsToFirst <= 0;
  
    // Handle downs logic clearly:
    if (gainedFirst) {
      // ✅ Successfully converted (even if it was 4th)
      state.down = 1;
      state.distance = 10;
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
    } else if (state.down < 4) {
      // Normal progress to next down
      state.down += 1;
      state.distance = yardsToFirst;
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
    } else {
      // Failed on 4th → turnover on downs
      state.possession   = offenseSide === "home" ? "away" : "home";
      state.ballYardline = 100 - clamp(state.ballYardline, 1, 99);
      state.down         = 1;
      state.distance     = 10;
      state.playClockSec = state.cfg.playClockAdmin;
      outcome.endOfDrive = true;
  
      state.events.push({
        type: "turnover_on_downs",
        offense: offenseSide,
        defense: defenseSide,
        quarter: state.quarter,
        clockSec: state.clockSec,
        score: cloneScore(state.score),
      });
    }
  
    state.playId += 1;
  }
  
  
  
  
  
  function formatClockFromSec(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  

  function formatDownAndDistance(down, distance, yardline) {
    const downMap = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th" };
    const downLabel = downMap[down] || `${down}th`;
    const dist = Math.max(1, Math.round(distance || 1));

    // yardline is 0–100 from offense goal line
    const y = clamp(Math.round(yardline), 0, 100);
    let spot;
    if (y === 50) {
      spot = "50";
    } else if (y < 50) {
      spot = `OWN ${y}`;
    } else {
      spot = `OPP ${100 - y}`;
    }
    return `${downLabel} & ${dist} at ${spot}`;
  }

  function describePlay(decision, outcome, offenseTeamName) {
    const team = offenseTeamName || "Offense";
    const playType = outcome.playType || decision.type || "run";
    const yards = Number.isFinite(outcome.yardsGained) ? outcome.yardsGained : 0;
    const suffixTD = outcome.touchdown ? " — TOUCHDOWN" : "";
  
    const rusherName   = outcome.rusherName   || team;
    const passerName   = outcome.passerName   || team;
    const receiverName = outcome.receiverName || "";
    const kickerName   = outcome.kickerName   || team;
    const punterName   = outcome.punterName   || team;
  
    if (playType === "kickoff") {
      return outcome.touchback
        ? `${team} kickoff for a touchback`
        : `${team} kickoff returned`;
    }
    if (playType === "extra_point") {
      return `${kickerName} ${outcome.isScoring ? "extra point is good" : "extra point is no good"}`;
    }
    if (playType === "two_point") {
      return `${team} two-point try ${outcome.isScoring ? "is good" : "fails"}`;
    }
    if (playType === "field_goal") {
      const dist = Math.round(outcome.kickDistance || 0);
      return outcome.fieldGoalGood
        ? (dist
            ? `${kickerName} field goal from ${dist} yards is good`
            : `${kickerName} field goal is good`)
        : (dist
            ? `${kickerName} misses field goal from ${dist} yards`
            : `${kickerName} misses field goal`);
    }
    if (playType === "punt") {
      const dist = Math.round(outcome.puntDistance || 0);
      return dist
        ? `${punterName} punts ${dist} yards`
        : `${punterName} punts`;
    }
    if (playType === "kneel") {
      return `${passerName} run for a loss of ${Math.abs(yards)} yards`;
    }
    if (playType === "pass") {
      if (outcome.sack) {
        return `${passerName} sacked for a loss of ${Math.abs(yards)} yards`;
      }
      if (outcome.interception) {
        return `${passerName} pass intercepted`;
      }
      if (!outcome.completion || outcome.incomplete) {
        return `${passerName} incomplete pass`;
      }
      if (yards > 0) {
        return receiverName
          ? `${passerName} to ${receiverName} for ${yards} yards${suffixTD}`
          : `${passerName} pass complete for ${yards} yards${suffixTD}`;
      }
      if (yards < 0) {
        return receiverName
          ? `${passerName} to ${receiverName} for -${Math.abs(yards)} yards`
          : `${passerName} pass complete for -${Math.abs(yards)} yards`;
      }
      return receiverName
        ? `${passerName} to ${receiverName} for no gain`
        : `${passerName} pass for no gain`;
    }
  
    // run
    if (yards > 0) return `${rusherName} run for ${yards} yards${suffixTD}`;
    if (yards < 0) return `${rusherName} run for a loss of ${Math.abs(yards)} yards`;
    return `${rusherName} run for no gain`;
  }
  
  
  

  function buildTags(decision, outcome) {
    const playType = outcome.playType || decision.type || "run";
    const tags = [];
  
    if (playType === "run") tags.push("RUN");
    if (playType === "pass") tags.push("PASS");
    if (playType === "field_goal") {
      if (outcome.fieldGoalGood) tags.push("FG", "SCORE");
      else tags.push("FGMISS");
    }
    if (playType === "punt") tags.push("PUNT");
  
    if (outcome.touchdown) tags.push("TD", "SCORE");
    if (outcome.safety) tags.push("SAFETY", "SCORE");
  
    if (outcome.turnover && !outcome.fieldGoalAttempt && !outcome.punt && !outcome.safety)
      tags.push("TURNOVER");
    if (outcome.interception) tags.push("INT");
    if (outcome.sack) tags.push("SACK");
  
    return tags;
  }
  

// Build a play log entry after outcome is applied
function buildPlayLog(state, decision, outcome, preState, offenseSide, defenseSide, offenseTeam, defenseTeam) {
  // Fallbacks so older call sites (if any) don’t explode
  if (!preState) {
    preState = {
      down: state.down,
      distance: state.distance,
      yardline: state.ballYardline,
      clockSec: state.clockSec,
      quarter: state.quarter,
    };
  }
  if (!offenseTeam || !defenseTeam || !offenseSide || !defenseSide) {
    const sides = getOffenseDefense(state);
    offenseSide  = sides.offenseSide;
    defenseSide  = sides.defenseSide;
    offenseTeam  = sides.offenseTeam;
    defenseTeam  = sides.defenseTeam;
  }

  const playType = outcome.playType || decision.type || "run";

  // 🔹 Increment here, exactly once per logged play
  const playId = state.playId++;

  const text = describePlay(
    decision,
    outcome,
    offenseTeam.teamName || offenseTeam.teamId
  );

  // ...unchanged below, except use playId variable...
  const snapQuarter   = preState.quarter;
  const snapClockSec  = preState.clockSec;
  const snapDown      = preState.down;
  const snapDistance  = preState.distance;
  const snapYardline  = preState.yardline;

  const downAndDistance = formatDownAndDistance(
    snapDown,
    snapDistance,
    snapYardline
  );

  const tags = buildTags(decision, outcome);

  const isScoring = !!(outcome.touchdown || outcome.safety || outcome.fieldGoalGood);
  const isTurnover = !!(
    outcome.turnover && !outcome.fieldGoalAttempt && !outcome.punt && !outcome.safety
  );

  const log = {
    playId,
    driveId: state.driveId,
    quarter:  snapQuarter,
    clockSec: snapClockSec,
    offense: offenseSide,
    defense: defenseSide,
    offenseTeamId: offenseTeam.teamId,
    defenseTeamId: defenseTeam.teamId,
    offenseTeamName: offenseTeam.teamName,
    defenseTeamName: defenseTeam.teamName,
    down:         snapDown,
    distance:     snapDistance,
    ballYardline: snapYardline,
    preDown:          snapDown,
    preDistance:      snapDistance,
    preBallYardline:  snapYardline,
    postDown:         state.down,
    postDistance:     state.distance,
    postBallYardline: state.ballYardline,
    decisionType: decision.type,
    playType,
    text,
    description: text,
    desc: text,
    downAndDistance,
    tags,
    isScoring,
    isTurnover,
    highImpact: isScoring || isTurnover,
    ...outcome,
  };

  return log;
}

  
  
  // -----------------------------------------------------------------------------
  // Quarter / game boundary handling
  // -----------------------------------------------------------------------------
  function isEndOfRegulation(state) {
    return (
      state.quarter >= state.cfg.numQuarters &&
      state.clockSec <= 0
    );
  }
  
  function handleEndOfQuarterOrGame(state) {
    if (state.clockSec > 0) return;
  
    const { cfg } = state;
  
    // End of regulation
    if (state.quarter >= cfg.numQuarters) {
      const diff = state.score.home - state.score.away;
      if (diff !== 0) {
        // We have a winner
        state.isFinal = true;
        state.winner = diff > 0 ? "home" : "away";
        state.events.push({
          type: "game_end",
          reason: "regulation",
          quarter: state.quarter,
          score: cloneScore(state.score),
        });
        return;
      }
  
      // Tie game
      if (!cfg.allowTies || state.quarter < cfg.numQuarters + cfg.maxOvertimeQuarters) {
        // Add overtime quarter
        state.quarter += 1;
        state.clockSec = cfg.quarterLengthSec / 2; // shorter OT
        // Possession: flip a coin
        const rng = state.rng;
        state.possession = rng.next() < 0.5 ? "home" : "away";
        state.ballYardline = 25;
        state.down = 1;
        state.distance = 10;
        state.events.push({
          type: "overtime_start",
          quarter: state.quarter,
          score: cloneScore(state.score),
          possession: state.possession,
        });
        return;
      } else {
        // Tie allowed and we've played max OT
        state.isFinal = true;
        state.winner = null;
        state.events.push({
          type: "game_end",
          reason: "tie",
          quarter: state.quarter,
          score: cloneScore(state.score),
        });
        return;
      }
    }
  
    // End of quarter but game continues
    state.quarter += 1;
    state.clockSec = state.cfg.quarterLengthSec;
    state.events.push({
      type: "quarter_end",
      quarterEnded: state.quarter - 1,
      score: cloneScore(state.score),
    });
  }
  

// -----------------------------------------------------------------------------
// Basic team stats aggregation for UI
// -----------------------------------------------------------------------------
function computeTeamStats(state) {
    const makeRow = () => ({
      plays: 0,
      yardsTotal: 0,
      rushYards: 0,
      passYards: 0,
      turnovers: 0,
      yardsPerPlay: 0,
    });
  
    const stats = {
      home: makeRow(),
      away: makeRow(),
    };
  
    for (const p of state.plays) {
      const side = p.offense === "away" ? "away" : "home";
      const s = stats[side];
  
      const y = Number.isFinite(p.yardsGained) ? p.yardsGained : 0;
      const type = p.playType || p.decisionType;
  
      if (type === "run" || type === "pass") {
        s.plays += 1;
        s.yardsTotal += y;
        if (type === "run") s.rushYards += y;
        if (type === "pass") s.passYards += y;
      }
  
      // Count only “true” turnovers, not punts or missed FGs
      if (p.turnover && !p.fieldGoalAttempt && !p.punt) {
        s.turnovers += 1;
      }
    }
  
    for (const side of ["home", "away"]) {
      const s = stats[side];
      s.yardsPerPlay = s.plays > 0 ? s.yardsTotal / s.plays : 0;
    }
  
    return stats;
  }
  
  
  


// -----------------------------------------------------------------------------
// Result object & summary
// -----------------------------------------------------------------------------
function buildGameResult(state) {
    const { homeTeam, awayTeam, score } = state;
    const diff = score.home - score.away;
    const winner =
      diff > 0 ? "home" : diff < 0 ? "away" : null;
  
    const teamStats = computeTeamStats(state);
  
    return {
      homeTeamId: homeTeam.teamId,
      homeTeamName: homeTeam.teamName,
      awayTeamId: awayTeam.teamId,
      awayTeamName: awayTeam.teamName,
      score: { ...score },
      winner,
      quarterCount: state.quarter,
      drives: state.drives,
      plays: state.plays,
      events: state.events,
      teamStats,
      playerStats: state.playerStats,
    };
  }
  
  
  
  function formatGameSummary(result) {
    const {
      homeTeamName,
      awayTeamName,
      score,
      winner,
      quarterCount,
    } = result;
  
    const scoreLine = `${awayTeamName} ${score.away} @ ${homeTeamName} ${score.home}`;
    const winnerLine =
      winner === "home"
        ? `${homeTeamName} win`
        : winner === "away"
        ? `${awayTeamName} win`
        : "Tie game";
  
    return `${scoreLine} (${quarterCount} quarters) — ${winnerLine}`;
  }
  
  // -----------------------------------------------------------------------------
  // Multi-game series helper
  // -----------------------------------------------------------------------------
  function simulateGameSeries(
    homeTeam,
    awayTeam,
    numGames,
    options = {}
  ) {
    const results = [];
    for (let i = 0; i < numGames; i++) {
      const seedOffset = options.seed != null ? options.seed + i : undefined;
      results.push(
        simulateGame(homeTeam, awayTeam, {
          ...options,
          seed: seedOffset,
        })
      );
    }
    return results;
  }
  
  // -----------------------------------------------------------------------------
  // Exports
  // -----------------------------------------------------------------------------
  export { simulateGame, simulateGameSeries, formatGameSummary };

  