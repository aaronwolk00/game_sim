// micro_engine.js
// -----------------------------------------------------------------------------
// Micro-level engine for NFL-style interactions driven by DNA-style player data.
//
// This module is intentionally self-contained: it does not import anything.
// It expects a RNG object with `.next()` that returns a float in [0,1).
//
// Exports (all pure w.r.t. RNG):
//   - sampleRunOutcome(params, rng)
//   - samplePassOutcome(params, rng)
//   - sampleTackleOutcome(params, rng)
//   - sampleCoverageMatchup(params, rng)
//   - samplePressureTime(params, rng)
//   - samplePenaltyOutcome(params, rng)
//
// The "params" objects are numeric summaries of players/units derived from your
// layer3_rosters.csv (ratings + factor_* + trait_*). The mapping from raw
// Player objects to these params should happen in data_models/game_engine.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }
  
  function logistic(x) {
    return 1 / (1 + Math.exp(-x));
  }
  
  // Box-Muller using provided rng
  function sampleNormal01(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng.next();
    while (v === 0) v = rng.next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    return mag * Math.cos(2 * Math.PI * v);
  }
  
  function sampleNormal(rng, mean = 0, std = 1) {
    return mean + std * sampleNormal01(rng);
  }
  
  // Simple mixture "occasionally big tail" helper
  function sampleWithOccasionalTail(rng, baseMean, baseStd, tailProb, tailBoostMin, tailBoostMax) {
    let v = sampleNormal(rng, baseMean, baseStd);
    if (rng.next() < tailProb) {
      v += tailBoostMin + (tailBoostMax - tailBoostMin) * rng.next();
    }
    return v;
  }
  
  // Scale a rating [0, 100] to a centered value around 0
  function centerRating(rating, pivot = 60) {
    return (rating - pivot) / 10; // 10 rating points ~ 1 "unit"
  }
  
  // -----------------------------------------------------------------------------
  // Coverage / separation micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Sample WR vs DB coverage matchup.
   *
   * @param {Object} params
   *  - wrRouteRating: WR route-craft rating (0-100)
   *  - wrReleaseRating: WR release vs press (0-100)
   *  - wrSpeedRating: WR speed/deep threat (0-100)
   *  - dbManRating: DB man coverage (0-100)
   *  - dbZoneRating: DB zone coverage (0-100)
   *  - dbPressRating: DB press ability (0-100)
   *  - dbSpeedRating: DB speed/range (0-100)
   *  - coverageType: 'man' | 'zone' | 'mixed'
   *  - leverage: -1 (inside) | 0 (balanced) | 1 (outside)
   *  - targetDepth: yards downfield (e.g. 5/10/20)
   *
   * @returns {Object}
   *  - separation: separation at catch point in yards (positive = WR open)
   *  - contestFactor: 0..1, 0=open window, 1=tightly contested
   *  - dbBeatenClean: boolean
   */
  export function sampleCoverageMatchup(params, rng) {
    const {
      wrRouteRating = 60,
      wrReleaseRating = 60,
      wrSpeedRating = 60,
      dbManRating = 60,
      dbZoneRating = 60,
      dbPressRating = 60,
      dbSpeedRating = 60,
      coverageType = 'mixed',
      leverage = 0,
      targetDepth = 10,
    } = params || {};
  
    // Effective coverage rating given the call
    let dbCoverageEff;
    switch (coverageType) {
      case 'man':
        dbCoverageEff = (dbManRating * 0.7 + dbPressRating * 0.3);
        break;
      case 'zone':
        dbCoverageEff = (dbZoneRating * 0.7 + dbSpeedRating * 0.3);
        break;
      default: // mixed
        dbCoverageEff = (dbManRating * 0.4 + dbZoneRating * 0.4 + dbSpeedRating * 0.2);
        break;
    }
  
    const routeCraft = wrRouteRating;
    const release = wrReleaseRating;
    const speedDelta = wrSpeedRating - dbSpeedRating;
  
    const leverageBonus =
      leverage > 0
        ? 0.1 // WR has outside leverage for typical sideline routes
        : leverage < 0
        ? -0.1
        : 0;
  
    // Separation mean in yards
    const ratingDelta = (routeCraft * 0.6 + release * 0.4) - dbCoverageEff;
    const depthFactor = clamp(targetDepth / 15, 0.6, 1.6); // deeper route -> more spread
    const meanSep = (ratingDelta / 20) * depthFactor + leverageBonus; // ~ +/- 1.5 yards typical
    const stdSep = 0.7 * depthFactor + 0.2 * Math.abs(speedDelta) / 30;
  
    let separation = sampleNormal(rng, meanSep, stdSep);
    separation = clamp(separation, -3.5, 4.0);
  
    // contestFactor: near 0 if >2.5 yards open, near 1 if glued
    const contestFactor = clamp(1 - (separation + 3.5) / (4.0 + 3.5), 0, 1);
  
    const dbBeatenClean = separation > 2.0;
  
    return {
      separation,
      contestFactor,
      dbBeatenClean,
    };
  }
  
  // -----------------------------------------------------------------------------
  // Pressure / time-to-throw micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Sample time to pressure for a pass play.
   *
   * @param {Object} params
   *  - olPassBlockRating: OL unit pass block (0-100)
   *  - dlPassRushRating: front/edge pass rush (0-100)
   *  - qbPocketMovementRating: QB pocket nav (0-100)
   *  - qbSackAvoidanceRating: QB sack avoidance / processing (0-100)
   *  - situationalAggression: 0..1, higher means more attackers (blitz/etc.)
   *
   * @returns {Object}
   *  - timeToPressure: seconds until significant pressure
   *  - cleanDrop: boolean (true if >3.0s)
   */
  export function samplePressureTime(params, rng) {
    const {
      olPassBlockRating = 60,
      dlPassRushRating = 60,
      qbPocketMovementRating = 60,
      qbSackAvoidanceRating = 60,
      situationalAggression = 0.5,
    } = params || {};
  
    // Effective OL vs DL differential
    const passBlockScore = olPassBlockRating * 0.7 + qbPocketMovementRating * 0.3;
    const rushScore = dlPassRushRating * 0.7 + (50 + 50 * situationalAggression) * 0.3;
    const qbSave = qbSackAvoidanceRating;
  
    const delta = (passBlockScore + qbSave * 0.4) - rushScore;
  
    // Map delta to base time to pressure
    // ~2.2s for even, ~3.2s if OL dominates, ~1.5s if rush dominates
    const baseTime = 2.2 + clamp(delta / 30, -0.7, 1.0);
  
    const stdTime = 0.35 + 0.15 * Math.abs(delta) / 25;
  
    let timeToPressure = sampleWithOccasionalTail(
      rng,
      baseTime,
      stdTime,
      0.07, // occasionally hold up forever / instant win
      -0.7,
      1.2
    );
  
    timeToPressure = clamp(timeToPressure, 0.7, 5.0);
  
    return {
      timeToPressure,
      cleanDrop: timeToPressure >= 3.0,
    };
  }
  
  // -----------------------------------------------------------------------------
  // Catch point / ball skills micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Compute catch vs incompletion vs interception at catch point.
   *
   * @param {Object} params
   *  - separation: yards (output of sampleCoverageMatchup)
   *  - ballPlacementStd: positional error in yards (0.3-3.0)
   *  - wrHands: WR hands rating (0-100)
   *  - wrContestedCatch: WR contested catch skill (0-100)
   *  - dbBallSkills: DB ball skills rating (0-100)
   *  - throwAggressiveness: 0..1 (higher = more throws into tight windows)
   *
   * @returns {Object}
   *  - pCatch, pIncomp, pInt (sum ~1)
   */
   export function sampleCatchPointOutcome(params, rng) {
    const {
      separation = 0,
      ballPlacementStd = 1.0,
      wrHands = 60,
      wrContestedCatch = 60,
      dbBallSkills = 60,
      throwAggressiveness = 0.5,
    } = params || {};
  
    const sepClamped = clamp(separation, -3, 4);
    const windowTightness = clamp(1.5 - sepClamped, 0.1, 2.5);
    const placementPenalty = clamp((ballPlacementStd - 1.0) / 1.5, -0.4, 0.8);
  
    const wrSoftHands = centerRating(wrHands, 65);
    const wrCT = centerRating(wrContestedCatch, 65);
    const dbBS = centerRating(dbBallSkills, 65);
  
    // Slightly toned-down open bonus, harsher tight-window penalty
    const openBonus =
      sepClamped > 1.5 ? 0.5 :
      sepClamped > 0.5 ? 0.22 :
      0;
  
    const tightPenalty = sepClamped < 0 ? -0.55 * windowTightness : 0;
  
    const catchScore =
      0.4 * wrSoftHands +
      0.3 * wrCT -
      0.4 * dbBS -
      0.5 * placementPenalty +
      openBonus +
      tightPenalty;
  
    let pCatch = logistic(catchScore);
  
    // Interception probability grows with tightness and DB skill
    const baseInt = 0.02 + 0.04 * windowTightness * logistic(dbBS / 1.2);
    const aggFactor = 0.5 + throwAggressiveness * 1.2;
    let pInt = clamp(baseInt * aggFactor, 0.001, 0.30);
  
    // If WR is much better than DB / lots of separation, suppress INT
    if (sepClamped > 1.5 && wrCT > dbBS + 0.5) {
      pInt *= 0.4;
    }
  
    // Normalize to 1
    let pIncomp = 1 - pCatch - pInt;
    if (pIncomp < 0) {
      const total = pCatch + pInt;
      pCatch /= total;
      pInt /= total;
      pIncomp = 0;
    }
  
    return { pCatch, pIncomp, pInt };
  }
  
  
  // -----------------------------------------------------------------------------
  // YAC / tackling micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Sample tackle outcome + YAC given ball carrier and tackler profiles.
   *
   * @param {Object} params
   *  - carrierPower: ball-carrier power/functional strength (0-100)
   *  - carrierElusiveness: elusiveness / short-area quickness (0-100)
   *  - carrierBalance: balance / contact balance (0-100)
   *  - carrierSpeed: long-speed (0-100)
   *  - tacklerTackling: form tackling / strength (0-100)
   *  - tacklerPursuit: pursuit angles (0-100)
   *  - tacklerAgility: COD / ability to mirror (0-100)
   *  - numDefendersInvolved: integer
   *  - sidelineFactor: 0..1 (1 = near sideline, easier to force OOB)
   *  - openFieldFactor: 0..1 (1 = truly open field)
   *
   * @returns {Object}
   *  - yac: yards after contact (>= 0)
   *  - brokenTackles: count
   *  - forcedMiss: boolean
   */
   export function sampleTackleOutcome(params, rng) {
    const {
      carrierPower = 60,
      carrierElusiveness = 60,
      carrierBalance = 60,
      carrierSpeed = 60,
      tacklerTackling = 60,
      tacklerPursuit = 60,
      tacklerAgility = 60,
      numDefendersInvolved = 1,
      sidelineFactor = 0.3,
      openFieldFactor = 0.5,
    } = params || {};
  
    const ballSkill =
      carrierPower * 0.35 +
      carrierElusiveness * 0.35 +
      carrierBalance * 0.2 +
      carrierSpeed * 0.1;
  
    const tackleSkill =
      tacklerTackling * 0.5 +
      tacklerPursuit * 0.3 +
      tacklerAgility * 0.2;
  
    // More defenders = scale up tackleSkill
    const multiplier = 1 + 0.25 * (numDefendersInvolved - 1);
    const effTackle = tackleSkill * multiplier;
  
    const delta = (ballSkill - effTackle) / 15;
  
    // Base YAC mean – slightly toned down
    const openFieldBonus = 1.6 * openFieldFactor - 0.8; // -0.8..+0.8
    const sidelinePenalty = sidelineFactor * 0.9;
    const meanYAC = 1.6 + 1.0 * delta + openFieldBonus - sidelinePenalty;
    const stdYAC = 1.0 + 0.5 * Math.abs(delta);
  
    let rawYAC = sampleWithOccasionalTail(
      rng,
      meanYAC,
      stdYAC,
      0.06, // was 0.12 – cut big tails in half
      3,
      12   // was 20 – fewer truly massive YACs
    );
  
    // Hard-cap YAC to avoid outliers dominating scoring
    rawYAC = Math.min(25, Math.max(0, rawYAC));
  
    // Break-tackle probability
    const baseMiss = logistic(delta); // ~0.5 when even
    const forcedMissProb = clamp(
      baseMiss * (0.4 + 0.6 * openFieldFactor),
      0.05,
      0.7
    );
    const forcedMiss = rng.next() < forcedMissProb;
  
    let brokenTackles = 0;
    if (forcedMiss) brokenTackles += 1;
    if (rawYAC > 10 && rng.next() < 0.3) brokenTackles += 1;
  
    return {
      yac: rawYAC,
      brokenTackles,
      forcedMiss,
    };
  }
  
  
  // -----------------------------------------------------------------------------
  // Run play micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Sample run play outcome at micro level.
   *
   * @param {Object} params
   *  - olRunBlockRating: OL run-block rating (0-100)
   *  - rbVisionRating: RB vision (inside/screen/cutback composite) (0-100)
   *  - rbPowerRating: RB power/functional_strength_run (0-100)
   *  - rbElusivenessRating: RB elusiveness/short-area quickness (0-100)
   *  - frontRunDefRating: DL/LB run defense (0-100)
   *  - boxCount: number of defenders in box
   *  - boxLightness: -1 (heavy box) .. +1 (light box)
   *  - yardline: 0..100
   *  - down: 1..4
   *  - distance: yards to go
   *
   * @returns {Object}
   *  - yardsGained
   *  - timeToLine: seconds to LOS
   *  - timeElapsed: total play time
   *  - fumble: boolean
   */
  export function sampleRunOutcome(params, rng) {
    const {
      olRunBlockRating = 60,
      rbVisionRating = 60,
      rbPowerRating = 60,
      rbElusivenessRating = 60,
      frontRunDefRating = 60,
      boxCount = 7,
      boxLightness = 0,
      yardline = 25,
      down = 1,
      distance = 10,
    } = params || {};
  
    const runBlock = olRunBlockRating;
    const rbSkill = rbVisionRating * 0.5 + rbPowerRating * 0.25 + rbElusivenessRating * 0.25;
    const defRun = frontRunDefRating;
  
    const baseBox = 7;
    const boxDelta = boxCount - baseBox; // +2 heavy, -1 light
    const boxPenalty = -0.7 * boxDelta + 1.0 * boxLightness;
  
    const ratingDelta = (runBlock + rbSkill - defRun * 1.1) / 20;
  
    // Expected yards before contact
    const beforeContactMean = 1.8 + 1.0 * ratingDelta + boxPenalty * 0.4;
    const beforeContactStd = 1.0 + 0.3 * Math.abs(ratingDelta);
  
    let yardsBeforeContact = sampleNormal(rng, beforeContactMean, beforeContactStd);
    yardsBeforeContact = clamp(yardsBeforeContact, -4, 8);
  
    // Tackle / YAC micro-model
    const tackleParams = {
      carrierPower: rbPowerRating,
      carrierElusiveness: rbElusivenessRating,
      carrierBalance: (rbPowerRating + rbElusivenessRating) / 2,
      carrierSpeed: rbVisionRating, // crude placeholder
      tacklerTackling: defRun,
      tacklerPursuit: defRun,
      tacklerAgility: defRun,
      numDefendersInvolved: boxCount >= 7 ? 2 : 1,
      sidelineFactor: clamp((yardline < 10 || yardline > 90) ? 0.7 : 0.2, 0, 1),
      openFieldFactor: clamp(1 - boxCount / 8, 0.2, 0.9),
    };
  
    const tackleOutcome = sampleTackleOutcome(tackleParams, rng);
  
    let totalYards = yardsBeforeContact + tackleOutcome.yac;
  
    // Short-yardage boost: on 3rd/4th & short, RBs sell out
    if (distance <= 2 && down >= 3) {
      totalYards += 0.5 * centerRating(rbPowerRating, 65);
    }
  
    // Goal-line squeezing
    if (yardline > 90) {
      totalYards -= (yardline - 90) * 0.2;
    }
  
    totalYards = Math.round(totalYards);
  
    // Fumble probability: use ball security conceptually; here use rbVision as a proxy if not passed
    const ballSecurityRating = rbVisionRating; // you can sub rating_RB_ball_security here
    const ballSecurityCentered = centerRating(ballSecurityRating, 65);
    const baseFumble = 0.012;
    let fumbleProb = baseFumble * (1.2 - 0.2 * tackledInTraffic(boxCount));
    fumbleProb *= 1 - 0.15 * ballSecurityCentered;
    fumbleProb = clamp(fumbleProb, 0.003, 0.05);
    const fumble = rng.next() < fumbleProb;
  
    const timeToLine = clamp(0.6 + 0.1 * (70 - rbElusivenessRating) / 10, 0.4, 1.0);
    const timeElapsed = timeToLine + 1.0 + Math.abs(totalYards) * 0.1;
  
    return {
      yardsGained: totalYards,
      timeToLine,
      timeElapsed,
      fumble,
      tackleOutcome,
    };
  }
  
  function tackledInTraffic(boxCount) {
    return boxCount >= 7 ? 1 : boxCount >= 6 ? 0.6 : 0.3;
  }
  
  // -----------------------------------------------------------------------------
  // Pass play micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Sample pass play outcome at micro level.
   *
   * This function glues together:
   *  - pressure time
   *  - coverage/separation
   *  - ball placement
   *  - catch point resolution
   *  - YAC
   *  - interception/sack/fumble flags
   *
   * @param {Object} params
   *  - qbAccuracyRating
   *  - qbProcessingRating
   *  - qbUnderPressureRating
   *  - olPassBlockRating
   *  - dlPassRushRating
   *  - wrRouteRating
   *  - wrReleaseRating
   *  - wrSpeedRating
   *  - wrHandsRating
   *  - wrContestedCatchRating
   *  - dbManRating
   *  - dbZoneRating
   *  - dbPressRating
   *  - dbSpeedRating
   *  - dbBallSkillsRating
   *  - yardline
   *  - down
   *  - distance
   *  - coverageType: 'man' | 'zone' | 'mixed'
   *  - situationalAggression: 0..1
   *  - throwAggressiveness: 0..1
   *
   * @returns {Object}
   *  - yardsGained
   *  - timeToThrow
   *  - timeElapsed
   *  - completion: boolean
   *  - interception: boolean
   *  - sack: boolean
   *  - fumble: boolean (strip sack etc.)
   */
  export function samplePassOutcome(params, rng) {
    const {
      qbAccuracyRating = 60,
      qbProcessingRating = 60,
      qbUnderPressureRating = 60,
      olPassBlockRating = 60,
      dlPassRushRating = 60,
      wrRouteRating = 60,
      wrReleaseRating = 60,
      wrSpeedRating = 60,
      wrHandsRating = 60,
      wrContestedCatchRating = 60,
      dbManRating = 60,
      dbZoneRating = 60,
      dbPressRating = 60,
      dbSpeedRating = 60,
      dbBallSkillsRating = 60,
      yardline = 25,
      down = 1,
      distance = 10,
      coverageType = 'mixed',
      situationalAggression = 0.5,
      throwAggressiveness = 0.5,
    } = params || {};
  
    // 1. Time to pressure
    const pressure = samplePressureTime(
      {
        olPassBlockRating,
        dlPassRushRating,
        qbPocketMovementRating: qbUnderPressureRating,
        qbSackAvoidanceRating: qbProcessingRating,
        situationalAggression,
      },
      rng
    );
  
    // 2. Decide target depth (very simplified: based on distance/down)
    const targetDepth = chooseTargetDepth(distance, down, throwAggressiveness, rng);
  
    // 3. Coverage / separation
    const coverage = sampleCoverageMatchup(
      {
        wrRouteRating,
        wrReleaseRating,
        wrSpeedRating,
        dbManRating,
        dbZoneRating,
        dbPressRating,
        dbSpeedRating,
        coverageType,
        leverage: 0,
        targetDepth,
      },
      rng
    );
  
    // 4. Decide if pressure forces early throw or sack
    const intendedTT = baseTimeToThrow(qbProcessingRating, targetDepth, throwAggressiveness);
    let timeToThrow = intendedTT;
  
    let sack = false;
    if (pressure.timeToPressure < intendedTT) {
      // Under heavy pressure before intended release
      const saveProb = clamp(
        logistic((qbUnderPressureRating - dlPassRushRating) / 15),
        0.15,
        0.85
      );
      if (rng.next() > saveProb) {
        // Sack
        sack = true;
        timeToThrow = pressure.timeToPressure;
      } else {
        // QB forced to hurry throw: increase ball-placement variance
        timeToThrow = pressure.timeToPressure + 0.05; // just getting it out
      }
    }
  
    if (sack) {
      const sackYards = -Math.round(5 + (rng.next() * 5));
      const timeElapsed = timeToThrow + 0.4;
      // Strip-sack chance
      const stripProb = clamp(0.02 + 0.01 * centerRating(dlPassRushRating), 0.01, 0.12);
      const fumble = rng.next() < stripProb;
  
      return {
        yardsGained: sackYards,
        timeToThrow,
        timeElapsed,
        completion: false,
        interception: false,
        sack: true,
        fumble,
      };
    }
  
    // 5. Ball placement variance (depends on accuracy and pressure)
    const accCentered = centerRating(qbAccuracyRating, 70);
    const pressurePenalty = clamp(
      (pressure.timeToPressure - timeToThrow) / 2,
      -0.6,
      0.5
    ); // <0 => rushed / under pressure
    const baseStd = 1.1 - 0.25 * accCentered + 0.8 * Math.max(-pressurePenalty, 0);
    const ballPlacementStd = clamp(baseStd, 0.4, 3.0);
  
    // 6. Catch point resolution
    const catchOutcome = sampleCatchPointOutcome(
      {
        separation: coverage.separation,
        ballPlacementStd,
        wrHands: wrHandsRating,
        wrContestedCatch: wrContestedCatchRating,
        dbBallSkills: dbBallSkillsRating,
        throwAggressiveness,
      },
      rng
    );
  
    const roll = rng.next();
    let completion = false;
    let interception = false;
  
    if (roll < catchOutcome.pCatch) {
      completion = true;
    } else if (roll < catchOutcome.pCatch + catchOutcome.pInt) {
      interception = true;
    }
  
    // 7. Yards gained
    let yardsGained = 0;
    let timeAfterCatch = 0.0;
  
    if (completion) {
        // Air yards ~ target depth +/- noise
        const airYards = clamp(
          Math.round(sampleNormal(rng, targetDepth, 2.0)),
          0,
          60
        );
      
        // YAC using tackle model
        const yacOutcome = sampleTackleOutcome(
          {
            carrierPower: wrContestedCatchRating, // as a stand-in
            carrierElusiveness: wrSpeedRating,
            carrierBalance: (wrHandsRating + wrContestedCatchRating) / 2,
            carrierSpeed: wrSpeedRating,
            tacklerTackling: dbManRating,
            tacklerPursuit: dbZoneRating,
            tacklerAgility: dbSpeedRating,
            numDefendersInvolved: coverage.dbBeatenClean ? 1 : 2,
            sidelineFactor: clamp(yardsToSidelineFactor(yardline), 0, 1),
            openFieldFactor: coverage.separation > 1.5 ? 0.8 : 0.4,
          },
          rng
        );
      
        yardsGained = Math.round(airYards + yacOutcome.yac);
      
        // Time after catch: flatter slope + cap
        const yacTimeComponent = 0.06 * Math.max(0, yardsGained); // was 0.1
        timeAfterCatch = 1.0 + yacTimeComponent;
        timeAfterCatch = Math.min(timeAfterCatch, 6.0);
    } else if (interception) {
      // Small swing in yardage around LOS (return modeled by macro-level for now)
      yardsGained = Math.round(sampleNormal(rng, -2, 6));
    } else {
      // Incompletion
      yardsGained = 0;
    }
  
    const timeElapsed = timeToThrow + (completion ? timeAfterCatch : 0.4);
  
    // Interception fumble extremely rare; we ignore for now.
    const fumble = false;
  
    return {
      yardsGained,
      timeToThrow,
      timeElapsed,
      completion,
      interception,
      sack: false,
      fumble,
    };
  }
  
  function baseTimeToThrow(qbProcessingRating, targetDepth, aggressiveness) {
    const procCentered = centerRating(qbProcessingRating, 65);
    const depthFactor = clamp(targetDepth / 10, 0.7, 1.6);
    const base = 2.2 * depthFactor - 0.15 * procCentered - 0.25 * aggressiveness;
    return clamp(base, 1.5, 4.2);
  }
  
  function chooseTargetDepth(distance, down, aggressiveness, rng) {
    const shortBias = distance <= 3 ? 0.7 : distance <= 6 ? 0.5 : 0.3;
    const deepBias = aggressiveness * 0.5 + (down === 3 ? 0.2 : 0);
  
    const r = rng.next();
    if (r < shortBias) return 5 + 2 * rng.next(); // short
    if (r < shortBias + deepBias) return 18 + 6 * rng.next(); // deep
    return 10 + 4 * rng.next(); // intermediate
  }
  
  function yardsToSidelineFactor(yardline) {
    // Yardline in 0..100, assume ball is on hash; crude: more extreme near 0 or 100
    const distToGoal = Math.min(yardline, 100 - yardline);
    return clamp((10 - distToGoal) / 10, 0, 1);
  }
  
  // -----------------------------------------------------------------------------
  // Penalty micro-model
  // -----------------------------------------------------------------------------
  
  /**
   * Sample whether a penalty occurs and on which side.
   *
   * @param {Object} params
   *  - offenseDisciplineRating: higher -> fewer penalties (0-100)
   *  - defenseDisciplineRating: higher -> fewer penalties (0-100)
   *  - aggressionRatingOff: offensive aggression (0-100)
   *  - aggressionRatingDef: defensive aggression (0-100)
   *  - playType: 'run' | 'pass' | 'kick' | 'punt'
   *
   * @returns {Object}
   *  - hasPenalty: boolean
   *  - onOffense: boolean | null
   *  - yards: penalty yards (positive against offense, negative against defense)
   *  - type: string | null
   */
  export function samplePenaltyOutcome(params, rng) {
    const {
      offenseDisciplineRating = 60,
      defenseDisciplineRating = 60,
      aggressionRatingOff = 60,
      aggressionRatingDef = 60,
      playType = 'pass',
    } = params || {};
  
    const baseRate =
      playType === 'kick' || playType === 'punt'
        ? 0.22
        : playType === 'run'
        ? 0.13
        : 0.17;
  
    const offDiscCentered = centerRating(offenseDisciplineRating, 65);
    const defDiscCentered = centerRating(defenseDisciplineRating, 65);
    const offAggCentered = centerRating(aggressionRatingOff, 55);
    const defAggCentered = centerRating(aggressionRatingDef, 65);
  
    const offProb = clamp(
      baseRate * (1 + 0.4 * (-offDiscCentered) + 0.25 * offAggCentered),
      0.03,
      0.25
    );
    const defProb = clamp(
      baseRate * (1 + 0.4 * (-defDiscCentered) + 0.35 * defAggCentered),
      0.03,
      0.30
    );
  
    const totalProb = offProb + defProb;
    const hasPenalty = rng.next() < totalProb;
    if (!hasPenalty) {
      return {
        hasPenalty: false,
        onOffense: null,
        yards: 0,
        type: null,
      };
    }
  
    const rollSide = rng.next();
    const onOffense = rollSide < offProb / totalProb;
  
    // Choose penalty type & yards
    // Very simplified: mostly 5 or 10, rare 15
    const r = rng.next();
    let yards;
    let type;
    if (r < 0.5) {
      yards = 5;
      type = onOffense ? 'false_start_or_illegal' : 'offsides';
    } else if (r < 0.92) {
      yards = 10;
      type = onOffense ? 'holding' : 'defensive_holding';
    } else {
      yards = 15;
      type = onOffense ? 'personal_foul_off' : 'personal_foul_def';
    }
  
    // For defense, we make yards negative so macro layer can apply direction
    const signedYards = onOffense ? -yards : yards;
  
    return {
      hasPenalty: true,
      onOffense,
      yards: signedYards,
      type,
    };
  }
  