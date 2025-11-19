// micro_engine.js
// -----------------------------------------------------------------------------
// Play Micro-Engine
//
// This module handles *per-play* football simulation:
//   - Pass plays: pass rush vs protection, separation, ball placement,
//                 catch vs incompletion vs INT, YAC, sacks, fumbles.
//   - Run plays: point-of-attack vs run fit, broken tackles, explosive runs,
//                stuffs, fumbles.
//   - Penalties and weird events (stochastic, driven by discipline/aggression).
//
// It uses:
//   - Player latent profiles (A/C/T/P/V) attached by random_models.prepareLeagueForSimulation
//   - Team unit profiles (offense/defense/special) computed in random_models
//   - RNG streams provided by game_engine.js
//
// It does NOT update GameState – that’s game_engine.js’ job.
// Instead, it returns a rich PlayMicroResult object describing:
//   yards, outcome, turnover flags, penalties, time elapsed, and debug info.
// -----------------------------------------------------------------------------

import { Player, Team } from "./data_models.js";
import { clamp01, lerp, logistic } from "./random_models.js";

// -----------------------------------------------------------------------------
// Enums / constants
// -----------------------------------------------------------------------------

export const PlayType = Object.freeze({
  PASS: "PASS",
  RUN: "RUN",
});

export const PassDepth = Object.freeze({
  SHORT: "SHORT",
  INTERMEDIATE: "INTERMEDIATE",
  DEEP: "DEEP",
});

export const RunDirection = Object.freeze({
  INSIDE: "INSIDE",
  OUTSIDE: "OUTSIDE",
});

export const PlayOutcomeType = Object.freeze({
  PASS_COMPLETE: "PASS_COMPLETE",
  PASS_INCOMPLETE: "PASS_INCOMPLETE",
  INTERCEPTION: "INTERCEPTION",
  SACK: "SACK",
  RUN: "RUN",
  FUMBLE_LOST: "FUMBLE_LOST",
  FUMBLE_OUT_OF_BOUNDS: "FUMBLE_OUT_OF_BOUNDS",
  PENALTY_ONLY: "PENALTY_ONLY", // dead-ball penalty, no play
});

export const PenaltyType = Object.freeze({
  NONE: "NONE",
  OFF_HOLDING: "OFF_HOLDING",
  DEF_PI: "DEF_PI",
  DEF_HOLDING: "DEF_HOLDING",
  FALSE_START: "FALSE_START",
  OFF_PI: "OFF_PI",
  PERSONAL_FOUL: "PERSONAL_FOUL",
});

export const TurnoverType = Object.freeze({
  NONE: "NONE",
  INTERCEPTION: "INTERCEPTION",
  FUMBLE: "FUMBLE",
});

// Default clock impact (seconds) for typical plays if game_engine
// doesn't override based on specific context.
const DEFAULT_PASS_PLAY_TIME = 5; // includes huddle + snap + result
const DEFAULT_RUN_PLAY_TIME = 5;

// -----------------------------------------------------------------------------
// Helper: basic depth chart access / starter selection
// -----------------------------------------------------------------------------

function getDepthChart(team, pos) {
  if (typeof team.getDepthChart === "function") {
    return team.getDepthChart(pos) || [];
  }
  // Fallback: filter roster by position and sort by depth (if any) then rating
  const roster = team.roster || [];
  return roster
    .filter((p) => p.position === pos)
    .sort((a, b) => {
      const da = a.depth ?? 999;
      const db = b.depth ?? 999;
      if (da !== db) return da - db;
      return (b.ratingOverall || 0) - (a.ratingOverall || 0);
    });
}

function getStarter(team, pos) {
  const chart = getDepthChart(team, pos);
  return chart.length ? chart[0] : null;
}

function chooseTargetReceiver(offenseTeam, playCall, rng) {
  // Very simple rule-based selection for now:
  //   SHORT: RB/TE/slot WR bias
  //   INTERMEDIATE: WR/TE
  //   DEEP: WR bias
  //
  // game_engine can override by putting playCall.targetId.
  if (playCall && playCall.targetId) {
    // Let game_engine pre-select exact target if desired
    return offenseTeam.getPlayerById
      ? offenseTeam.getPlayerById(playCall.targetId)
      : null;
  }

  const wrChart = getDepthChart(offenseTeam, "WR");
  const teChart = getDepthChart(offenseTeam, "TE");
  const rbChart = getDepthChart(offenseTeam, "RB");

  const depth = playCall.depth || PassDepth.INTERMEDIATE;
  const bucket = [];

  if (depth === PassDepth.SHORT) {
    if (rbChart[0]) bucket.push(rbChart[0]);
    if (teChart[0]) bucket.push(teChart[0]);
    if (wrChart[0]) bucket.push(wrChart[0]);
    if (wrChart[1]) bucket.push(wrChart[1]);
  } else if (depth === PassDepth.INTERMEDIATE) {
    if (wrChart[0]) bucket.push(wrChart[0]);
    if (wrChart[1]) bucket.push(wrChart[1]);
    if (teChart[0]) bucket.push(teChart[0]);
  } else {
    // DEEP
    if (wrChart[0]) bucket.push(wrChart[0]);
    if (wrChart[1]) bucket.push(wrChart[1]);
    if (wrChart[2]) bucket.push(wrChart[2]);
  }

  if (!bucket.length) {
    // Fallback: first WR or any offensive player
    if (wrChart[0]) return wrChart[0];
    const all = offenseTeam.roster || [];
    return all.length ? all[0] : null;
  }

  // Pick one uniformly for now
  const idx = Math.floor(rng.next() * bucket.length);
  return bucket[idx];
}

