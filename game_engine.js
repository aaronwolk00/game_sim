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
  
  // -----------------------------------------------------------------------------
  // Game config / types
  // -----------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    quarterLengthSec: 900, // 15 minutes
    numQuarters: 4,
    maxOvertimeQuarters: 1,
    allowTies: true,
    // baseline scoring / big play tuning (slightly toned down)
    baseRunMean: 3.0,      // was 3.5
    baseRunStd: 2.5,       // was 3.0
    basePassMean: 5.0,     // was 5.8
    basePassStd: 5.0,      // was 6.0
    sackMeanLoss: -6,
    turnoverBaseProb: 0.025,  // was 0.015 (more turnovers)
    // FG
    fgBaseProb: 0.72,         // was 0.75
    fgAccuracyWeight: 0.003,
    // Punting
    puntBaseDistance: 42,
    puntStd: 7,
    // Kickoffs
    kickoffTouchbackRate: 0.643,
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
  function simulateDrive(state) {
    const startingScore = cloneScore(state.score);
    const startingQuarter = state.quarter;
    const startingClock = state.clockSec;
    const { offenseSide } = getOffenseDefense(state);
    const offenseTeam =
      offenseSide === "home" ? state.homeTeam : state.awayTeam;
  
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
  
    // Aggregate basic drive stats
    const totalYards = drivePlays.reduce((sum, p) => {
      const y = typeof p.yardsGained === "number" ? p.yardsGained : 0;
      if (p.playType === "run" || p.playType === "pass") {
        return sum + y;
      }
      return sum;
    }, 0);
  
    const durationSec = Math.max(0, startingClock - state.clockSec);
  
    const lastPlay = drivePlays[drivePlays.length - 1] || null;
    let resultText = "Drive ended";
  
    if (lastPlay) {
      if (lastPlay.touchdown) {
        resultText = "TD";
      } else if (lastPlay.playType === "field_goal" && lastPlay.fieldGoalGood) {
        resultText = "FG Good";
      } else if (lastPlay.playType === "field_goal" && !lastPlay.fieldGoalGood) {
        resultText = "FG Miss";
      } else if (lastPlay.safety) {
        resultText = "Safety";
      } else if (lastPlay.punt) {
        resultText = "Punt";
      } else if (lastPlay.turnover) {
        resultText = "Turnover";
      }
    } else if (state.clockSec <= 0) {
      resultText = "End of quarter";
    }
  
    const playIndices = drivePlays.map((_, idx) => startingPlayIndex + idx);
  
    state.drives.push({
      driveId: state.driveId,
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
      const isTD = !!lastPlay?.touchdown;
      const isFG = lastPlay?.playType === "field_goal";
      const isFGGood = !!lastPlay?.fieldGoalGood;
      const isFGMiss = isFG && !isFGGood;
      const isSafety = !!lastPlay?.safety;
  
      // Detect pure quarter break (no scoring / no explicit end-of-drive type)
      const quarterBreakOnly =
        state.quarter !== startingQuarter &&
        state.clockSec === state.cfg.quarterLengthSec &&
        !isTD &&
        !isFG &&
        !isSafety;
  
      if (quarterBreakOnly) {
        // Same offense, same ball spot, *same down & distance*.
        // We only bump driveId and log a new drive start.
        state.driveId += 1;
        startNewDrive(
          state,
          lastPlay,
          "Quarter break – continuing series"
        );
        return;
      }
  
      if (isTD || (isFG && isFGGood)) {
        // Offense just scored – other team receives at own 25.
        applyKickoff(state, offenseSide);
        state.down = 1;
        state.distance = 10;
      } else if (isSafety) {
        // Safety: scoring defense already has possession from applyPlayOutcome.
        // Approximate free kick by starting them at own 25.
        state.ballYardline = 25;
        state.down = 1;
        state.distance = 10;
      } else if (isFGMiss) {
        // Missed FG: treat as turnover at spot, approximate by flipping field
        const los = clamp(state.ballYardline, 1, 99);
        state.possession = offenseSide === "home" ? "away" : "home";
        state.ballYardline = 100 - los;
        state.down = 1;
        state.distance = 10;
      } else {
        // Punts / interceptions / fumbles / turnover on downs:
        // applyPlayOutcome already set possession + field position.
        state.down = 1;
        state.distance = 10;
      }
  
      state.driveId += 1;
      startNewDrive(
        state,
        lastPlay,
        "New drive after change of possession or score"
      );
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
    applyPlayOutcomeToState(state, playOutcome);

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

  
  // Choose between run / pass / FG / punt based on situation and unit strengths
  function choosePlayType(
    situation,
    offenseUnits,
    defenseUnits,
    specialOff,
    rng
  ) {
    const { down, distance, yardline, quarter, clockSec, scoreDiff } =
      situation;
  
    const offPass = offenseUnits.pass?.overall ?? 60;
    const offRun = offenseUnits.run?.overall ?? 60;
    const defCover = defenseUnits.coverage?.overall ?? 60;
    const defRun = defenseUnits.runFit?.overall ?? 60;
  
    // Base pass tendency from rating difference
    const passAdv = (offPass - defCover) / 15; // typical diff of 15 => ~1 unit
    let basePassProb = logistic(passAdv); // between ~0.1 and 0.9
  
    // Situation adjustments
    const isObviousPass =
      (down === 3 && distance >= 6) ||
      (down === 4 && distance >= 3);
    const isObviousRun =
      distance <= 2 && down <= 3 && yardline <= 80;
  
    if (isObviousPass) basePassProb = Math.max(basePassProb, 0.7);
    if (isObviousRun) basePassProb = Math.min(basePassProb, 0.3);
  
    // End-of-half/game aggression: if trailing late, pass more
    const twoMin = 2 * 60;
    if (quarter >= 4 && clockSec < twoMin && scoreDiff < 0) {
      basePassProb = Math.max(basePassProb, 0.8);
    }
  
    // 4th down decision: FG or punt?
    if (down === 4) {
      const yardsToGoal = 100 - yardline;
      const fgRangeYards = 100 - yardline + 17; // ball on field + 17
      const kAcc = specialOff.kicking?.accuracy ?? 60;
  
      const inFGrange = yardsToGoal <= 37; // inside ~37 (54 yarder)
      const shouldGo =
        distance <= 2 &&
        yardline >= 55 &&
        scoreDiff < 0 &&
        quarter >= 4;
  
      if (inFGrange && !shouldGo) {
        return { type: "field_goal" };
      }
  
      const shouldPunt =
        !shouldGo &&
        yardline <= 60 &&
        !inFGrange; // too far for FG, not going for it
      if (shouldPunt) {
        return { type: "punt" };
      }
  
      // Otherwise, go for it (run vs pass).
    }
  
    const r = rng.next();
    return r < basePassProb ? { type: "pass" } : { type: "run" };
  }
  
  // ------------------------ Run play -----------------------------------------
  function simulateRunPlay(state, offenseUnits, defenseUnits, rng) {
    // Aggregate run ratings from team unit profiles
    const runUnit = offenseUnits.run || {};
    const defRunUnit = defenseUnits.runFit || {};
  
    const runOff = runUnit.overall ?? 60;
    const frontRunDef = defRunUnit.overall ?? 60;
  
    const yardline = state.ballYardline;   // 0–100 from offense goal line
    const down = state.down;
    const distance = state.distance;
  
    // Very simple box logic: heavier near goal line / backed up, lighter on long yardage
    let boxCount = 7; // neutral “7 in the box”
    if (yardline < 10 || yardline > 90) boxCount = 8;      // backed up or tight red zone
    if (distance >= 8) boxCount = 6;                       // light box on clear pass downs
    if (down === 1 && distance >= 10) boxCount = 6;        // 1st & long -> lighter box
  
    // Box lightness: +1 light, -1 heavy
    let boxLightness = 0;
    if (boxCount <= 6) boxLightness = 0.7;
    else if (boxCount >= 8) boxLightness = -0.7;
  
    // Map aggregate ratings to micro RB/OL inputs
    const olRunBlockRating    = runOff;
    const rbVisionRating      = runOff;
    const rbPowerRating       = runOff;
    const rbElusivenessRating = runOff;
  
    const params = {
      olRunBlockRating,
      rbVisionRating,
      rbPowerRating,
      rbElusivenessRating,
      frontRunDefRating: frontRunDef,
      boxCount,
      boxLightness,
      yardline,
      down,
      distance,
    };
  
    const micro = sampleRunOutcome(params, rng) || {};
  
    // Map micro result back into macro outcome shape the rest of the engine expects
    const yardsRaw = Number.isFinite(micro.yardsGained) ? micro.yardsGained : 0;
    const yards = Math.round(yardsRaw);
  
    // Keep run-play times in a reasonable range (3–35s)
    const timeRaw = Number.isFinite(micro.timeElapsed) ? micro.timeElapsed : 5;
    const timeElapsed = clamp(timeRaw, 3.5, 10.0);

    // Pre-compute whether this *play* reaches the end zone / own end zone
    const prospectiveYard = state.ballYardline + yards;
    const touchdown = prospectiveYard >= 100;
    const safety = prospectiveYard <= 0;
  
    return {
      playType: "run",
      yardsGained: yards,
      timeElapsed,
      turnover: !!micro.fumble,
      touchdown,
      safety,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
  
      // extra debug info from micro-engine (optional)
      micro,
    };
  }
  
  
  
  // ------------------------ Pass play ----------------------------------------
  function simulatePassPlay(state, offenseUnits, defenseUnits, rng) {
    const passUnit   = offenseUnits.pass || {};
    const runUnit    = offenseUnits.run  || {};
    const coverUnit  = defenseUnits.coverage || {};
    const rushUnit   = defenseUnits.passRush || {};
  
    const passOff  = passUnit.overall  ?? 60;
    const runOff   = runUnit.overall   ?? 60;
    const coverDef = coverUnit.overall ?? 60;
    const rushDef  = rushUnit.overall  ?? 60;
  
    const yardline = state.ballYardline;
    const down = state.down;
    const distance = state.distance;
  
    // Map aggregate ratings to micro inputs (simple heuristics)
    const qbAccuracyRating      = passOff;
    const qbProcessingRating    = passOff;
    const qbUnderPressureRating = passOff - 5;
  
    const wrRouteRating          = passOff;
    const wrReleaseRating        = passOff;
    const wrSpeedRating          = clamp(passOff + 5, 40, 99);
    const wrHandsRating          = clamp(passOff, 40, 99);
    const wrContestedCatchRating = clamp(passOff - 2, 40, 99);
  
    const dbManRating        = coverDef;
    const dbZoneRating       = coverDef;
    const dbPressRating      = clamp(coverDef - 2, 40, 99);
    const dbSpeedRating      = clamp(coverDef + 2, 40, 99);
    const dbBallSkillsRating = coverDef;
  
    // Basic situational coverage / aggression heuristics
    let coverageType = "mixed";
    if (down === 3 && distance <= 6) coverageType = "man";
    if (down === 2 && distance >= 8) coverageType = "zone";
  
    // Offense scoreDiff from its point of view
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
      qbAccuracyRating,
      qbProcessingRating,
      qbUnderPressureRating,
      olPassBlockRating: passOff,
      dlPassRushRating: rushDef,
      wrRouteRating,
      wrReleaseRating,
      wrSpeedRating,
      wrHandsRating,
      wrContestedCatchRating,
      dbManRating,
      dbZoneRating,
      dbPressRating,
      dbSpeedRating,
      dbBallSkillsRating,
      yardline,
      down,
      distance,
      coverageType,
      situationalAggression,
      throwAggressiveness,
    };
  
    const micro = samplePassOutcome(params, rng) || {};
  
    const yardsRaw = Number.isFinite(micro.yardsGained) ? micro.yardsGained : 0;
    const yards = Math.round(yardsRaw);
  
    // Keep pass-play times in a reasonable range (3–20s)
    const timeRaw = Number.isFinite(micro.timeElapsed) ? micro.timeElapsed : 6;
    const timeElapsed = clamp(timeRaw, 2.5, 12.5);

    // Pre-compute if this play itself is a TD / safety
    const prospectiveYard = state.ballYardline + yards;
    const touchdown = prospectiveYard >= 100;
    const safety = prospectiveYard <= 0;
  
    // Sack != automatic turnover; interception or fumble do
    const interception = !!micro.interception;
    const fumble = !!micro.fumble;
    const turnover = interception || fumble;
  
    return {
      playType: "pass",
      yardsGained: yards,
      timeElapsed,
      turnover,
      interception,
      sack: !!micro.sack,
      completion: !!micro.completion,
      touchdown,
      safety,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
  
      // extra micro-engine details (optional)
      micro,
    };
  }
  
  
  
  // ------------------------ Field goal ----------------------------------------
  function simulateFieldGoal(state, offenseUnits, specialOff, rng) {
    const { cfg } = state;
    const { offenseSide } = getOffenseDefense(state);
  
    const yardsToGoal = 100 - state.ballYardline;
    const kickDistance = yardsToGoal + 17; // LOS + 17
  
    const kAcc = specialOff.kicking?.accuracy ?? 60;
    const kPow = specialOff.kicking?.power ?? 60;
  
    // Distance penalty ramps up aggressively beyond ~35, plus extra after ~48
    const distancePenalty = Math.max(0, kickDistance - 35) * 0.018;
    const longBonusPenalty = Math.max(0, kickDistance - 48) * 0.012;
  
    let prob =
      cfg.fgBaseProb +
      cfg.fgAccuracyWeight * (kAcc - 70) +
      0.002 * (kPow - 70) -
      distancePenalty -
      longBonusPenalty;
  
    prob = clamp(prob, 0.05, 0.96);
  
    const made = rng.next() < prob;
    const timeElapsed = rng.nextRange(5, 9);
  
    return {
      playType: "field_goal",
      yardsGained: 0,
      timeElapsed,
      turnover: !made,
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
  function applyPlayOutcomeToState(state, outcome) {
    const { offenseSide, defenseSide, offenseTeam } = getOffenseDefense(state);
    const { cfg } = state;
    const rng = state.rng;
  
    const playType = outcome.playType;
    const isRun = playType === "run";
    const isPass = playType === "pass";
    const isFG = !!outcome.fieldGoalAttempt;
    const isPunt = !!outcome.punt;
    const isCompletion = !!outcome.completion;
    const isSack = !!outcome.sack;
    const isInterception = !!outcome.interception;
    const isTurnover = !!outcome.turnover;
  
    const isIncompletion =
      isPass && !isCompletion && !isInterception && !isSack;
  
    const preClock = state.clockSec;
  
    // Use micro snap→whistle time, then layer on between-play runoff.
    let playTime = Number.isFinite(outcome.timeElapsed)
      ? outcome.timeElapsed
      : 5;
    // Snap→whistle: realistically ~3–9 seconds
    playTime = clamp(playTime, 3, 9);
  
    const yardsGained = Number.isFinite(outcome.yardsGained)
      ? outcome.yardsGained
      : 0;
    const projectedNewYard = state.ballYardline + yardsGained;
  
    const predictedSafety = !isFG && !isPunt && projectedNewYard <= 0;
    const predictedTD = !isFG && !isPunt && projectedNewYard >= 100;
  
    // Any scoring result
    const isScorePlay =
      predictedTD ||
      predictedSafety ||
      (isFG && !!outcome.fieldGoalGood);
  
    // Any change of possession (including all FGs)
    const isPossessionChange =
      isPunt ||
      isTurnover ||
      predictedSafety ||
      predictedTD ||
      isFG; // made or missed
  
    const TWO_MIN = 120; // 2:00
    const LATE_GAME_OOB = 300; // 5:00 in 4Q
  
    // Approximate out-of-bounds probability for non-score / non-TO plays.
    let wentOutOfBounds = false;
    if (
      !isIncompletion &&
      !isFG &&
      !isPunt &&
      !isTurnover &&
      !isScorePlay
    ) {
      if (isRun) {
        wentOutOfBounds = rng.next() < 0.12; // ~12% of runs
      } else if (isPass && isCompletion) {
        wentOutOfBounds = rng.next() < 0.18; // ~18% of completions
      }
    }
  
    let clockRunoff = playTime;
  
    if (!state.isFinal && preClock > 0) {
      const inOobStopWindow =
        (state.quarter === 2 && preClock <= TWO_MIN) ||
        (state.quarter === 4 && preClock <= LATE_GAME_OOB);
  
      if (isIncompletion) {
        // Clock stops on incompletion: only the play itself burns.
        clockRunoff = clamp(playTime, 3, 8);
      } else if (wentOutOfBounds && inOobStopWindow) {
        // Late-game OOB: treat like incompletion (clock stops).
        clockRunoff = clamp(playTime, 3, 8);
        outcome.outOfBounds = true;
      } else if (isScorePlay || isPossessionChange) {
        // Scores and changes of possession:
        // clock cannot be running between possessions / after scores.
        clockRunoff = clamp(playTime, 3, 10);
      } else if (isRun || (isPass && (isCompletion || isSack))) {
        // Normal in-bounds offensive plays: add huddle / presnap.
        const between = rng.nextRange(18, 30);
        clockRunoff = playTime + between;
        // Net: ~22–38s, averaging ~28–32s.
        clockRunoff = clamp(clockRunoff, 22, 40);
      } else {
        // Weird / fallback (e.g. future spikes, etc.)
        const between = rng.nextRange(10, 22);
        clockRunoff = playTime + between;
        clockRunoff = clamp(clockRunoff, 15, 35);
      }
  
      // 2-minute warning in Q2 and Q4:
      // If we cross from >2:00 to <2:00, stop exactly at 2:00.
      if (state.quarter === 2 || state.quarter === 4) {
        const after = Math.max(0, preClock - clockRunoff);
        if (preClock > TWO_MIN && after < TWO_MIN) {
          state.events.push({
            type: "two_minute_warning",
            quarter: state.quarter,
            clockSec: TWO_MIN,
            score: cloneScore(state.score),
          });
          clockRunoff = preClock - TWO_MIN;
        }
      }
    }
  
    state.clockSec = Math.max(0, preClock - clockRunoff);
  
    // ---------------------------------------------------------------------------
    // Field goal
    // ---------------------------------------------------------------------------
    if (isFG) {
      if (outcome.fieldGoalGood) {
        if (offenseSide === "home") {
          state.score.home += 3;
        } else {
          state.score.away += 3;
        }
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
  
      // Possession & ball spot handled at drive boundary.
      state.down = 1;
      state.distance = 10;
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // ---------------------------------------------------------------------------
    // Punt – use landing spot to set field position
    // ---------------------------------------------------------------------------
    if (isPunt && outcome.punt) {
      const los = state.ballYardline; // line of scrimmage for punt
      const distance = Math.max(0, outcome.puntDistance || 0);
      const landing = los + distance;
  
      // Receiving team gets the ball
      state.possession = offenseSide === "home" ? "away" : "home";
  
      if (landing >= 100) {
        // Punt touchback: receiving team at own 20
        state.ballYardline = 20;
      } else {
        // Flip field relative to receiving team
        state.ballYardline = Math.max(1, 100 - Math.round(landing));
      }
  
      state.down = 1;
      state.distance = 10;
      state.playId += 1;
      outcome.endOfDrive = true;
      return;
    }
  
    // ---------------------------------------------------------------------------
    // Normal offensive play (run / pass)
    // ---------------------------------------------------------------------------
    let newYard = projectedNewYard;
  
    // Safety (tackled in own end zone)
    if (newYard <= 0) {
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
  
      // Defense becomes offense next drive (simulate free kick): they get ball.
      state.possession = defenseSide;
      state.ballYardline = 25;
      state.down = 1;
      state.distance = 10;
      outcome.safety = true;
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // Touchdown (with XP model)
    if (newYard >= 100) {
      // 6 for the TD
      if (offenseSide === "home") {
        state.score.home += 6;
      } else {
        state.score.away += 6;
      }
      state.events.push({
        type: "score",
        subtype: "touchdown",
        offense: offenseSide,
        points: 6,
        quarter: state.quarter,
        clockSec: state.clockSec,
        score: cloneScore(state.score),
      });
  
      // Simple XP model – no 2-pt tries yet
      try {
        const special = getUnitProfiles(offenseTeam).special || {};
        const kAcc = special.kicking?.accuracy ?? 60;
  
        const baseXpProb = 0.94;
        const adj = 0.0025 * (kAcc - 70);
        const xpProb = clamp(baseXpProb + adj, 0.88, 0.99);
  
        const xpMade = rng.next() < xpProb;
        if (xpMade) {
          if (offenseSide === "home") {
            state.score.home += 1;
          } else {
            state.score.away += 1;
          }
        }
  
        state.events.push({
          type: "extra_point",
          offense: offenseSide,
          good: xpMade,
          points: xpMade ? 1 : 0,
          quarter: state.quarter,
          clockSec: state.clockSec,
          score: cloneScore(state.score),
        });
      } catch (_) {
        // If anything goes wrong with unitProfiles, just skip XP quietly.
      }
  
      outcome.touchdown = true;
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // ---------------------------------------------------------------------------
    // Turnover (non-FG / non-punt)
    // ---------------------------------------------------------------------------
    if (isTurnover) {
      state.possession = offenseSide === "home" ? "away" : "home";
      // Spot the ball where the play ended, flipped for new offense.
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
  
    // ---------------------------------------------------------------------------
    // No score, no turnover: normal advancement
    // ---------------------------------------------------------------------------
    state.ballYardline = clamp(newYard, 1, 99);
  
    const yardsToFirst = state.distance - yardsGained;
  
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
    const yards = Number.isFinite(outcome.yardsGained)
      ? outcome.yardsGained
      : 0;

    switch (playType) {
      case "run": {
        if (yards > 0) {
          return `${team} run for ${yards} yards`;
        } else if (yards < 0) {
          return `${team} run for a loss of ${Math.abs(yards)} yards`;
        }
        return `${team} run for no gain`;
      }
      case "pass": {
        if (outcome.sack) {
          return `${team} sacked for a loss of ${Math.abs(yards)} yards`;
        }
        if (outcome.interception) {
          return `${team} pass intercepted`;
        }
        if (yards > 0) {
          return `${team} pass complete for ${yards} yards`;
        }
        if (yards < 0) {
          return `${team} pass complete for -${Math.abs(yards)} yards`;
        }
        return `${team} incomplete pass`;
      }
      case "field_goal": {
        const dist = Math.round(outcome.kickDistance || 0);
        if (outcome.fieldGoalGood) {
          return dist
            ? `${team} field goal from ${dist} yards is good`
            : `${team} field goal is good`;
        }
        return dist
          ? `${team} misses field goal from ${dist} yards`
          : `${team} misses field goal`;
      }
      case "punt": {
        const dist = Math.round(outcome.puntDistance || 0);
        if (dist) {
          return `${team} punts ${dist} yards`;
        }
        return `${team} punts`;
      }
      default: {
        if (yards > 0) {
          return `${team} ${playType} play for ${yards} yards`;
        } else if (yards < 0) {
          return `${team} ${playType} play for a loss of ${Math.abs(yards)} yards`;
        }
        return `${team} ${playType} play for no gain`;
      }
    }
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
  