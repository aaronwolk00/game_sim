// game_engine.js
// -----------------------------------------------------------------------------
// Layer 4: Game / Drive Engine
//
// Orchestrates:
//   - Game state (clock, downs, field position, score, timeouts).
//   - Play-calling AI (run/pass, depth, go-for-it vs punt vs FG).
//   - Integration with micro_engine (per-play simulation).
//   - Turnovers, scoring, drive summaries, momentum updates.
//
// Public API:
//   simulateGame(homeTeam, awayTeam, options?) -> GameResult
//
// This module does NOT touch the DOM directly; simulation.html
// imports it and renders whatever it wants from GameResult.
// -----------------------------------------------------------------------------

import { clamp01 } from "./random_models.js";
import {
  simulatePlayMicro,
  PlayType,
  PassDepth,
  RunDirection,
} from "./micro_engine.js";

// -----------------------------------------------------------------------------
// RNG wrapper import (must exist in random_models.js)
// -----------------------------------------------------------------------------
import { Rng } from "./random_models.js";

// -----------------------------------------------------------------------------
// Types (informal JSDoc style)
// -----------------------------------------------------------------------------
/**
 * @typedef {Object} GameOptions
 * @property {number} [quarterLengthSec=900]
 * @property {number} [seed=12345]
 * @property {boolean} [allowOvertime=false]
 */

/**
 * @typedef {Object} GameState
 * @property {number} quarter          // 1..4 (or 5 if OT)
 * @property {number} clockSec         // seconds left in current quarter (0..quarterLengthSec)
 * @property {number} quarterLengthSec
 * @property {"HOME"|"AWAY"} possession
 * @property {number} down             // 1..4
 * @property {number} distance         // yards to first down
 * @property {number} fieldPosition    // 0..100 from offense goal line
 * @property {number} yardsToEndZone   // 100 - fieldPosition
 * @property {number} homeScore
 * @property {number} awayScore
 * @property {number} homeTimeouts
 * @property {number} awayTimeouts
 * @property {number} driveId
 * @property {number} playIndex
 * @property {number} momentum         // -1..1 (offense positive, defense negative)
 */

// -----------------------------------------------------------------------------
// Helpers: possession / sides
// -----------------------------------------------------------------------------

function getOffenseDefenseTeams(homeTeam, awayTeam, gameState) {
  const offenseTeam = gameState.possession === "HOME" ? homeTeam : awayTeam;
  const defenseTeam = gameState.possession === "HOME" ? awayTeam : homeTeam;
  return { offenseTeam, defenseTeam };
}

function flipPossession(gameState) {
  gameState.possession = gameState.possession === "HOME" ? "AWAY" : "HOME";
}

// -----------------------------------------------------------------------------
// Game state initialization & termination
// -----------------------------------------------------------------------------

function initializeGameState(options = {}) {
  const quarterLengthSec = options.quarterLengthSec ?? 900;

  // Coin flip for first possession
  const possession = Math.random() < 0.5 ? "HOME" : "AWAY";

  /** @type {GameState} */
  const state = {
    quarter: 1,
    clockSec: quarterLengthSec,
    quarterLengthSec,
    possession,
    down: 1,
    distance: 10,
    fieldPosition: 25, // start at own 25 after touchback
    yardsToEndZone: 75,
    homeScore: 0,
    awayScore: 0,
    homeTimeouts: 3,
    awayTimeouts: 3,
    driveId: 1,
    playIndex: 0,
    momentum: 0.0,
  };

  return state;
}

function isEndOfRegulation(gameState, options) {
  const allowOvertime = !!options.allowOvertime;
  if (gameState.quarter < 4) return false;
  if (gameState.clockSec > 0) return false;
  if (allowOvertime) return false;
  return true;
}