function choosePrimaryCoverageDefender(defenseTeam, target, rng) {
  // Very simple assignment:
  //   - If target is WR => CB
  //   - If target is TE => S or LB
  //   - If target is RB => LB
  //
  // For now, just pick the "starter-ish" defender at that role.
  if (!target) return null;
  const pos = target.position;
  let candidates = [];

  if (pos === "WR") {
    candidates = getDepthChart(defenseTeam, "CB");
  } else if (pos === "TE") {
    candidates = [
      ...getDepthChart(defenseTeam, "S"),
      ...getDepthChart(defenseTeam, "LB"),
    ];
  } else if (pos === "RB" || pos === "FB") {
    candidates = getDepthChart(defenseTeam, "LB");
  } else {
    // Fallback: best available DB
    candidates = [
      ...getDepthChart(defenseTeam, "CB"),
      ...getDepthChart(defenseTeam, "S"),
    ];
  }

  if (!candidates.length) return null;
  const idx = Math.floor(rng.next() * Math.min(3, candidates.length)); // top 3 at most
  return candidates[idx];
}

// -----------------------------------------------------------------------------
// Core submodels: PASS PLAY
// -----------------------------------------------------------------------------

/**
 * Compute time-to-pressure distribution outcome.
 *
 * Uses:
 *   - Offense unit pass protection (0..100)
 *   - Defense unit pass rush (0..100)
 *   - Defense blitzAggression (0..1)
 *   - Momentum (gameState.momentum, -1..1)
 */
function modelPassRush(offenseTeam, defenseTeam, gameState, playCall, rng) {
  const offProfile = (offenseTeam.unitProfiles && offenseTeam.unitProfiles.offense) || {};
  const defProfile = (defenseTeam.unitProfiles && defenseTeam.unitProfiles.defense) || {};

  const protection = (offProfile.protection ?? 50) / 100;
  const passRush = (defProfile.passRush ?? 50) / 100;
  const blitzAgg = defProfile.blitzAggression ?? 0.5;
  const momentum = gameState.momentum ?? 0; // offense positive, defense negative

  // Base mean time to pressure in seconds.
  let baseMu = 2.6;
  let baseSigma = 0.4;

  // Protection vs pass rush differential.
  const diff = protection - passRush; // -1..1
  baseMu += 0.7 * diff; // good OL vs bad rush => +0.7s
  // More aggressive blitz shortens mean time but widens tails.
  baseMu -= 0.25 * blitzAgg;
  baseSigma += 0.25 * blitzAgg;

  // Momentum: if defense is "hot" (negative momentum), we reduce time to pressure.
  baseMu -= 0.25 * clamp01(-momentum);

  // Play-call effect: play-action slightly bumps time to pressure, quick game reduces.
  const concept = playCall.concept || "STANDARD";
  if (concept === "PLAY_ACTION") {
    baseMu += 0.15;
  } else if (concept === "SCREEN" || playCall.depth === PassDepth.SHORT) {
    baseMu -= 0.2;
  }

  // Sample from normal and clamp to a reasonable range.
  const tPressure = Math.max(0.7, Math.min(5.0, rng.normal(baseMu, baseSigma)));

  // Pressure "intensity" – longer time reduces intensity.
  const pressureLevel = clamp01(1.2 - (tPressure / 3.0)); // ~1 at instant, ~0 by 3.6s+

  return { tPressure, pressureLevel };
}

/**
 * Compute the QB's time-to-throw and pressure context.
 */
