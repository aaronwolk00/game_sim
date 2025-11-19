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
    // baseline scoring / big play tuning
    baseRunMean: 3.5,
    baseRunStd: 3.0,
    basePassMean: 5.8,
    basePassStd: 6.0,
    sackMeanLoss: -6,
    turnoverBaseProb: 0.015,
    // FG
    fgBaseProb: 0.75,
    fgAccuracyWeight: 0.003, // each rating point adjusts prob
    // Punting
    puntBaseDistance: 42,
    puntStd: 7,
    // Kickoffs
    kickoffTouchbackRate: 0.75,
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
    const rng = new RNG(seed);
  
    const state = createInitialGameState(homeTeam, awayTeam, cfg, rng);
  
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
  
  // Simulate a single drive: from current state until change of possession
  // (score, turnover, punt, turnover-on-downs, end of half/game).
  function simulateDrive(state) {
    const startingScore = cloneScore(state.score);
    const startingQuarter = state.quarter;
    const startingClock = state.clockSec;
    const { offenseSide } = getOffenseDefense(state);
  
    const drivePlays = [];
    let driveOver = false;
  
    while (!driveOver && !state.isFinal) {
      const playLog = simulatePlay(state);
      drivePlays.push(playLog);
  
      if (playLog.endOfDrive) {
        driveOver = true;
      }
  
      // End of quarter/game
      if (state.clockSec <= 0) {
        handleEndOfQuarterOrGame(state);
        driveOver = true;
      }
    }
  
    state.drives.push({
      driveId: state.driveId,
      offense: offenseSide,
      startQuarter: startingQuarter,
      endQuarter: state.quarter,
      startClockSec: startingClock,
      endClockSec: state.clockSec,
      startScore: startingScore,
      endScore: cloneScore(state.score),
      plays: drivePlays.map((p) => p.playId),
    });
  
    // If the game isn't final, and we just ended a drive by score/turnover/punt,
    // start the next drive with the other team, if clock remains.
    if (!state.isFinal && state.clockSec > 0) {
      const nextPossession = offenseSide === "home" ? "away" : "home";
      state.possession = nextPossession;
      state.ballYardline = 25; // Simplified: new drive starts at own 25
      state.down = 1;
      state.distance = 10;
      state.driveId += 1;
      startNewDrive(
        state,
        drivePlays[drivePlays.length - 1] || null,
        "New drive after change of possession"
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
  
  // -----------------------------------------------------------------------------
  // Play simulation
  // -----------------------------------------------------------------------------
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
  
    const situation = {
      down: state.down,
      distance: state.distance,
      yardline: state.ballYardline,
      quarter: state.quarter,
      clockSec: state.clockSec,
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
  
    applyPlayOutcomeToState(state, playOutcome);
  
    const playLog = buildPlayLog(state, decision, playOutcome);
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
    const { cfg } = state;
  
    const offRun = offenseUnits.run?.overall ?? 60;
    const defRun = defenseUnits.runFit?.overall ?? 60;
  
    const adv = (offRun - defRun) / 10;
    const mean = cfg.baseRunMean + adv * 1.1;
    const std = cfg.baseRunStd + 0.2 * Math.abs(adv);
  
    let yards = normal(rng, mean, std);
  
    // Add some tail events: stuffs + breakouts
    const roll = rng.next();
    if (roll < 0.05) {
      // Stuff / TFL
      yards -= rng.nextRange(3, 6);
    } else if (roll > 0.95) {
      // Breakaway
      yards += rng.nextRange(10, 40);
    }
  
    yards = Math.round(yards);
  
    // Turnover chance (fumble)
    let turnover = false;
    if (rng.next() < cfg.turnoverBaseProb * 0.8) {
      turnover = true;
    }
  
    const timeElapsed = rng.nextRange(20, 35); // average run play time
  
    return {
      playType: "run",
      yardsGained: yards,
      timeElapsed,
      turnover,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
    };
  }
  
  // ------------------------ Pass play ----------------------------------------
  function simulatePassPlay(state, offenseUnits, defenseUnits, rng) {
    const { cfg } = state;
  
    const offPass = offenseUnits.pass?.overall ?? 60;
    const defCover = defenseUnits.coverage?.overall ?? 60;
    const passRush = defenseUnits.passRush?.overall ?? 60;
    const adv = (offPass - defCover) / 10;
    const mean = cfg.basePassMean + adv * 1.2;
    const std = cfg.basePassStd + 0.3 * Math.abs(adv);
  
    let yards = normal(rng, mean, std);
  
    const rushPressure = (passRush - offPass) / 20;
    const sackProb = clamp(0.04 + rushPressure * 0.03, 0.01, 0.12);
    const intProbBase = cfg.turnoverBaseProb * 1.4;
    const intProb =
      intProbBase *
      (1 + clamp((defCover - offPass) / 20, -0.4, 0.7));
  
    let completion = true;
    let interception = false;
    let sack = false;
  
    const r = rng.next();
    if (r < sackProb) {
      // Sack
      sack = true;
      yards = cfg.sackMeanLoss + rng.nextRange(-3, 2); // negative
      completion = false;
    } else if (r < sackProb + intProb) {
      // Interception
      interception = true;
      completion = false;
      yards = rng.nextRange(-2, 5); // ball caught around LOS-ish
    } else {
      // Normal pass outcome: completion vs incompletion
      const completionProb = clamp(
        logistic((offPass - defCover) / 12),
        0.45,
        0.75
      );
      const compRoll = rng.next();
      if (compRoll > completionProb) {
        completion = false;
        yards = 0;
      }
    }
  
    // Big pass play tail
    if (completion && yards > 0 && rng.next() > 0.94) {
      yards += rng.nextRange(10, 50);
    }
  
    // Some incompletions are basically clock stoppages
    const timeElapsed = completion
      ? rng.nextRange(18, 40)
      : rng.nextRange(5, 12);
  
    const turnover = interception;
    return {
      playType: "pass",
      yardsGained: Math.round(yards),
      timeElapsed,
      turnover,
      interception,
      sack,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
    };
  }
  
  // ------------------------ Field goal ----------------------------------------
  function simulateFieldGoal(state, offenseUnits, specialOff, rng) {
    const { cfg } = state;
    const { offenseSide } = getOffenseDefense(state);
  
    const yardsToGoal = 100 - state.ballYardline;
    const kickDistance = yardsToGoal + 17; // typical NFL: LOS + 17 yards
  
    const kAcc = specialOff.kicking?.accuracy ?? 60;
    const kPow = specialOff.kicking?.power ?? 60;
  
    // Rough probability model: base + accuracy + power vs distance
    const distancePenalty = (kickDistance - 35) * 0.012; // beyond 35 reduces
    let prob =
      cfg.fgBaseProb +
      cfg.fgAccuracyWeight * (kAcc - 70) +
      0.002 * (kPow - 70) -
      distancePenalty;
  
    prob = clamp(prob, 0.05, 0.98);
  
    const made = rng.next() < prob;
  
    const timeElapsed = rng.nextRange(5, 9);
  
    return {
      playType: "field_goal",
      yardsGained: 0,
      timeElapsed,
      turnover: !made, // ball to defense if missed
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
    const { offenseSide, defenseSide } = getOffenseDefense(state);
    const { cfg } = state;
  
    // Advance clock
    state.clockSec = Math.max(
      0,
      state.clockSec - outcome.timeElapsed
    );
  
    // Field goal
    if (outcome.fieldGoalAttempt) {
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
      // After FG, new possession will be switched in simulateDrive
      state.down = 1;
      state.distance = 10;
      outcome.endOfDrive = true;
      state.playId += 1;
      return;
    }
  
    // Punt: we don't model exact landing spot; just approximate new field position
    if (outcome.punt) {
      const newYardline = Math.max(
        10,
        100 - Math.round(outcome.puntDistance)
      );
      state.possession =
        offenseSide === "home" ? "away" : "home";
      state.ballYardline = newYardline;
      state.down = 1;
      state.distance = 10;
      state.playId += 1;
      outcome.endOfDrive = true;
      return;
    }
  
    // Normal offensive play (run / pass)
    let newYard = state.ballYardline + outcome.yardsGained;
  
    // Safety (ball carrier tackled in own end zone)
    if (newYard <= 0) {
      // Safety for defense
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
  
      // Next drive will begin from other team after free kick; we approximate
      state.possession = defenseSide;
      state.ballYardline = 35;
      state.down = 1;
      state.distance = 10;
      state.playId += 1;
      outcome.safety = true;
      outcome.endOfDrive = true;
      return;
    }
  
    // Touchdown
    if (newYard >= 100) {
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
  
      outcome.touchdown = true;
      state.playId += 1;
      outcome.endOfDrive = true;
      return;
    }
  
    // Turnover (non-FG / non-punt)
    if (outcome.turnover) {
      state.possession =
        offenseSide === "home" ? "away" : "home";
      // When turnover happens, we approximate spot as where play ended
      state.ballYardline = 100 - clamp(newYard, 1, 99);
      state.down = 1;
      state.distance = 10;
      state.playId += 1;
      outcome.endOfDrive = true;
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
  
    // No score, no turnover: normal advancement
    state.ballYardline = clamp(newYard, 1, 99);
  
    const yardsToFirst = state.distance - outcome.yardsGained;
  
    if (yardsToFirst <= 0) {
      // First down
      state.down = 1;
      state.distance = 10;
    } else {
      // Advance down
      if (state.down === 4) {
        // Turnover on downs
        state.possession =
          offenseSide === "home" ? "away" : "home";
        state.ballYardline =
          100 - clamp(state.ballYardline, 1, 99);
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
  
  // Build a play log entry after outcome is applied
  function buildPlayLog(state, decision, outcome) {
    const {
      offenseSide,
      defenseSide,
      offenseTeam,
      defenseTeam,
    } = getOffenseDefense(state);
  
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
  // Result object & summary
  // -----------------------------------------------------------------------------
  function buildGameResult(state) {
    const { homeTeam, awayTeam, score } = state;
    const diff = score.home - score.away;
    const winner =
      diff > 0 ? "home" : diff < 0 ? "away" : null;
  
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
  