function isGameOver(gameState, options, scoreDiff) {
  const allowOvertime = !!options.allowOvertime;

  // End of regulation, no OT.
  if (!allowOvertime && isEndOfRegulation(gameState, options)) {
    return true;
  }

  // End of OT (basic sudden-death-ish treatment, but you can expand).
  if (
    allowOvertime &&
    gameState.quarter >= 5 &&
    gameState.clockSec <= 0
  ) {
    // If still tied after OT, game ends.
    return true;
  }

  // For now, no early mercy rules, etc.
  return false;
}

function advanceClock(gameState, seconds) {
  let remaining = seconds;
  while (remaining > 0.001) {
    if (gameState.clockSec > remaining) {
      gameState.clockSec -= remaining;
      remaining = 0;
    } else {
      remaining -= gameState.clockSec;
      gameState.clockSec = 0;
      // End of quarter => advance quarter
      if (gameState.quarter < 4) {
        gameState.quarter += 1;
        gameState.clockSec = gameState.quarterLengthSec;
      } else {
        // In OT or after Q4 if OT; we leave quarter & clockSec at 0;
        // game_over will handle termination.
        break;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Basic stats + drive tracking
// -----------------------------------------------------------------------------

function createDrive(gameState) {
  return {
    driveId: gameState.driveId,
    startQuarter: gameState.quarter,
    startClockSec: gameState.clockSec,
    startFieldPosition: gameState.fieldPosition,
    startPossession: gameState.possession,
    plays: [],
    totalYards: 0,
    result: null, // "TD", "FG", "PUNT", "DOWN", "INT", "FUMBLE", "END_HALF", "MISS_FG"
  };
}

// -----------------------------------------------------------------------------
// Special teams models (FG & PUNT)
// -----------------------------------------------------------------------------

function isFieldGoalReasonable(gameState) {
  // Very simple: inside opponent 38 => reasonable try.
  const yardsToEndZone = gameState.yardsToEndZone;
  return yardsToEndZone <= 55; // roughly <= 55 + 8 = 63 yard attempt
}

function attemptFieldGoal({
  gameState,
  offenseTeam,
  defenseTeam,
  rngKick,
}) {
  const fieldPos = gameState.fieldPosition;
  const yardsToEndZone = 100 - fieldPos;
  const kickDistance = yardsToEndZone + 17; // 17-yard adjustment (endzone + snap)

  const stProfile =
    (offenseTeam.unitProfiles && offenseTeam.unitProfiles.special) || {};
  const kickSkill = (stProfile.kicking ?? 60) / 100;

  // Logistic model for FG success as a function of distance and kicker quality.
  const x =
    3.0 * (kickSkill - 0.5) - 0.075 * (kickDistance - 40); // ~40yd baseline
  const successProb = clamp01(1 / (1 + Math.exp(-x)));

  const isGood = rngKick.next() < successProb;

  const playTime = 5; // roughly including setup

  // After any FG attempt, possession flips and new drive starts at 25 (touchback).
  // For a miss: defense takes over at previous LOS in real NFL, but we simplify:
  //   - On GOOD: new possession at own 25.
  //   - On MISS: defense takes over where ball was (flip field).
  let result = {
    isGood,
    points: isGood ? 3 : 0,
    playTimeSec: playTime,
    yards: 0,
    outcome: isGood ? "FG_GOOD" : "FG_MISS",
  };

  return result;
}

function attemptPunt({ gameState, offenseTeam, defenseTeam, rngKick }) {
  const fieldPos = gameState.fieldPosition;

  const stProfile =
    (offenseTeam.unitProfiles && offenseTeam.unitProfiles.special) || {};
  const puntSkill = (stProfile.punting ?? 60) / 100;

  // Gross distance ~ N(44,8) scaled by punter quality.
  let gross = rngKick.normal(44 + 8 * (puntSkill - 0.5), 8);
  gross = Math.max(20, Math.min(70, gross));

  // Net effect with return / coverage.
  const coverageSkill = (stProfile.coverage ?? 55) / 100;
  const defReturnProfile =
    (defenseTeam.unitProfiles && defenseTeam.unitProfiles.special) || {};
  const returnSkill = (defReturnProfile.returner ?? 55) / 100;

  let net = gross - (10 * (returnSkill - coverageSkill));
  net = Math.max(20, Math.min(60, net));

  const playTime = 8; // time off clock

  return {
    netYards: Math.round(net),
    playTimeSec: playTime,
    outcome: "PUNT",
  };
}

// -----------------------------------------------------------------------------
// Play-calling AI
// -----------------------------------------------------------------------------

function choosePlayCall({
  homeTeam,
  awayTeam,
  gameState,
  rngCoaching,
}) {
  const { offenseTeam, defenseTeam } = getOffenseDefenseTeams(
    homeTeam,
    awayTeam,
    gameState
  );

  const offProfile =
    (offenseTeam.unitProfiles && offenseTeam.unitProfiles.offense) || {};
  const defProfile =
    (defenseTeam.unitProfiles && defenseTeam.unitProfiles.defense) || {};

  const basePass = (offProfile.pass ?? 55) / 100;
  const runBias = (offProfile.run ?? 50) / 100;

  const down = gameState.down;
  const distance = gameState.distance;
  const yardsToEndZone = gameState.yardsToEndZone;
  const scoreDiff =
    gameState.possession === "HOME"
      ? gameState.homeScore - gameState.awayScore
      : gameState.awayScore - gameState.homeScore;
  const clock = gameState.clockSec;
  const quarter = gameState.quarter;

  // 1) Decide high-level: go-for-it / FG / punt / normal offense.
  // ---------------------------------------------------------------

  // 4th-down logic.
  if (down === 4) {
    const inFGRange = isFieldGoalReasonable(gameState);
    const isLate = quarter >= 4 && clock < 6 * 60;
    const behind = scoreDiff < 0;

    // Simple 4th-down decision rules:
    // - Deep in own territory => punt
    // - In mid-field, short distance and late/behind => go for it
    // - In FG range and distance > 2 => kick
    if (gameState.fieldPosition < 40 && distance > 1) {
      // Punt from own side
      return { kind: "KICK", kickType: "PUNT" };
    }

    if (inFGRange && distance > 2 && !behind) {
      return { kind: "KICK", kickType: "FG" };
    }

    if (isLate && behind && distance <= 4) {
      // Aggressive go-for-it
      // fall through to normal offense, but skew toward pass
    } else if (distance > 5 && inFGRange && !behind) {
      // Conservative FG choice
      return { kind: "KICK", kickType: "FG" };
    } else if (distance > 7 && !inFGRange && !behind) {
      // Punt in no-man's land
      return { kind: "KICK", kickType: "PUNT" };
    }
  }

  // 2) Run vs pass
  // ---------------------------------------------------------------
  let passProb = basePass;

  // Down and distance effect.
  if (down === 1) {
    passProb -= 0.05; // slightly more run
  } else if (down === 2 && distance >= 7) {
    passProb += 0.10;
  } else if (down === 3) {
    if (distance >= 7) passProb += 0.25;
    else passProb += 0.10;
  }

  // Score & clock context.
  const trailing = scoreDiff < 0;
  const leading = scoreDiff > 0;

  if (trailing && quarter >= 4 && clock < 10 * 60) {
    // Down late and trailing – pass heavier.
    passProb += 0.15;
  } else if (leading && quarter >= 4 && clock < 7 * 60 && distance > 2) {
    // Protect lead: more run on early downs.
    passProb -= 0.12;
  }

  // Field position: near goal line -> slightly more run.
  if (yardsToEndZone <= 5) {
    passProb -= 0.05;
  }

  // Defensive strengths: strong pass defense? run more.
  const defPass = (defProfile.coverage ?? 60) / 100;
  const defRun = (defProfile.runFit ?? 60) / 100;
  passProb += 0.1 * (runBias - defRun) - 0.1 * (defPass - 0.5);

  passProb = clamp01(passProb);

  const isPass = rngCoaching.next() < passProb;

  if (!isPass) {
    // RUN play: choose direction.
    let dirProbOutside = 0.35;
    if (defRun > 0.6) dirProbOutside += 0.1; // attack edges vs strong interior
    if (gameState.yardsToEndZone <= 5) dirProbOutside -= 0.1;

    const direction =
      rngCoaching.next() < dirProbOutside
        ? RunDirection.OUTSIDE
        : RunDirection.INSIDE;

    return {
      kind: "NORMAL",
      type: PlayType.RUN,
      direction,
    };
  }

  // PASS play: choose depth & concept.
  let depthRand = rngCoaching.next();
  let depth = PassDepth.INTERMEDIATE;

  if (down === 3 && distance >= 8) {
    // more intermediate/deep
    if (depthRand < 0.4) depth = PassDepth.INTERMEDIATE;
    else depth = PassDepth.DEEP;
  } else if (down === 3 && distance <= 3) {
    if (depthRand < 0.6) depth = PassDepth.SHORT;
    else depth = PassDepth.INTERMEDIATE;
  } else if (yardsToEndZone < 20 && distance <= 10) {
    // red-zone – more intermediate/short
    if (depthRand < 0.5) depth = PassDepth.SHORT;
    else depth = PassDepth.INTERMEDIATE;
  } else {
    // default mix
    if (depthRand < 0.5) depth = PassDepth.INTERMEDIATE;
    else if (depthRand < 0.8) depth = PassDepth.SHORT;
    else depth = PassDepth.DEEP;
  }

  // Concept: occasional play-action or screen.
  let concept = "STANDARD";
  if (depth === PassDepth.SHORT && rngCoaching.next() < 0.15) {
    concept = "SCREEN";
  } else if (!trailing && down === 1 && rngCoaching.next() < 0.15) {
    concept = "PLAY_ACTION";
  }

  return {
    kind: "NORMAL",
    type: PlayType.PASS,
    depth,
    concept,
  };
}

// -----------------------------------------------------------------------------
// Momentum updates
// -----------------------------------------------------------------------------

function updateMomentum(gameState, playResult, driveContext) {
  // Simple momentum model:
  //   - Positive yards -> small increase
  //   - Negative yards / sack -> decrease
  //   - TD, INT, lost fumble -> big swing
  //   - Clamp to [-1,1] and apply small decay each play.

  let delta = 0;

  if (playResult.outcome === "PASS_COMPLETE" || playResult.outcome === "RUN") {
    delta += playResult.yards * 0.003; // ~0.03 for 10-yard gain
  } else if (playResult.outcome === "SACK") {
    delta -= Math.abs(playResult.yards) * 0.008;
  }

  if (playResult.turnover === "INTERCEPTION") {
    delta -= 0.6;
  } else if (playResult.turnover === "FUMBLE") {
    delta -= 0.5;
  }

  if (driveContext.justScoredTD) {
    delta += 0.4;
  } else if (driveContext.justScoredFG) {
    delta += 0.25;
  }

  // Decay toward 0.
  gameState.momentum *= 0.9;
  gameState.momentum = clamp01(0.5 + (gameState.momentum + delta) / 2) * 2 - 1;
}

// -----------------------------------------------------------------------------
// Applying play results to game state
// -----------------------------------------------------------------------------

function applyNormalPlayResult({
  gameState,
  playResult,
  scoreDelta,
}) {
  const yards = playResult.yards;
  const fieldPosBefore = gameState.fieldPosition;
  const downBefore = gameState.down;
  const distanceBefore = gameState.distance;

  let newFieldPos = fieldPosBefore + yards;
  newFieldPos = Math.max(0, Math.min(100, newFieldPos));
  let yardsToEndZone = 100 - newFieldPos;

  // Scoring check: if offense crosses goal line during play (TD)
  let scoredTD = false;
  if (newFieldPos >= 100) {
    scoredTD = true;
    // TD spot is in end zone; for next drive, we reset via kickoff.
  }

  let turnover = playResult.turnover !== "NONE";

  // Down & distance logic (if no TD yet and not turnover-on-play)
  let newDown = gameState.down;
  let newDistance = gameState.distance;

  if (!scoredTD && !turnover) {
    if (yards >= distanceBefore) {
      // First down
      newDown = 1;
      const ytg = 100 - newFieldPos;
      newDistance = Math.min(10, ytg);
    } else {
      newDown = downBefore + 1;
      newDistance = distanceBefore - yards;
    }

    // Turnover on downs
    if (newDown > 4) {
      turnover = true;
    }
  }

  // Clock
  advanceClock(gameState, playResult.timeElapsedSec || 0);

  // Scoring: only TD here (FG handled in special teams block).
  if (scoredTD) {
    if (gameState.possession === "HOME") {
      gameState.homeScore += 6;
      scoreDelta.home += 6;
    } else {
      gameState.awayScore += 6;
      scoreDelta.away += 6;
    }
    // Simple XP model: 95% chance of extra point.
    if (Math.random() < 0.95) {
      if (gameState.possession === "HOME") {
        gameState.homeScore += 1;
        scoreDelta.home += 1;
      } else {
        gameState.awayScore += 1;
        scoreDelta.away += 1;
      }
    }

    // After TD, kickoff: flip possession, new drive from 25.
    flipPossession(gameState);
    gameState.driveId += 1;
    gameState.down = 1;
    gameState.distance = 10;
    gameState.fieldPosition = 25;
    gameState.yardsToEndZone = 75;

    return {
      driveEnded: true,
      result: "TD",
    };
  }

  // Non-TD turnover (INT/FUMBLE or turnover on downs)
  if (turnover) {
    // New offense is other team; field position flips perspective.
    flipPossession(gameState);
    const newOffFieldPos = 100 - newFieldPos;
    gameState.fieldPosition = newOffFieldPos;
    gameState.yardsToEndZone = 100 - newOffFieldPos;
    gameState.down = 1;
    gameState.distance = Math.min(10, gameState.yardsToEndZone);
    gameState.driveId += 1;

    const result =
      playResult.turnover === "INTERCEPTION"
        ? "INT"
        : playResult.turnover === "FUMBLE"
        ? "FUMBLE"
        : "DOWN";

    return {
      driveEnded: true,
      result,
    };
  }

  // No turnover, no TD – drive continues.
  gameState.fieldPosition = newFieldPos;
  gameState.yardsToEndZone = yardsToEndZone;
  gameState.down = newDown;
  gameState.distance = newDistance;

  return {
    driveEnded: false,
    result: null,
  };
}

// -----------------------------------------------------------------------------
// Special teams: applying FG and punt to game state
// -----------------------------------------------------------------------------

function applyFieldGoalResult({
  gameState,
  fgResult,
  scoreDelta,
}) {
  // Clock was already advanced
  if (fgResult.isGood) {
    if (gameState.possession === "HOME") {
      gameState.homeScore += fgResult.points;
      scoreDelta.home += fgResult.points;
    } else {
      gameState.awayScore += fgResult.points;
      scoreDelta.away += fgResult.points;
    }

    // After made FG: kickoff => new drive other team at 25.
    flipPossession(gameState);
    gameState.driveId += 1;
    gameState.down = 1;
    gameState.distance = 10;
    gameState.fieldPosition = 25;
    gameState.yardsToEndZone = 75;

    return {
      driveEnded: true,
      result: "FG",
    };
  }

  // Missed FG: defense takes over at previous spot (perspective flip).
  flipPossession(gameState);
  const newOffFieldPos = 100 - gameState.fieldPosition;
  gameState.fieldPosition = newOffFieldPos;
  gameState.yardsToEndZone = 100 - newOffFieldPos;
  gameState.down = 1;
  gameState.distance = Math.min(10, gameState.yardsToEndZone);
  gameState.driveId += 1;

  return {
    driveEnded: true,
    result: "MISS_FG",
  };
}

function applyPuntResult({
  gameState,
  puntResult,
}) {
  const fieldPosBefore = gameState.fieldPosition;
  let ballSpot = fieldPosBefore + puntResult.netYards;
  ballSpot = Math.max(0, Math.min(100, ballSpot));

  // If ballSpot >= 100, touchback.
  if (ballSpot >= 100) {
    ballSpot = 80; // 20-yard touchback from offense perspective
  }

  // Flip possession; new offense's field position is 100 - ballSpot.
  flipPossession(gameState);
  const newOffFieldPos = 100 - ballSpot;
  gameState.fieldPosition = newOffFieldPos;
  gameState.yardsToEndZone = 100 - newOffFieldPos;
  gameState.down = 1;
  gameState.distance = Math.min(10, gameState.yardsToEndZone);
  gameState.driveId += 1;

  return {
    driveEnded: true,
    result: "PUNT",
  };
}

// -----------------------------------------------------------------------------
// Main: simulateGame
// -----------------------------------------------------------------------------

/**
 * Simulate a single game between homeTeam and awayTeam.
 *
 * homeTeam / awayTeam must be Team instances (from data_models) with:
 *   - teamId, teamName
 *   - roster: Player[]
 *   - unitProfiles (offense, defense, special) from random_models.prepareLeagueForSimulation
 *
 * @param {Team} homeTeam
 * @param {Team} awayTeam
 * @param {GameOptions} [options]
 * @returns {Object} GameResult
 */
export function simulateGame(homeTeam, awayTeam, options = {}) {
  const quarterLengthSec = options.quarterLengthSec ?? 900;
  const seed = options.seed ?? 12345;

  // Dedicated RNG streams
  const rngPlay = new Rng(seed);
  const rngCoaching = new Rng(seed + 1);
  const rngKick = new Rng(seed + 2);
  const rngEnv = new Rng(seed + 3);

  const gameState = initializeGameState({ quarterLengthSec });

  const plays = [];
  const drives = [];

  let currentDrive = createDrive(gameState);

  // Safety guard: max plays to avoid infinite loops if bug.
  const MAX_PLAYS = 400;
  let globalPlayIdx = 0;

  while (globalPlayIdx < MAX_PLAYS) {
    const scoreDiff = gameState.homeScore - gameState.awayScore;
    if (isGameOver(gameState, options, scoreDiff)) break;

    const { offenseTeam, defenseTeam } = getOffenseDefenseTeams(
      homeTeam,
      awayTeam,
      gameState
    );

    // If quarter clock is 0 but we advanced to next quarter inside advanceClock,
    // we may still be at playable state. Re-check at top of loop. (Handled in isGameOver.)

    // Decide play call (run/pass vs kick vs go-for-it).
    const playCall = choosePlayCall({
      homeTeam,
      awayTeam,
      gameState,
      rngCoaching,
    });

    const startClock = gameState.clockSec;
    const startQuarter = gameState.quarter;
    const startDown = gameState.down;
    const startDistance = gameState.distance;
    const startFieldPos = gameState.fieldPosition;

    const playId = globalPlayIdx + 1;

    const scoreDeltaThisPlay = { home: 0, away: 0 };

    let microResult = null;
    let driveEndedInfo = null;
    let playKind = playCall.kind;

    if (playKind === "KICK" && playCall.kickType === "FG") {
      const fgResult = attemptFieldGoal({
        gameState,
        offenseTeam,
        defenseTeam,
        rngKick,
      });

      advanceClock(gameState, fgResult.playTimeSec);

      driveEndedInfo = applyFieldGoalResult({
        gameState,
        fgResult,
        scoreDelta: scoreDeltaThisPlay,
      });

      microResult = {
        playType: "FG",
        outcome: fgResult.outcome,
        yards: 0,
        turnover: "NONE",
        timeElapsedSec: fgResult.playTimeSec,
        penalty: null,
        debug: {
          fgResult,
        },
      };
    } else if (playKind === "KICK" && playCall.kickType === "PUNT") {
      const puntResult = attemptPunt({
        gameState,
        offenseTeam,
        defenseTeam,
        rngKick,
      });

      advanceClock(gameState, puntResult.playTimeSec);

      driveEndedInfo = applyPuntResult({
        gameState,
        puntResult,
      });

      microResult = {
        playType: "PUNT",
        outcome: "PUNT",
        yards: 0,
        turnover: "NONE",
        timeElapsedSec: puntResult.playTimeSec,
        penalty: null,
        debug: {
          puntResult,
        },
      };
    } else {
      // Normal offensive play (run/pass) via micro_engine.
      const mr = simulatePlayMicro({
        gameState,
        playCall,
        offenseTeam,
        defenseTeam,
        rngPlay,
        rngEnv,
      });

      microResult = mr;

      // Apply micro play: down/distance/field position/score
      driveEndedInfo = applyNormalPlayResult({
        gameState,
        playResult: mr,
        scoreDelta: scoreDeltaThisPlay,
      });
    }

    const endClock = gameState.clockSec;
    const endQuarter = gameState.quarter;

    // Drive context for momentum
    const driveContext = {
      justScoredTD: driveEndedInfo?.result === "TD",
      justScoredFG: driveEndedInfo?.result === "FG",
    };

    // Update momentum (offense perspective).
    updateMomentum(gameState, microResult, driveContext);

    // Log this play
    const logEntry = {
      playId,
      driveId: currentDrive.driveId,
      quarterStart: startQuarter,
      quarterEnd: endQuarter,
      clockStartSec: startClock,
      clockEndSec: endClock,
      downStart: startDown,
      distanceStart: startDistance,
      fieldPosStart: startFieldPos,
      possessionStart: currentDrive.startPossession,
      offenseTeamId: offenseTeam.teamId,
      defenseTeamId: defenseTeam.teamId,
      playCall,
      microResult,
      homeScoreAfter: gameState.homeScore,
      awayScoreAfter: gameState.awayScore,
      gameStateMomentumAfter: gameState.momentum,
    };

    plays.push(logEntry);
    currentDrive.plays.push(logEntry);
    currentDrive.totalYards += microResult.yards ?? 0;

    globalPlayIdx += 1;
    gameState.playIndex = globalPlayIdx;

    // If drive ended, store result and create a new drive if game continues.
    if (driveEndedInfo?.driveEnded) {
      currentDrive.result = driveEndedInfo.result;
      drives.push(currentDrive);

      if (!isGameOver(gameState, options, gameState.homeScore - gameState.awayScore)) {
        currentDrive = createDrive(gameState);
      }
    }

    // If quarter ended with no explicit drive flip, we still continue loop
    // until gameOver condition triggers.
  }

  // If last drive is still open and not empty, record it as "END_HALF" or "END_GAME".
  if (currentDrive && currentDrive.plays.length > 0) {
    currentDrive.result =
      gameState.quarter >= 4 && gameState.clockSec <= 0
        ? "END_GAME"
        : "END_HALF";
    drives.push(currentDrive);
  }

  const gameResult = {
    homeTeamId: homeTeam.teamId,
    awayTeamId: awayTeam.teamId,
    homeTeamName: homeTeam.teamName,
    awayTeamName: awayTeam.teamName,
    finalScore: {
      home: gameState.homeScore,
      away: gameState.awayScore,
    },
    plays,
    drives,
    meta: {
      quarterLengthSec,
      totalPlays: plays.length,
      seed,
    },
  };

  return gameResult;
}

// -----------------------------------------------------------------------------
// Optional: convenience hook for simulation.html
// -----------------------------------------------------------------------------

/**
 * Attach a simple API to window for quick manual testing in the browser.
 * Example usage from console after league setup:
 *
 *   const result = window.SimGame.simulateGame(homeTeam, awayTeam, { seed: 42 });
 */
export function attachGameEngineToWindow() {
  if (typeof window !== "undefined") {
    window.SimGame = {
      simulateGame,
    };
  }
}