function modelQBDecisionAndDropback(qb, playCall, rush, rng) {
  const depth = playCall.depth || PassDepth.INTERMEDIATE;
  let baseTThrow;

  if (depth === PassDepth.SHORT) baseTThrow = 2.1;
  else if (depth === PassDepth.INTERMEDIATE) baseTThrow = 2.6;
  else baseTThrow = 3.0; // DEEP

  const proc = qb.latent.C.get("qbProcessing", 0.5);
  const riskTol = qb.latent.P.get("riskTolerance", 0.5);

  // Faster processor => earlier throw.
  baseTThrow -= 0.5 * (proc - 0.5);
  // Risky QBs hold the ball more.
  baseTThrow += 0.4 * (riskTol - 0.5);

  const sigma = 0.25;
  let tThrow = rng.normal(baseTThrow, sigma);
  tThrow = Math.max(1.0, Math.min(4.5, tThrow));

  // Compare with time to pressure.
  const { tPressure, pressureLevel } = rush;
  let underPressure = false;

  if (tPressure < 0.6) {
    // Instant pressure – most likely sack / panic.
    underPressure = true;
  } else if (tPressure < tThrow) {
    underPressure = true;
    // QB may speed up throw if pressure arrives early.
    const hurryFactor = clamp01((tThrow - tPressure) / 1.5);
    tThrow = lerp(tThrow, tPressure, hurryFactor);
  }

  // Pressure severity: combine rush intensity + whether throw comes after pressure.
  let pressureSeverity = rush.pressureLevel;
  if (underPressure) {
    pressureSeverity = clamp01(0.5 + 0.5 * rush.pressureLevel);
  } else {
    pressureSeverity *= 0.4;
  }

  return { tThrow, tPressure, underPressure, pressureSeverity };
}

/**
 * Model receiver separation vs coverage at target depth.
 *
 * Returns separation in yards (can be negative if DB is in phase).
 */
function modelSeparation(offenseTeam, defenseTeam, target, coverageDef, playCall, rng) {
  if (!target) {
    return { separationYds: 0.0, sepScoreOff: 0.5, sepScoreDef: 0.5 };
  }

  // Offensive separation ability
  const routeCraft = target.latent.T.get("routeCraft", 0.5);
  const hands = target.latent.T.get("hands", 0.5);
  const agility = target.latent.A.get("agility", 0.5);
  const speedLong = target.latent.A.get("speedLong", 0.5);

  let sepOff = 0.25 * routeCraft + 0.25 * agility + 0.25 * speedLong + 0.25 * hands;

  // Depth modifiers: deeper routes reward long speed & route craft more.
  const depth = playCall.depth || PassDepth.INTERMEDIATE;
  if (depth === PassDepth.DEEP) {
    sepOff = clamp01(sepOff + 0.15 * (speedLong - 0.5));
  } else if (depth === PassDepth.SHORT) {
    sepOff = clamp01(sepOff + 0.12 * (agility - 0.5));
  }

  // Defensive coverage ability
  let covDef = 0.5;
  if (coverageDef) {
    const covAwareness = coverageDef.latent.C.get("coverageAwareness", 0.5);
    const covPattern = coverageDef.latent.C.get("patternIQ", 0.5);
    const cod = coverageDef.latent.A.get("changeOfDirection", 0.5);
    const speed = coverageDef.latent.A.get("speedLong", 0.5);

    covDef =
      0.35 * covAwareness + 0.25 * covPattern + 0.2 * cod + 0.2 * speed;
  } else {
    // Fallback: team-level coverage profile
    const defProfile =
      (defenseTeam.unitProfiles && defenseTeam.unitProfiles.defense) || {};
    covDef = (defProfile.coverage ?? 50) / 100;
  }

  // Team profile modifiers.
  const offProfile =
    (offenseTeam.unitProfiles && offenseTeam.unitProfiles.offense) || {};
  const defProfile =
    (defenseTeam.unitProfiles && defenseTeam.unitProfiles.defense) || {};

  const teamPass = (offProfile.pass ?? 50) / 100;
  const teamCoverage = (defProfile.coverage ?? 50) / 100;

  // Base separation in yards.
  let baseSepYds = 1.5; // nominal NFL separation
  const diff = (sepOff + teamPass - (covDef + teamCoverage)) * 0.5; // roughly -1..1
  baseSepYds += 1.3 * diff;

  // Depth scaling.
  if (depth === PassDepth.DEEP) {
    baseSepYds += 0.2; // more chance for separation deep
  } else if (depth === PassDepth.SHORT) {
    baseSepYds -= 0.1; // often tighter
  }

  // Noise ~ N(0, 0.7)
  const sepNoise = rng.normal(0, 0.7);
  let sepYds = baseSepYds + sepNoise;

  // Clamp to [-2, 5] yards for sanity.
  sepYds = Math.max(-2.0, Math.min(5.0, sepYds));

  return {
    separationYds: sepYds,
    sepScoreOff: sepOff,
    sepScoreDef: covDef,
  };
}

/**
 * Model QB ball placement error (radial, in yards) as a function of:
 *   - QB processing & under-pressure accuracy
 *   - pressureSeverity
 *   - throw depth
 */
