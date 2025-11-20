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
      (state.quarter === 2 && state.clockSec <= 90) ||
      (state.quarter === 4 && state.clockSec <= 240 && diff <= 0)
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
      case "punt":              return t(6, 9);
      default:                  return t(3, 6);
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
  
    // Out-of-bounds: 0 inside 2:00; small restart runoff outside 2:00
    if (outcome.outOfBounds) {
      if (isTwoMinute(state)) return 0;
      return Math.round(rng.nextRange(cfg.oobRestartMin, cfg.oobRestartMax));
    }
  
    // Normal in-bounds runoff (huddle/sub/presnap), faster in hurry-up
    const hurry = isLateGameHurry(state, offenseSide);
    let base = Math.round(
      rng.nextRange(
        hurry ? cfg.betweenPlayHurryMin : cfg.betweenPlayNormalMin,
        hurry ? cfg.betweenPlayHurryMax : cfg.betweenPlayNormalMax
      )
    );
  
    // Extra seconds for moving the chains on a first down (uses preState)
    const gainedFirst =
      preState &&
      Number.isFinite(preState.distance) &&
      !outcome.turnover &&
      !outcome.punt &&
      !outcome.fieldGoalAttempt &&
      (outcome.yardsGained || 0) >= preState.distance;
  
    if (gainedFirst && !isTwoMinute(state)) {
      base += Math.round(rng.nextRange(2, 4));
    }
  
    // Apply one-time "quarter break setup" if flagged
    if (state._quarterBreakSetup) {
      base += (cfg.quarterBreakSetupExtra || 0);
      state._quarterBreakSetup = false;
    }
  
    return base;
  }
  
  
  
  
  // -----------------------------------------------------------------------------
  // Game config / types
  // -----------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    quarterLengthSec: 900,
    numQuarters: 4,
    maxOvertimeQuarters: 1,
    allowTies: true,
  
    // Micro layer (leave if used there)
    baseRunMean: 3.0,
    baseRunStd: 2.5,
    basePassMean: 5.0,
    basePassStd: 5.0,
    sackMeanLoss: -6,
    turnoverBaseProb: 0.025,
  
    // FG
    fgBaseProb: 0.72,
    fgAccuracyWeight: 0.003,
  
    // Punting realism
    puntBaseDistance: 45, // was 42 → slightly stronger modern punting
    puntStd: 7,
  
    // Kickoffs (modern rules)
    kickoffTouchbackRate: 0.85, // was 0.643 → closer to current TB rates
  
    // PAT strategy/quality knobs
    xpMakeProb: 0.94,
    twoPtMakeProb: 0.48,
  
    // Pace knobs (snap-to-snap minus in-play time)
    betweenPlayNormalMin: 18,
    betweenPlayNormalMax: 30,
    betweenPlayHurryMin: 8,
    betweenPlayHurryMax: 14,
    oobRestartMin: 4,
    oobRestartMax: 8,
  
    // Small setup runoff applied to the FIRST play after a quarter break
    quarterBreakSetupExtra: 6,
  
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
  
      // Kickers (may be null -> we handle gracefully)
      homeKicker,
      awayKicker,
      homeQB,
      awayQB,
  
      // Logs
      drives: [],
      plays: [],
      events: [],
      isFinal: false,
      winner: null,
    };
  }
  
  function cloneScore(score) {
    return { home: score.home, away: score.away };
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
  
    // Register initial drive meta
    startNewDrive(state, null, "home received opening kickoff");
  
    while (!state.isFinal) {
      simulateDrive(state);
  
      if (isEndOfRegulation(state) && !state.isFinal) {
        handleEndOfQuarterOrGame(state);
      }
    }
  
    return buildGameResult(state);
  }

  // Kickoff helper: use after TD/FG (or safety if you want)
  function applyKickoff(state, kickingSide) {
    const { cfg, rng } = state;
    const receiving = kickingSide === "home" ? "away" : "home";
  
    // Small time cost for the kickoff play
    const kickoffTime = rng.nextRange(5, 9);
    state.clockSec = Math.max(0, state.clockSec - kickoffTime);
  
    // Touchback? (new rule: kickoff touchback to the 35)
    const tbRate = cfg.kickoffTouchbackRate ?? 0.75;
    if (rng.next() < tbRate) {
      state.possession = receiving;
      state.ballYardline = 35; // kickoff touchback spot (per your rule)
      state.events.push({
        type: "kickoff",
        touchback: true,
        quarter: state.quarter,
        clockSec: state.clockSec,
      });
      return;
    }
  
    // Simple return model: caught ~goal line to the 5, return ~15–35 yards
    const catchDepth = Math.round(rng.nextRange(-2, 5)); // -2 means in end zone
    const returnYds = clamp(Math.round(normal(rng, 22, 8)), 5, 60);
    const spot = clamp(Math.max(0, catchDepth) + returnYds, 1, 99);
  
    state.possession = receiving;
    state.ballYardline = spot;
    state.events.push({
      type: "kickoff",
      touchback: false,
      returnYards: returnYds,
      quarter: state.quarter,
      clockSec: state.clockSec,
    });
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
  
    // Aggregate basic drive stats (rushing/passing only for yards)
    const totalYards = drivePlays.reduce((sum, p) => {
      const y = typeof p.yardsGained === "number" ? p.yardsGained : 0;
      if (p.playType === "run" || p.playType === "pass") return sum + y;
      return sum;
    }, 0);
  
    // NEW: duration = sum of per-play clockRunoff for ALL plays with this driveId
    const durationSec = state.plays.reduce(
      (sum, p) =>
        p.driveId === driveId
          ? sum + (Number.isFinite(p.clockRunoff) ? p.clockRunoff : 0)
          : sum,
      0
    );
  
    // Drive result label
    let resultText = "Drive ended";
    if (lastPlay) {
      if (isTD) resultText = "TD";
      else if (isFG && isFGGood) resultText = "FG Good";
      else if (isFG && !isFGGood) resultText = "FG Miss";
      else if (isSafety) resultText = "Safety";
      else if (lastPlay.punt) resultText = "Punt";
      else if (lastPlay.turnover) resultText = "Turnover";
    } else if (state.clockSec <= 0) {
      resultText = "End of quarter";
    }
  
    const playIndices = drivePlays.map((_, idx) => startingPlayIndex + idx);
  
    // Write the drive row now
    state.drives.push({
      driveId,
      offense: offenseSide,                 // "home" | "away"
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
        startNewDrive(state, lastPlay, "Quarter break – continuing series");
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
        // Missed FG -> defense takes over at spot (already approximated earlier)
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
 * IMPORTANT: PAT is an **untimed** down — we do NOT change state.clockSec.
 * This function assumes the TD points (6) have already been added.
 */
 function handlePAT(state, scoringSide) {
    const rng = state.rng;
    const cfg = state.cfg || {};
  
    const xpMakeProb    = Number.isFinite(cfg.xpMakeProb)    ? cfg.xpMakeProb    : 0.94;
    const twoPtMakeProb = Number.isFinite(cfg.twoPtMakeProb) ? cfg.twoPtMakeProb : 0.48;
  
    // Score diff from offense perspective *after* TD already applied
    const scoreDiff =
      scoringSide === "home"
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
  
    let made = false;
    let desc = "";
  
    if (attemptTwo) {
      made = rng.next() < twoPtMakeProb;
      if (made) {
        if (scoringSide === "home") state.score.home += 2;
        else                        state.score.away += 2;
        desc = "Two-point try is good";
        state.events.push({
          type: "score",
          subtype: "two_point",
          offense: scoringSide,
          points: 2,
          quarter: state.quarter,
          clockSec: state.clockSec,  // same as TD time (untimed down)
          score: cloneScore(state.score),
        });
      } else {
        desc = "Two-point try fails";
      }
    } else {
      made = rng.next() < xpMakeProb;
      if (made) {
        if (scoringSide === "home") state.score.home += 1;
        else                        state.score.away += 1;
        desc = "Extra point is good";
        state.events.push({
          type: "score",
          subtype: "extra_point",
          offense: scoringSide,
          points: 1,
          quarter: state.quarter,
          clockSec: state.clockSec,  // same as TD time (untimed down)
          score: cloneScore(state.score),
        });
      } else {
        desc = "Extra point is no good";
      }
    }
  
    const offenseTeam = scoringSide === "home" ? state.homeTeam : state.awayTeam;
    const defenseSide = scoringSide === "home" ? "away" : "home";
    const defenseTeam = scoringSide === "home" ? state.awayTeam : state.homeTeam;
  
    const log = {
      playId: state.playId++,
      driveId: state.driveId,           // PAT stays with the scoring drive
      quarter: state.quarter,
      clockSec: state.clockSec,         // unchanged (untimed)
      offense: scoringSide,
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
      text: `${offenseTeam.teamName} ${desc}`,
      description: `${offenseTeam.teamName} ${desc}`,
      desc: `${offenseTeam.teamName} ${desc}`,
      downAndDistance: "",
      tags: attemptTwo
        ? (made ? ["2PT", "SCORE"] : ["2PT"])
        : (made ? ["XP", "SCORE"] : ["XP"]),
      isScoring: made,
      isTurnover: false,
      highImpact: made,
      yardsGained: 0,
      timeElapsed: 0,          // <-- PAT is *untimed*
      turnover: false,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
    };
  
    state.plays.push(log);
    return log;
  }
  
  
  /**
   * Logs a kickoff play (time may be 0–6s) and sets the receiving team's
   * starting field position. Uses new rule: kickoff touchback to the 35.
   * Expects that state.possession already points to the RECEIVING team and
   * a new drive has been started.
   */
  function doKickoff(state, kickingSide) {
    const rng = state.rng;
    const cfg = state.cfg || {};
    const touchbackRate = Number.isFinite(cfg.kickoffTouchbackRate) ? cfg.kickoffTouchbackRate : 0.75;
  
    // Decide touchback vs return
    const isTouchback = rng.next() < touchbackRate;
    let desc = "";
    let startYardline = 35; // default for touchback
    let returnYds = 0;
  
    if (!isTouchback) {
      // Simple return model: average ~25-28 yard line; clamp inside [10, 45]
      // We simulate the *ending* yardline for the receiving team.
      const base = 28 + Math.round((rng.next() - 0.5) * 12); // ~[22..34]
      startYardline = clamp(base, 10, 45);
      returnYds = startYardline - 25; // relative to a neutral TB spot for text
    }
  
    // Small clock burn on live returns; zero on touchbacks is allowed but we’ll
    // burn up to 2s anyway to help realism.
    const timeElapsed = isTouchback ? Math.round(rng.nextRange(0, 2))
                                    : Math.max(2, Math.round(rng.nextRange(3, 6)));
    state.clockSec = Math.max(0, state.clockSec - timeElapsed);
  
    // Set the receiving team as offense on its new drive
    state.ballYardline = startYardline;
    state.down         = 1;
    state.distance     = 10;
  
    // Build kickoff log as a special play under the NEW driveId (already bumped)
    const receivingSide = state.possession; // after flip
    const kickingTeam   = kickingSide === "home" ? state.homeTeam : state.awayTeam;
    const receivingTeam = receivingSide === "home" ? state.homeTeam : state.awayTeam;
  
    desc = isTouchback
      ? `${kickingTeam.teamName} kickoff: touchback. ${receivingTeam.teamName} start at 35`
      : `${kickingTeam.teamName} kickoff returned ${Math.max(0, returnYds)} yards to the ${receivingSide === "home" ? "OWN" : "OWN"} ${startYardline}`;
  
    addSpecialPlayLog(state, {
      specialType: "kickoff",
      description: desc,
      timeElapsed,
      offenseSide: kickingSide, // kicking team shown as offense for the kickoff play
      yardsGained: 0,
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
    } = opts || {};
  
    const offenseTeam = offenseSide === "home" ? state.homeTeam : state.awayTeam;
    const defenseSide = offenseSide === "home" ? "away" : "home";
    const defenseTeam = offenseSide === "home" ? state.awayTeam : state.homeTeam;
  
    const log = {
      playId: state.playId++,
      driveId: state.driveId, // current drive (e.g., new drive for kickoff)
      quarter: state.quarter,
      clockSec: state.clockSec,
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
      clockRunoff: timeElapsed,    // <-- NEW: assign all special-play time to drive
      turnover: false,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
    };
  
    state.plays.push(log);
    return log;
  }
  
  
  
  // Play simulation
  function simulatePlay(state) {
    const { rng } = state;
    const {
      offenseTeam,
      defenseTeam,
      offenseSide,
      defenseSide,
    } = getOffenseDefense(state);

    const offenseUnits = getUnitProfiles(offenseTeam).offense;
    const defenseUnits = getUnitProfiles(defenseTeam).defense;
    const specialOff = getUnitProfiles(offenseTeam).special;

    // Snapshot of state *before* the play for logging
    const preState = {
      down: state.down,
      distance: state.distance,
      yardline: state.ballYardline,
      clockSec: state.clockSec,
      quarter: state.quarter,
    };

    const situation = {
      down: preState.down,
      distance: preState.distance,
      yardline: preState.yardline,
      quarter: preState.quarter,
      clockSec: preState.clockSec,
      scoreDiff:
        offenseSide === "home"
          ? state.score.home - state.score.away
          : state.score.away - state.score.home,
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
        playOutcome = simulateFieldGoal(
          state,
          offenseUnits,
          specialOff,
          rng
        );
        break;
      case "punt":
        playOutcome = simulatePunt(state, specialOff, rng);
        break;
      default:
        playOutcome = simulateRunPlay(state, offenseUnits, defenseUnits, rng);
    }

    // Apply outcome (updates score, clock, field position, possession, etc.)
    applyPlayOutcomeToState(state, playOutcome, preState);

    // Build a richer log using pre-play context & original offense/defense
    const playLog = buildPlayLog(
      state,
      decision,
      playOutcome,
      preState,
      offenseSide,
      defenseSide,
      offenseTeam,
      defenseTeam
    );
    state.plays.push(playLog);

    return playLog;
  }

  

  // Choose between run / pass / FG / punt with late-game 4th-down logic
  function choosePlayType(situation, offenseUnits, defenseUnits, specialOff, rng) {
    const { down, distance, yardline, quarter, clockSec, scoreDiff } = situation;
  
    const offPass = offenseUnits.pass?.overall ?? 60;
    const offRun  = offenseUnits.run?.overall  ?? 60;
    const defCover = defenseUnits.coverage?.overall ?? 60;
    const defRun   = defenseUnits.runFit?.overall   ?? 60;
  
    const passAdv = (offPass - defCover) / 15;
    let basePassProb = logistic(passAdv);
  
    const isObviousPass = (down === 3 && distance >= 6) || (down === 4 && distance >= 3);
    const isObviousRun  = distance <= 2 && down <= 3 && yardline <= 80;
    if (isObviousPass) basePassProb = Math.max(basePassProb, 0.7);
    if (isObviousRun)  basePassProb = Math.min(basePassProb, 0.3);
  
    // Throw more when trailing late
    if (quarter >= 4 && clockSec <= 120 && scoreDiff < 0) {
      basePassProb = Math.max(basePassProb, 0.8);
    }
  
    // ---------------- 4th down decisions ----------------
    if (down === 4) {
      const yardsToGoal = 100 - yardline;
      const inFGrange = yardsToGoal <= 37; // ~54-yarder
      const oneScoreGame = Math.abs(scoreDiff) <= 8;
      const under5 = (quarter >= 4 && clockSec <= 300);
  
      // MUST-GO: trailing (or tied) one-score in last 5:00
      if (under5 && oneScoreGame && scoreDiff <= 0) {
        return { type: distance >= 3 ? "pass" : "run" };
      }
  
      // Early/mid-game go-territory: plus territory & short
      const goTerritory = (yardline >= 60 && distance <= 3);
  
      // Prefer FG when reasonable and not a great go-for-it spot
      if (inFGrange && distance > 1 && !(goTerritory && scoreDiff < 0)) {
        return { type: "field_goal" };
      }
  
      // Punt when backed up and no strong reason to go
      const shouldPunt = yardline <= 60 && !goTerritory && !inFGrange;
      if (shouldPunt) return { type: "punt" };
  
      // Otherwise, go for it using tendency
      return rng.next() < basePassProb ? { type: "pass" } : { type: "run" };
    }
  
    // Non-4th downs: choose run/pass
    return rng.next() < basePassProb ? { type: "pass" } : { type: "run" };
  }
  
  
  
// ------------------------ Run play -----------------------------------------
function simulateRunPlay(state, offenseUnits, defenseUnits, rng) {
    const runUnit   = offenseUnits.run || {};
    const defRun    = defenseUnits.runFit || {};
    const runOff    = runUnit.overall ?? 60;
    const frontRunD = defRun.overall ?? 60;
  
    const yardline = state.ballYardline;
    const down     = state.down;
    const distance = state.distance;
  
    // Box heuristic
    let boxCount = 7;
    if (yardline < 10 || yardline > 90) boxCount = 8;
    if (distance >= 8)                  boxCount = 6;
    if (down === 1 && distance >= 10)   boxCount = 6;
  
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
    const yards   = Math.round(clamp(raw, -8, maxGain));
  
    // Slightly higher OOB chance late/when trailing or on longer gains
    const { offenseSide } = getOffenseDefense(state);
    const hurry    = isLateGameHurry(state, offenseSide);
    const oobProb  = (hurry ? 0.20 : 0.12) + (yards >= 10 ? 0.08 : 0);
    const outOfBounds = !micro.fumble && rng.next() < oobProb;
  
    const inPlayTime = estimateInPlayTime(
      { playType: "run", yardsGained: yards },
      rng
    );
  
    // TD/safety from this play alone (spot clamps prevent overrun)
    const prospective = state.ballYardline + yards;
    const touchdown   = prospective >= 100;
    const safety      = prospective <= 0;
  
    // Fumbles from micro-engine, but damped to reduce total turnovers
    const rawFumble = !!micro.fumble;
    const fumble    = rawFumble && (rng.next() < 0.6); // keep ~60% of fumble flags
  
    return {
      playType: "run",
      yardsGained: yards,
      inPlayTime,
      timeElapsed: inPlayTime,      // keep legacy field; total added later
      turnover: fumble,
      interception: false,
      sack: false,
      completion: false,
      incomplete: false,
      outOfBounds,
      touchdown,
      safety,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
      micro,
    };
  }
  
  
  // ------------------------ Pass play ------------------------------------------
  function simulatePassPlay(state, offenseUnits, defenseUnits, rng) {
    const passUnit = offenseUnits.pass || {};
    const cover    = defenseUnits.coverage || {};
    const rush     = defenseUnits.passRush || {};
    const passOff  = passUnit.overall ?? 60;
    const coverDef = cover.overall ?? 60;
    const rushDef  = rush.overall ?? 60;
  
    const yardline = state.ballYardline;
    const down     = state.down;
    const distance = state.distance;
  
    const params = {
      qbAccuracyRating: passOff,
      qbProcessingRating: passOff,
      qbUnderPressureRating: passOff - 5,
      olPassBlockRating: passOff,
      dlPassRushRating: rushDef,
      wrRouteRating: passOff,
      wrReleaseRating: passOff,
      wrSpeedRating: clamp(passOff + 5, 40, 99),
      wrHandsRating: clamp(passOff, 40, 99),
      wrContestedCatchRating: clamp(passOff - 2, 40, 99),
      dbManRating: coverDef,
      dbZoneRating: coverDef,
      dbPressRating: clamp(coverDef - 2, 40, 99),
      dbSpeedRating: clamp(coverDef + 2, 40, 99),
      dbBallSkillsRating: coverDef,
      yardline,
      down,
      distance,
      coverageType:
        (down === 3 && distance <= 6)
          ? "man"
          : (down === 2 && distance >= 8)
          ? "zone"
          : "mixed",
      situationalAggression: (down >= 3 && distance >= 7) ? 0.6 : 0.5,
      throwAggressiveness: clamp(
        0.45 +
          (distance >= 10 ? 0.1 : 0) +
          (state.quarter >= 4 ? 0.15 : 0),
        0.25,
        0.9
      ),
    };
  
    const micro   = samplePassOutcome(params, rng) || {};
    const raw     = Number.isFinite(micro.yardsGained) ? micro.yardsGained : 0;
    const maxGain = Math.max(0, 100 - state.ballYardline);
    const yards   = Math.round(clamp(raw, -15, maxGain));
  
    // Turnover flags from micro-engine
    const interceptionRaw = !!micro.interception;
    const fumbleRaw       = !!micro.fumble;
  
    // Dampen raw turnover flags from micro-engine
    const interception = interceptionRaw && (rng.next() < 0.6);
    const fumble       = fumbleRaw       && (rng.next() < 0.6);
  
    const sack       = !!micro.sack;
    const completion = !!micro.completion;
  
    // Incomplete when not completed, no INT, no sack, no fumble.
    const incomplete = !completion && !interception && !sack && !fumble;
  
    // Out of bounds only on completed passes
    const { offenseSide } = getOffenseDefense(state);
    const hurry       = isLateGameHurry(state, offenseSide);
    const outOfBounds =
      completion &&
      !interception &&
      !sack &&
      rng.next() < (hurry ? 0.35 : 0.25);
  
    const inPlayTime = estimateInPlayTime(
      { playType: "pass", sack, incomplete },
      rng
    );
  
    const prospective = state.ballYardline + yards;
    const touchdown   = prospective >= 100;
    const safety      = prospective <= 0;
  
    const turnover = interception || fumble;
  
    return {
      playType: "pass",
      yardsGained: yards,
      inPlayTime,
      timeElapsed: inPlayTime,      // keep legacy field; total added later
      turnover,
      interception,
      sack,
      completion,
      incomplete,
      outOfBounds,
      touchdown,
      safety,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
      micro,
    };
  }
  

  
  
  // ------------------------ Field goal ----------------------------------------
  function simulateFieldGoal(state, offenseUnits, specialOff, rng) {
    const { cfg } = state;
    const { offenseSide } = getOffenseDefense(state);
  
    const yardsToGoal   = 100 - state.ballYardline;
    const kickDistance  = yardsToGoal + 17; // LOS + 17 (standard NFL)
  
    const kAcc = specialOff.kicking?.accuracy ?? 60;
    const kPow = specialOff.kicking?.power   ?? 60;
  
    // Baseline make rate as a function of distance, before kicker adjustment.
    // Designed to approximate:
    //  - ~90% in low 30s
    //  - high 70s–low 80s in the 40s
    //  - mid 60s in low 50s
    let base;
    if (kickDistance <= 35) {
      // 20–35: from ~0.97 down to ~0.90
      base = 0.97 - 0.004 * Math.max(0, kickDistance - 20);
    } else if (kickDistance <= 45) {
      // 36–45: from ~0.90 down to ~0.75
      base = 0.90 - 0.015 * (kickDistance - 35);
    } else if (kickDistance <= 55) {
      // 46–55: from ~0.75 down to ~0.55
      base = 0.75 - 0.02 * (kickDistance - 45);
    } else {
      // 56+: fall off a cliff
      base = 0.55 - 0.03 * (kickDistance - 55);
    }
  
    // Kicker quality adjustments — small but meaningful
    const accAdj = 0.002 * (kAcc - 70);  // ±0.06 across 40–100 rating
    const powAdj = 0.0015 * (kPow - 70); // ±0.045 across 40–100 rating
  
    let prob = base + accAdj + powAdj;
    prob = clamp(prob, 0.05, 0.99);
  
    const made = rng.next() < prob;
  
    // Live clock on FGs is small — ~5–8 seconds from snap to whistle + minimal admin
    const timeElapsed = rng.nextRange(5, 9);
  
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
      kickDistance,
      offenseSide,
    };
  }
  
  
  
  // ------------------------ Punt ----------------------------------------------
  function simulatePunt(state, specialOff, rng) {
    const { cfg } = state;
    const { offenseSide } = getOffenseDefense(state);
  
    const pControl = specialOff.punting?.control ?? 60;
    const pFieldFlip = specialOff.punting?.fieldFlip ?? 60;
  
    const base = cfg.puntBaseDistance;
    const adv = (pControl + pFieldFlip - 120) / 5; // around average => 0
    const mean = base + adv;
    const std = cfg.puntStd;
  
    let distance = normal(rng, mean, std);
    distance = clamp(distance, 25, 70);
  
    const timeElapsed = rng.nextRange(5, 10);
  
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
    };
  }

  
  
  // -----------------------------------------------------------------------------
  // Apply outcome to game state
  // -----------------------------------------------------------------------------
  function applyPlayOutcomeToState(state, outcome, preState) {
    const { offenseSide, defenseSide, offenseTeam } = getOffenseDefense(state);
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
  
    // Prefer simulator-provided in-play time; else estimate
    let inPlayTime = Number.isFinite(outcome.inPlayTime)
      ? outcome.inPlayTime
      : estimateInPlayTime(
          { playType, sack: isSack, incomplete: isIncompletion },
          rng
        );
  
    // Snap→whistle sanity clamp
    inPlayTime = clamp(inPlayTime, 3, 8.5);
  
    // Clock stops until next snap after: incompletion, explicit out of bounds,
    // any score, any change of possession (punt/turnover/safety/missed FG)
    const clockStopsAfterPlay =
      isIncompletion ||
      !!outcome.outOfBounds ||
      isScorePlay ||
      isChangeOfPossessionPlay;
  
    // Between-play runoff (0 when clock is stopped to the next snap)
    const between = clockStopsAfterPlay
      ? 0
      : estimateBetweenPlayTime(state, outcome, preState, rng, offenseSide);
  
    // Apply total runoff, enforce 2:00 warnings
    let newClock = Math.max(0, prevClock - (inPlayTime + between));
    if (
      (state.quarter === 2 || state.quarter === 4) &&
      prevClock > 120 &&
      newClock < 120
    ) {
      newClock = 120;
    }
  
    const clockRunoff = prevClock - newClock;
    outcome.clockRunoff = clockRunoff; // used by drives/TOP
    state.clockSec = newClock;
  
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
  
      // Drive ends; next drive kickoff handled in simulateDrive
      state.down = 1;
      state.distance = 10;
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
  
      state.down = 1;
      state.distance = 10;
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // Normal offensive play (run/pass)
    let newYard = state.ballYardline + (outcome.yardsGained || 0);
  
// Safety candidate (ball carrier driven back toward own end zone)
if (newYard <= 0) {
    const fieldPos = state.ballYardline; // where the play started
    const yardsLoss = outcome.yardsGained < 0 ? -outcome.yardsGained : 0;
  
    // Only a subset of these become true safeties. Most end up as being tackled
    // very close to the goal line.
    let safetyProb = 0;
  
    if (fieldPos <= 2 && yardsLoss >= 2) {
      safetyProb = 0.7;     // very backed up and big loss
    } else if (fieldPos <= 5 && yardsLoss >= 3) {
      safetyProb = 0.4;
    } else if (fieldPos <= 8 && yardsLoss >= 5) {
      safetyProb = 0.2;
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
      state.possession = defenseSide;
      state.ballYardline = 25;
      state.down = 1;
      state.distance = 10;
      outcome.safety = true;
      outcome.endOfDrive = true;
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
  
      outcome.touchdown = true;
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // Turnover (non-FG / non-punt)
    if (isTurnover) {
      state.possession = offenseSide === "home" ? "away" : "home";
      // New offense gets ball where play ended, flipped to their perspective
      state.ballYardline = 100 - clamp(newYard, 1, 99);
      state.down = 1;
      state.distance = 10;
      outcome.endOfDrive = true;
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
    state.ballYardline = clamp(newYard, 1, 99);
  
    const yardsToFirst = state.distance - (outcome.yardsGained || 0);
    if (yardsToFirst <= 0) {
      // First down
      state.down = 1;
      state.distance = 10;
    } else {
      if (state.down === 4) {
        // Turnover on downs
        state.possession = offenseSide === "home" ? "away" : "home";
        state.ballYardline = 100 - clamp(state.ballYardline, 1, 99);
        state.down = 1;
        state.distance = 10;
        outcome.endOfDrive = true;
  
        state.events.push({
          type: "turnover_on_downs",
          offense: offenseSide,
          defense: defenseSide,
          quarter: state.quarter,
          clockSec: state.clockSec,
          score: cloneScore(state.score),
        });
      } else {
        state.down += 1;
        state.distance = yardsToFirst;
      }
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
  
    if (playType === "kickoff") {
      return outcome.touchback ? `${team} kickoff for a touchback` : `${team} kickoff returned`;
    }
    if (playType === "extra_point") {
      return `${team} extra point ${outcome.isScoring ? "is good" : "is no good"}`;
    }
    if (playType === "two_point") {
      return `${team} two-point try ${outcome.isScoring ? "is good" : "fails"}`;
    }
    if (playType === "field_goal") {
      const dist = Math.round(outcome.kickDistance || 0);
      return outcome.fieldGoalGood
        ? (dist ? `${team} field goal from ${dist} yards is good` : `${team} field goal is good`)
        : (dist ? `${team} misses field goal from ${dist} yards` : `${team} misses field goal`);
    }
    if (playType === "punt") {
      const dist = Math.round(outcome.puntDistance || 0);
      return dist ? `${team} punts ${dist} yards` : `${team} punts`;
    }
    if (playType === "pass") {
      if (outcome.sack) return `${team} sacked for a loss of ${Math.abs(yards)} yards`;
      if (outcome.interception) return `${team} pass intercepted`;
      if (yards > 0) return `${team} pass complete for ${yards} yards${suffixTD}`;
      if (yards < 0) return `${team} pass complete for -${Math.abs(yards)} yards`;
      return `Incomplete pass`;
    }
    // run
    if (yards > 0) return `${team} run for ${yards} yards${suffixTD}`;
    if (yards < 0) return `${team} run for a loss of ${Math.abs(yards)} yards`;
    return `${team} run for no gain`;
  }
  

  function buildTags(decision, outcome) {
    const playType = outcome.playType || decision.type || "run";
    const tags = [];

    if (playType === "run") tags.push("RUN");
    if (playType === "pass") tags.push("PASS");
    if (playType === "field_goal") tags.push("FG");
    if (playType === "punt") tags.push("PUNT");

    if (outcome.touchdown) tags.push("TD", "SCORE");
    if (outcome.safety) tags.push("SAFETY", "SCORE");
    if (outcome.fieldGoalGood) tags.push("SCORE");

    if (outcome.turnover) tags.push("TURNOVER");
    if (outcome.interception) tags.push("INT");
    if (outcome.sack) tags.push("SACK");

    return tags;
  }

  // Build a play log entry after outcome is applied
  function buildPlayLog(state, decision, outcome) {
    const {
      offenseSide,
      defenseSide,
      offenseTeam,
      defenseTeam,
    } = getOffenseDefense(state);

    const playType = outcome.playType || decision.type || "run";

    const text = describePlay(
      decision,
      outcome,
      offenseTeam.teamName || offenseTeam.teamId
    );

    const downAndDistance = formatDownAndDistance(
      state.down,
      state.distance,
      state.ballYardline
    );

    const tags = buildTags(decision, outcome);

    const isScoring = !!(
      outcome.touchdown ||
      outcome.safety ||
      outcome.fieldGoalGood
    );

    const isTurnover = !!(
      outcome.turnover &&
      !outcome.fieldGoalAttempt &&
      !outcome.punt &&
      !outcome.safety
    );

    const log = {
      playId: state.playId,
      driveId: state.driveId,
      quarter: state.quarter,
      clockSec: state.clockSec,
      offense: offenseSide,
      defense: defenseSide,
      offenseTeamId: offenseTeam.teamId,
      defenseTeamId: defenseTeam.teamId,
      offenseTeamName: offenseTeam.teamName,
      defenseTeamName: defenseTeam.teamName,
      down: state.down,
      distance: state.distance,
      ballYardline: state.ballYardline,
      decisionType: decision.type,
      playType,

      // Description fields the UI is looking for:
      text,
      description: text,
      desc: text,
      downAndDistance,
      tags,
      isScoring,
      isTurnover,
      highImpact: isScoring || isTurnover,

      // Raw outcome data
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
      teamStats,              // <— new, used by simulation.html
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
  