function modelBallPlacement(qb, playCall, pressureContext, rng) {
  const depth = playCall.depth || PassDepth.INTERMEDIATE;
  const proc = qb.latent.C.get("qbProcessing", 0.5);
  const underPressureSkill = qb.latent.T.get("qbUnderPressure", 0.5);
  const pocketSkill = qb.latent.T.get("qbPocket", 0.5);
  const emotional = qb.latent.P.get("emotionalStability", 0.5);

  // Base accuracy skill scalar
  const baseAcc =
    0.4 * proc +
    0.25 * underPressureSkill +
    0.25 * pocketSkill +
    0.1 * emotional;

  const pressureSeverity = pressureContext.pressureSeverity;

  // Degrade accuracy under pressure.
  const effectiveAcc = clamp01(baseAcc - 0.3 * pressureSeverity);

  // Map effectiveAcc -> mean radial error in yards.
  //   acc ~0.5 => ~1.8yd mean
  //   acc ~0.8 => ~0.9yd
  //   acc ~0.3 => ~2.5yd
  const meanErr = 2.5 - 2.0 * effectiveAcc;
  const sigmaErr = 0.7 - 0.3 * effectiveAcc;

  // Deeper throws naturally have more error.
  let depthMultiplier = 1.0;
  if (depth === PassDepth.DEEP) depthMultiplier = 1.5;
  else if (depth === PassDepth.INTERMEDIATE) depthMultiplier = 1.2;

  const mu = meanErr * depthMultiplier;
  const sigma = sigmaErr * depthMultiplier;

  let radialError = Math.abs(rng.normal(mu, sigma));
  radialError = Math.min(radialError, 8.0); // cap extremes

  return { radialError, effectiveAcc, baseAcc };
}

/**
 * Resolve catch vs incompletion vs interception using:
 *   - separationYds (can be negative)
 *   - radialError (ball placement)
 *   - WR hands / DB ball skills
 *   - defensive chaos
 */
function resolveCatchPoint(
  target,
  coverageDef,
  separationYds,
  radialError,
  defenseTeam,
  rng
) {
  if (!target) {
    // No real target; almost always incomplete.
    return {
      outcome: PlayOutcomeType.PASS_INCOMPLETE,
      probCatch: 0.05,
      probInt: 0.0,
    };
  }

  const wrHands = target.latent.T.get("hands", 0.5);
  const wrBallSec = target.latent.T.get("ballSecurity", 0.5);

  let dbBallSkills = 0.5;
  if (coverageDef) {
    dbBallSkills = coverageDef.latent.C.get("coverageAwareness", 0.5);
  }

  const defProfile =
    (defenseTeam.unitProfiles && defenseTeam.unitProfiles.defense) || {};
  const chaosPlays = (defProfile.chaosPlays ?? 50) / 100;

  // Effective separation after ball placement error.
  // More error shrinks effective separation.
  const effectiveSep = separationYds - 0.6 * radialError;

  // Map effectiveSep -> base catch probability via logistic.
  //   sep = 0 => ~0.5 base
  //   sep = +2 => high
  //   sep = -1 => low
  const baseCatch = logistic(-0.2 + 0.9 * effectiveSep);

  // WR hands & ball security shape catch reliability.
  const handsBoost = (wrHands + wrBallSec) / 2;
  const catchProbPreClamp = baseCatch * (0.7 + 0.6 * (handsBoost - 0.5));

  // INT base from negative effectiveSep & DB ball skills.
  const baseInt =
    logistic(-1.4 - 0.9 * effectiveSep) * (0.6 + 0.8 * (dbBallSkills - 0.5));

  // Defensive chaos increases INT tails.
  const intProbPreClamp = baseInt * (0.7 + 0.6 * chaosPlays);

  let probCatch = clamp01(catchProbPreClamp);
  let probInt = clamp01(intProbPreClamp);

  // Renormalize so total <= 0.95, with remaining as incompletion.
  const total = probCatch + probInt;
  const maxTotal = 0.95;
  if (total > maxTotal) {
    probCatch *= maxTotal / total;
    probInt *= maxTotal / total;
  }
  const probIncomp = clamp01(1 - probCatch - probInt);

  const r = rng.next();
  let outcome = PlayOutcomeType.PASS_INCOMPLETE;
  if (r < probInt) {
    outcome = PlayOutcomeType.INTERCEPTION;
  } else if (r < probInt + probCatch) {
    outcome = PlayOutcomeType.PASS_COMPLETE;
  } else {
    outcome = PlayOutcomeType.PASS_INCOMPLETE;
  }

  return {
    outcome,
    probCatch,
    probInt,
    probIncomp,
    effectiveSep,
  };
}

/**
 * YAC model:
 *   - Ball carrier's elusiveness + power vs defense tackling / pursuit.
 *   - Use log-normal-ish distribution to allow rare long YAC.
 */
function modelYAC(ballCarrier, defenseTeam, rng) {
  if (!ballCarrier) return { yac: 0, yacMean: 0 };

  const agility = ballCarrier.latent.A.get("agility", 0.5);
  const speed = ballCarrier.latent.A.get("speedShort", 0.5);
  const power = ballCarrier.latent.A.get("power", 0.5);
  const tacklingDef =
    ((defenseTeam.unitProfiles &&
      defenseTeam.unitProfiles.defense &&
      defenseTeam.unitProfiles.defense.tackling) ??
      60) / 100;

  const chaosDef =
    ((defenseTeam.unitProfiles &&
      defenseTeam.unitProfiles.defense &&
      defenseTeam.unitProfiles.defense.chaosPlays) ??
      50) / 100;

  const elusiveness = (agility + speed) / 2;
  const yacSkill = 0.6 * elusiveness + 0.4 * power;

  // Base mean YAC (before tackling) in yards.
  let meanYac = 3.0 + 5.0 * (yacSkill - tacklingDef);

  // Defensive chaos: more chaos slightly increases tails (both big YAC and big TFL).
  const chaosFactor = 1 + 0.4 * (chaosDef - 0.5);

  // Log-normal style: sample from normal on log-space.
  const mu = Math.log(Math.max(0.5, meanYac * 0.6));
  const sigma = 0.6 * chaosFactor;

  const z = rng.normal(mu, sigma);
  let yac = Math.exp(z) - 0.5; // shift back
  if (!isFinite(yac)) yac = 0;

  // Some plays are dead on catch: scale by chance of immediate tackle.
  const immTackleProb = clamp01(tacklingDef * 0.7);
  if (rng.next() < immTackleProb) {
    yac *= 0.2;
  }

  // Clamp YAC to [-2, 80] for sanity; negative YAC = tackled behind catch spot.
  if (yac < -2) yac = -2;
  if (yac > 80) yac = 80;

  return { yac, yacMean: meanYac };
}

/**
 * Fumble model:
 *   - Uses ball carrier ballSecurity vs defense chaos & tackling.
 *   - Returns { isFumble, lost, yardsAfterFumble } – yardsAfterFumble is
 *     additional yards beyond the main run/pass result (often 0).
 */
function maybeFumble(ballCarrier, defenseTeam, rng) {
  if (!ballCarrier) {
    return {
      isFumble: false,
      lost: false,
      yardsAfterFumble: 0,
    };
  }

  const ballSec = ballCarrier.latent.T.get("ballSecurity", 0.5);
  const emotional = ballCarrier.latent.P.get("emotionalStability", 0.5);
  const chaosDef =
    ((defenseTeam.unitProfiles &&
      defenseTeam.unitProfiles.defense &&
      defenseTeam.unitProfiles.defense.chaosPlays) ??
      50) / 100;
  const tacklingDef =
    ((defenseTeam.unitProfiles &&
      defenseTeam.unitProfiles.defense &&
      defenseTeam.unitProfiles.defense.tackling) ??
      60) / 100;

  const securityComposite = 0.6 * ballSec + 0.4 * emotional;
  // Base fumble rate (per touch) ~1.5% in NFL; modulated by security vs chaos.
  let baseRate = 0.015;
  baseRate *= 1 + 1.2 * (chaosDef - securityComposite) + 0.6 * (tacklingDef - 0.5);
  baseRate = clamp01(baseRate);

  const isFumble = rng.next() < baseRate;
  if (!isFumble) {
    return { isFumble: false, lost: false, yardsAfterFumble: 0 };
  }

  // Lost fumble vs recovered – about 50/50, nudged by chaos.
  const lostProb = clamp01(0.5 + 0.15 * (chaosDef - 0.5));
  const lost = rng.next() < lostProb;

  // Extra yards from fumble return; can be negative (offense recovers behind spot).
  let yardsAfterFumble = 0;
  if (lost) {
    // Defensive return; mildly skewed positive.
    yardsAfterFumble = Math.round(rng.normal(5, 10));
  } else {
    // Scramble recovery; mild negative.
    yardsAfterFumble = Math.round(rng.normal(-2, 4));
  }

  yardsAfterFumble = Math.max(-15, Math.min(60, yardsAfterFumble));

  return { isFumble: true, lost, yardsAfterFumble };
}

// -----------------------------------------------------------------------------
// Run-play submodel
// -----------------------------------------------------------------------------

function modelRunYardage(offenseTeam, defenseTeam, ballCarrier, playCall, rng) {
  const offProfile =
    (offenseTeam.unitProfiles && offenseTeam.unitProfiles.offense) || {};
  const defProfile =
    (defenseTeam.unitProfiles && defenseTeam.unitProfiles.defense) || {};

  const runOff = (offProfile.run ?? 60) / 100;
  const explosiveness = (offProfile.explosiveness ?? 60) / 100;
  const runFit = (defProfile.runFit ?? 60) / 100;
  const tackling = (defProfile.tackling ?? 60) / 100;
  const chaos = (defProfile.chaosPlays ?? 50) / 100;

  let rbElusiveness = 0.5;
  let rbPower = 0.5;
  if (ballCarrier) {
    rbElusiveness = ballCarrier.latent.A.get("agility", 0.5);
    rbPower = ballCarrier.latent.A.get("power", 0.5);
  }

  const runSkill = 0.5 * runOff + 0.25 * rbElusiveness + 0.25 * rbPower;
  const defSkill = 0.45 * runFit + 0.3 * tackling + 0.25 * (1 - chaos);

  const diff = clamp01(runSkill - defSkill + 0.5) - 0.5; // roughly -0.5..0.5

  // Base mean yards and variance for NFL runs.
  let meanYds = 2.8 + 4.0 * diff;
  let sigmaYds = 2.1 + 1.2 * Math.abs(diff);

  // Direction effects.
  const direction = playCall.direction || RunDirection.INSIDE;
  if (direction === RunDirection.OUTSIDE) {
    meanYds += 0.2;
    sigmaYds += 0.3;
  }

  // Chaos: more chaos => more extremes.
  sigmaYds *= 1 + 0.6 * (chaos - 0.5);

  let yards = rng.normal(meanYds, sigmaYds);
  // Clamp to [-5, 80]
  yards = Math.max(-5, Math.min(80, yards));

  return { yards, meanYds, sigmaYds };
}

// -----------------------------------------------------------------------------
// Penalties
// -----------------------------------------------------------------------------

/**
 * Penalty model:
 *   - Looks at offense & defense discipline/aggression.
 *   - Can attach to an otherwise normal play OR be pre-snap (PENALTY_ONLY).
 *
 * Returns:
 *   {
 *     hasPenalty,
 *     type,
 *     onOffense,
 *     yards,
 *     automaticFirstDown,
 *     spotFoul,
 *     isPreSnap
 *   }
 */
function maybePenalty(offenseTeam, defenseTeam, gameState, playType, rng) {
  const offenseDisc = teamPsychMean(offenseTeam, "discipline");
  const defenseDisc = teamPsychMean(defenseTeam, "discipline");
  const offenseAgg = teamPsychMean(offenseTeam, "aggression");
  const defenseAgg = teamPsychMean(defenseTeam, "aggression");

  // Base penalty rate per play ~ 0.03, modulated by discipline & aggression.
  const avgDisc = (offenseDisc + defenseDisc) / 2;
  const avgAgg = (offenseAgg + defenseAgg) / 2;

  let baseRate = 0.03;
  baseRate *= 1 + 0.8 * (avgAgg - 0.5) - 0.7 * (avgDisc - 0.5);
  baseRate = clamp01(baseRate);

  const hasPenalty = rng.next() < baseRate;
  if (!hasPenalty) {
    return {
      hasPenalty: false,
      type: PenaltyType.NONE,
      onOffense: false,
      yards: 0,
      automaticFirstDown: false,
      spotFoul: false,
      isPreSnap: false,
    };
  }

  // Decide if it is pre-snap vs live-ball.
  const isPreSnap = rng.next() < 0.3;

  // Choose side and type.
  let onOffense = rng.next() < 0.55; // slightly more offensive penalties

  let type = PenaltyType.OFF_HOLDING;
  let yards = -10;
  let autoFirst = false;
  let spotFoul = false;

  if (isPreSnap) {
    // False start vs offsides/encroachment.
    const offsides = rng.next() < 0.4;
    if (offsides) {
      onOffense = false;
      type = PenaltyType.DEF_HOLDING; // approximate "offsides"
      yards = 5;
    } else {
      onOffense = true;
      type = PenaltyType.FALSE_START;
      yards = -5;
    }
    autoFirst = false;
    spotFoul = false;
  } else if (playType === PlayType.PASS) {
    // PI/holding/roughness etc.
    const r = rng.next();
    if (r < 0.4) {
      // Offensive holding
      onOffense = true;
      type = PenaltyType.OFF_HOLDING;
      yards = -10;
    } else if (r < 0.7) {
      // Defensive holding
      onOffense = false;
      type = PenaltyType.DEF_HOLDING;
      yards = 5;
      autoFirst = true;
    } else if (r < 0.9) {
      // DPI – spot-ish foul, treat as 15yd+auto first for now
      onOffense = false;
      type = PenaltyType.DEF_PI;
      yards = 15;
      autoFirst = true;
      spotFoul = true;
    } else {
      // Personal foul / roughing
      onOffense = false;
      type = PenaltyType.PERSONAL_FOUL;
      yards = 15;
      autoFirst = true;
    }
  } else {
    // Run plays: holding, face mask, etc.
    const r = rng.next();
    if (r < 0.55) {
      onOffense = true;
      type = PenaltyType.OFF_HOLDING;
      yards = -10;
    } else if (r < 0.85) {
      onOffense = false;
      type = PenaltyType.PERSONAL_FOUL;
      yards = 15;
      autoFirst = true;
    } else {
      onOffense = false;
      type = PenaltyType.DEF_HOLDING;
      yards = 5;
      autoFirst = false;
    }
  }

  return {
    hasPenalty: true,
    type,
    onOffense,
    yards,
    automaticFirstDown: autoFirst,
    spotFoul,
    isPreSnap,
  };
}

function teamPsychMean(team, key) {
  const vals = [];
  const roster = team.roster || [];
  for (const p of roster) {
    if (!p.latent || !p.latent.P) continue;
    vals.push(p.latent.P.get(key, 0.5));
  }
  if (!vals.length) return 0.5;
  let sum = 0;
  for (const v of vals) sum += v;
  return sum / vals.length;
}

// -----------------------------------------------------------------------------
// Public: PASS & RUN micro-sim
// -----------------------------------------------------------------------------

function simulatePassPlayMicro({
  gameState,
  playCall,
  offenseTeam,
  defenseTeam,
  rngPlay,
}) {
  const rng = rngPlay;
  const qb = getStarter(offenseTeam, "QB");
  const target = chooseTargetReceiver(offenseTeam, playCall, rng);
  const coverageDef = choosePrimaryCoverageDefender(defenseTeam, target, rng);

  const rush = modelPassRush(offenseTeam, defenseTeam, gameState, playCall, rng);
  const qbCtx = modelQBDecisionAndDropback(qb, playCall, rush, rng);
  const sep = modelSeparation(
    offenseTeam,
    defenseTeam,
    target,
    coverageDef,
    playCall,
    rng
  );
  const ballPlacement = modelBallPlacement(qb, playCall, qbCtx, rng);
  const catchOutcome = resolveCatchPoint(
    target,
    coverageDef,
    sep.separationYds,
    ballPlacement.radialError,
    defenseTeam,
    rng
  );

  // If interception, treat as 0 yards for offense; game_engine will flip possession.
  if (catchOutcome.outcome === PlayOutcomeType.INTERCEPTION) {
    return {
      playType: PlayType.PASS,
      outcome: PlayOutcomeType.INTERCEPTION,
      yards: 0,
      airYards: 0,
      yac: 0,
      turnover: TurnoverType.INTERCEPTION,
      timeElapsedSec: DEFAULT_PASS_PLAY_TIME,
      penalty: null,
      debug: {
        rush,
        qbCtx,
        sep,
        ballPlacement,
        catchOutcome,
      },
    };
  }

  // Sack possibility: if pressure extremely fast and underPressure + big error
  let isSack = false;
  let sackYards = 0;
  if (
    qbCtx.underPressure &&
    qbCtx.tPressure < qbCtx.tThrow * 0.8 &&
    ballPlacement.radialError > 3.0 &&
    Math.random() < 0.5 // small global check; you can replace with rng
  ) {
    isSack = true;
    sackYards = Math.round(-Math.abs(rng.normal(5, 3)));
    sackYards = Math.max(-15, sackYards);
  }

  if (isSack) {
    return {
      playType: PlayType.PASS,
      outcome: PlayOutcomeType.SACK,
      yards: sackYards,
      airYards: 0,
      yac: 0,
      turnover: TurnoverType.NONE,
      timeElapsedSec: DEFAULT_PASS_PLAY_TIME,
      penalty: null,
      debug: {
        rush,
        qbCtx,
        sep,
        ballPlacement,
        catchOutcome,
      },
    };
  }

  if (catchOutcome.outcome === PlayOutcomeType.PASS_INCOMPLETE) {
    return {
      playType: PlayType.PASS,
      outcome: PlayOutcomeType.PASS_INCOMPLETE,
      yards: 0,
      airYards: 0,
      yac: 0,
      turnover: TurnoverType.NONE,
      timeElapsedSec: DEFAULT_PASS_PLAY_TIME,
      penalty: null,
      debug: {
        rush,
        qbCtx,
        sep,
        ballPlacement,
        catchOutcome,
      },
    };
  }

  // Completed pass: determine airYards based on depth + separation + error.
  const depth = playCall.depth || PassDepth.INTERMEDIATE;
  let baseAirYds = 0;
  if (depth === PassDepth.SHORT) baseAirYds = rng.normal(4, 3);
  else if (depth === PassDepth.INTERMEDIATE) baseAirYds = rng.normal(10, 4);
  else baseAirYds = rng.normal(18, 6);

  // Very bad ball placement reduces realized air yards.
  baseAirYds -= 0.5 * ballPlacement.radialError;
  baseAirYds += 0.5 * sep.separationYds;

  let airYards = Math.round(Math.max(-5, Math.min(35, baseAirYds)));

  const yacModel = modelYAC(target, defenseTeam, rng);
  const totalYds = airYards + yacModel.yac;

  const fumble = maybeFumble(target, defenseTeam, rng);

  let finalYards = totalYds;
  let outcome = PlayOutcomeType.PASS_COMPLETE;
  let turnover = TurnoverType.NONE;

  if (fumble.isFumble) {
    finalYards += fumble.yardsAfterFumble;
    if (fumble.lost) {
      turnover = TurnoverType.FUMBLE;
      outcome = PlayOutcomeType.FUMBLE_LOST;
    } else {
      outcome = PlayOutcomeType.FUMBLE_OUT_OF_BOUNDS;
    }
  }

  finalYards = Math.round(Math.max(-15, Math.min(80, finalYards)));

  return {
    playType: PlayType.PASS,
    outcome,
    yards: finalYards,
    airYards,
    yac: yacModel.yac,
    turnover,
    timeElapsedSec: DEFAULT_PASS_PLAY_TIME,
    penalty: null,
    debug: {
      rush,
      qbCtx,
      sep,
      ballPlacement,
      catchOutcome,
      yacModel,
      fumble,
    },
  };
}

function simulateRunPlayMicro({
  gameState,
  playCall,
  offenseTeam,
  defenseTeam,
  rngPlay,
}) {
  const rng = rngPlay;
  const rb = getStarter(offenseTeam, "RB") || getStarter(offenseTeam, "FB");

  const yardage = modelRunYardage(
    offenseTeam,
    defenseTeam,
    rb,
    playCall,
    rng
  );

  const fumble = maybeFumble(rb, defenseTeam, rng);

  let finalYards = yardage.yards;
  let outcome = PlayOutcomeType.RUN;
  let turnover = TurnoverType.NONE;

  if (fumble.isFumble) {
    finalYards += fumble.yardsAfterFumble;
    if (fumble.lost) {
      outcome = PlayOutcomeType.FUMBLE_LOST;
      turnover = TurnoverType.FUMBLE;
    } else {
      outcome = PlayOutcomeType.FUMBLE_OUT_OF_BOUNDS;
    }
  }

  finalYards = Math.round(Math.max(-10, Math.min(80, finalYards)));

  return {
    playType: PlayType.RUN,
    outcome,
    yards: finalYards,
    turnover,
    timeElapsedSec: DEFAULT_RUN_PLAY_TIME,
    penalty: null,
    debug: {
      yardage,
      fumble,
    },
  };
}

// -----------------------------------------------------------------------------
// Public: main entrypoint for micro-engine
// -----------------------------------------------------------------------------

/**
 * Simulate a single play at the micro level.
 *
 * Inputs:
 *   - gameState: an object with at least:
 *       {
 *         quarter,
 *         clockSec,
 *         down,
 *         distance,
 *         yardsToEndZone,
 *         fieldPosition, // 0..100 from offense perspective
 *         momentum        // -1..1 (offense positive)
 *       }
 *   - playCall: object describing the call, e.g.:
 *       {
 *         type: "PASS" | "RUN",
 *         depth: PassDepth (for PASS),
 *         direction: RunDirection (for RUN),
 *         concept: "STANDARD" | "PLAY_ACTION" | "SCREEN" | ...,
 *         targetId?: playerId (optional override)
 *       }
 *   - offenseTeam: Team (with roster & unitProfiles)
 *   - defenseTeam: Team
 *   - rngPlay: RNG instance to use for this play
 *
 * Returns a PlayMicroResult:
 *   {
 *     playType,
 *     outcome,
 *     yards,
 *     airYards?,   // for passes
 *     yac?,        // for passes
 *     turnover: TurnoverType,
 *     timeElapsedSec,
 *     penalty: {
 *       hasPenalty,
 *       type,
 *       onOffense,
 *       yards,
 *       automaticFirstDown,
 *       spotFoul,
 *       isPreSnap
 *     } | null,
 *     debug: { ...submodel outputs... }
 *   }
 */
export function simulatePlayMicro({
  gameState,
  playCall,
  offenseTeam,
  defenseTeam,
  rngPlay,
  rngEnv,
}) {
  if (!playCall || !playCall.type) {
    throw new Error("simulatePlayMicro requires playCall.type");
  }

  // 1) Penalty check
  const penalty = maybePenalty(
    offenseTeam,
    defenseTeam,
    gameState,
    playCall.type,
    rngEnv || rngPlay
  );

  if (penalty.hasPenalty && penalty.isPreSnap) {
    // No play actually happens; yardage is just penalty.
    return {
      playType: playCall.type,
      outcome: PlayOutcomeType.PENALTY_ONLY,
      yards: penalty.yards,
      turnover: TurnoverType.NONE,
      timeElapsedSec: 0, // pre-snap
      penalty,
      debug: {
        note: "Pre-snap penalty; no play simulated.",
      },
    };
  }

  // 2) Simulate the core play (pass or run).
  let baseResult;
  if (playCall.type === PlayType.PASS) {
    baseResult = simulatePassPlayMicro({
      gameState,
      playCall,
      offenseTeam,
      defenseTeam,
      rngPlay,
    });
  } else {
    baseResult = simulateRunPlayMicro({
      gameState,
      playCall,
      offenseTeam,
      defenseTeam,
      rngPlay,
    });
  }

  // 3) Attach live-ball penalty if any (post-snap).
  if (penalty.hasPenalty && !penalty.isPreSnap) {
    // Penalty yards stack on top of play result, but direction depends on side.
    const penaltyYards =
      penalty.onOffense ? penalty.yards : -penalty.yards;

    const finalYards = baseResult.yards + penaltyYards;

    return {
      ...baseResult,
      yards: finalYards,
      penalty,
      debug: {
        ...baseResult.debug,
        penaltyApplied: true,
      },
    };
  }

  return {
    ...baseResult,
    penalty: null,
  };
}
