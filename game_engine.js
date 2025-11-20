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
  
    // Micro layer (kept)
    baseRunMean: 3.0,
    baseRunStd: 2.5,
    basePassMean: 5.0,
    basePassStd: 5.0,
    sackMeanLoss: -6,
    turnoverBaseProb: 0.025,
  
    // FG (kept but unused by new FG model)
    fgBaseProb: 0.82,          // unused now
    fgAccuracyWeight: 0.0025,  // unused now
  
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
    betweenPlayNormalMin: 28,
    betweenPlayNormalMax: 40,
    betweenPlayHurryMin: 6,
    betweenPlayHurryMax: 15,
    oobRestartMin: 4,
    oobRestartMax: 8,
  
    // First play after a quarter break
    quarterBreakSetupExtra: 6,
  
    // ---- NEW: League targeting & team tilt (for YPC/YPA and punts/game) ----
    targetYPC: 4.4,           // league yards/rush you want the sim to hover around
    targetYPA: 7.3,           // league yards/pass (incl. incompletions)
    runScaleGlobal: 1.08,     // gentle global nudge; tune after a 1k-game run
    passScaleGlobal: 1.15,    // gentle global nudge; tune after a 1k-game run
  
    useRealBaselines: false,  // flip to true when you pass per-team tables
    realBaselines: null,      // shape: { [teamName|id]: { ypc, ypa, punts, tb } }
  
    puntBaselinePerTeam: 3.6, // league-ish per-team punts/game target
  
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
  
  // Team-specific kickoff touchback rate
  function getKickoffTouchbackRate(state, kickingTeam) {
    const { cfg } = state;
    const baseLeague = Number.isFinite(cfg.kickoffTouchbackLeagueAvg) ? cfg.kickoffTouchbackLeagueAvg : 0.65;
  
    const teamB = getTeamBaseline(cfg, kickingTeam);
    const teamTB = Number.isFinite(teamB?.tb) ? teamB.tb : null;
  
    const kPow = (getUnitProfiles(kickingTeam).special?.kicking?.power ?? 60);
    const powerAdj = (kPow - 60) * 0.004; // ±0.16 tops (40–100), typically smaller
  
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
  
    const te1 = teList[0] || null;
  
    return { qb, rb1, rb2, wr1, wr2, wr3, te1 };
  }
  
  // Choose a receiving target from skill group
  function chooseReceivingTarget(skill, rng) {
    const candidates = [];
  
    // Slightly favor WR1/WR2, then slot/TE, then RB checkdown
    if (skill.wr1) candidates.push({ p: skill.wr1, w: 3 });
    if (skill.wr2) candidates.push({ p: skill.wr2, w: 3 });
    if (skill.wr3) candidates.push({ p: skill.wr3, w: 2 });
    if (skill.te1) candidates.push({ p: skill.te1, w: 2 });
    if (skill.rb1) candidates.push({ p: skill.rb1, w: 1 });
  
    if (!candidates.length) return null;
  
    const totalW = candidates.reduce((s, c) => s + c.w, 0);
    let r = rng.nextRange(0, totalW);
    for (const c of candidates) {
      if (r < c.w) return c.p;
      r -= c.w;
    }
    return candidates[0].p;
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
    let resultText = "Turnover on downs";
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
 * PAT is an **untimed** down — we do NOT change state.clockSec.
 * Assumes the TD points (6) have already been added.
 */
 function handlePAT(state, scoringSide) {
    const rng = state.rng;
    const cfg = state.cfg || {};
  
    const xpMakeProb    = Number.isFinite(cfg.xpMakeProb)    ? cfg.xpMakeProb    : 0.94;
    const twoPtMakeProb = Number.isFinite(cfg.twoPtMakeProb) ? cfg.twoPtMakeProb : 0.48;
  
    // Score diff from offense perspective *after* TD already applied
    const offenseScore =
        scoringSide === "home" ? state.score.home : state.score.away;
    const defenseScore =
        scoringSide === "home" ? state.score.away : state.score.home;

    // Timeouts for the half in progress
    const halfKey = state.quarter <= 2 ? "H1" : "H2";
    const offenseTimeouts = state.timeouts?.[scoringSide]?.[halfKey] ?? 0;
    const defenseTimeouts = state.timeouts?.[defenseSide]?.[halfKey] ?? 0;

    // Optional team slider
    const tryForTwoAggression =
        (scoringSide === "home" ? state.homeTeam : state.awayTeam)?.tendencies?.twoPoint ?? 0;

    // Final decision (uses your helper)
    const attemptTwo = shouldAttemptTwo({
        offenseScore,
        defenseScore,
        quarter: state.quarter,
        secondsLeft: state.clockSec,
        offenseTimeouts,
        defenseTimeouts,
        tryForTwoAggression,
    });

  
    // Identify kicker (for XP stats / PBP)
    const kicker =
      scoringSide === "home" ? state.homeKicker : state.awayKicker;
    const kickerRow = kicker ? ensurePlayerRow(state, kicker, scoringSide) : null;
    const kickerId   = getPlayerKey(kicker);
    const kickerName = getPlayerName(kicker);
  
    let made = false;
    let desc = "";
  
    if (attemptTwo) {
      // 2-point conversion
      made = rng.next() < twoPtMakeProb;
      if (made) {
        if (scoringSide === "home") state.score.home += 2;
        else                        state.score.away += 2;
        desc = "two-point try is good";
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
        desc = "two-point try fails";
      }
    } else {
      // Extra point (kick)
      made = rng.next() < xpMakeProb;
  
      // Kicker stats
      if (kickerRow) {
        kickerRow.xpAtt += 1;
        if (made) kickerRow.xpMade += 1;
      }
  
      if (made) {
        if (scoringSide === "home") state.score.home += 1;
        else                        state.score.away += 1;
        desc = "extra point is good";
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
        desc = "extra point is no good";
      }
    }
  
    const offenseTeam = scoringSide === "home" ? state.homeTeam : state.awayTeam;
    const defenseSide = scoringSide === "home" ? "away" : "home";
    const defenseTeam = scoringSide === "home" ? state.awayTeam : state.homeTeam;
  
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
      turnover: false,
      touchdown: false,
      safety: false,
      fieldGoalAttempt: false,
      fieldGoalGood: false,
      punt: false,
      endOfDrive: false,
  
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
  
  // game_engine.js
  export function victoryFormationAvailable({
    quarter, secondsLeft, offenseLead, timeoutsDefense, playClock = 40
  }) {
    if (quarter !== 4 || offenseLead <= 0) return false;
  
    // How many kneels needed? First takes 5s, subsequent ~7s (spot + wind).
    // Simple conservative estimate: assume each kneel burns ~38s if defense has no TOs
    // but only ~5–7s if they do have TOs.
    if (timeoutsDefense === 0) {
      return secondsLeft <= playClock + 2; // one kneel drains it
    }
    if (timeoutsDefense === 1) {
      return secondsLeft <= playClock + 10 + 8; // kneel, TO, kneel sequence
    }
    if (timeoutsDefense === 2) {
      return secondsLeft <= playClock + 10 + 8 + 8;
    }
    // With all 3 TOs, you usually need 4 snaps; keep it conservative:
    return secondsLeft <= playClock + 10 + 8 + 8 + 8;
  }
  
  // In your play-caller:
  const canKneel = victoryFormationAvailable({
    quarter: state.quarter,
    secondsLeft: state.clock.seconds,
    offenseLead: state.offenseScore - state.defenseScore,
    timeoutsDefense: state.timeouts.defense,
    playClock: 40
  });
  
  if (canKneel) {
    call = 'KNEEL';
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
    const logClock = (displayClockSec != null) ? displayClockSec : state.clockSec;
  
    const log = {
      playId: state.playId++,
      driveId: state.driveId, // current drive (e.g., new drive for kickoff)
      quarter: state.quarter,
      clockSec: logClock,
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

  function updateClockIntent(state) {
    const { offenseSide } = getOffenseDefense(state);
    const ci = state.clockIntent[offenseSide];
  
    // Reset to defaults each snap
    ci.forceSpike = false;
    ci.forceKneel = false;
    ci.boundsPreference = "normal";
  
    const q = state.quarter;
    const t = state.clockSec;
    const diff =
      offenseSide === "home"
        ? state.score.home - state.score.away
        : state.score.away - state.score.home;
    const m = clamp(state.momentum?.[offenseSide] ?? 0, -1, 1);
  
    const isEndOfHalf = (q === 2 || q === 4);
  
    // ---------------- End-of-game: kneel to burn clock ----------------
    if (q === 4 && diff > 0 && t <= 90) {
      // Simple "safe lead" heuristic:
      // - up 2+ scores any time under 1:30
      // - OR up by any amount under ~40s
      const safeLead =
        diff >= 9 || (diff >= 1 && t <= 40);
  
      if (safeLead && state.down >= 1 && state.down <= 4) {
        ci.forceKneel = true;
        ci.boundsPreference = "middle"; // keep the ball in bounds
        return;
      }
    }
  
    // ---------------- Two-minute drill / sideline preference ----------------
    if (isEndOfHalf && diff <= 0 && t <= 120) {
      // Trailing or tied late: prefer sideline to stop clock
      ci.boundsPreference = "sideline";
    }
  
    // ---------------- Spike to stop clock ----------------
    // Use when behind/tied, low time, not on 4th down
    if (isEndOfHalf && diff <= 0 && t <= 30 && t >= 8 && state.down <= 3) {
      // Base spike probability depending on urgency
      const urgency = (30 - t) / 30; // 0..1
      let prob = 0.45 + 0.35 * urgency; // ~0.45 → ~0.8
      // Slight tilt: hot offense a bit more decisive
      prob += 0.05 * m;
      prob = clamp(prob, 0.30, 0.90);
  
      if (state.rng.next() < prob) {
        ci.forceSpike = true;
      }
    }
  }
  
  
  
  

// Play simulation
function simulatePlay(state) {
    const { rng } = state;
    updateClockIntent(state);
    const {
      offenseTeam,
      defenseTeam,
      offenseSide,
      defenseSide,
    } = getOffenseDefense(state);
  
    const offenseUnits = getUnitProfiles(offenseTeam).offense;
    const defenseUnits = getUnitProfiles(defenseTeam).defense;
    const specialOff  = getUnitProfiles(offenseTeam).special;
  
    // ⬇️ ADD THIS: compute puntBias from team tilt
    const puntBias = computePuntBias(state, offenseTeam);
  
    // Snapshot of state *before* the play for logging
    const preState = {
      down: state.down,
      distance: state.distance,
      yardline: state.ballYardline,
      clockSec: state.clockSec,
      quarter: state.quarter,
    };
  
    // Timeouts for current half
    const halfKey = state.quarter <= 2 ? "H1" : "H2";
    const timeoutsOffense = state.timeouts?.[offenseSide]?.[halfKey] ?? 0;
    const timeoutsDefense = state.timeouts?.[defenseSide]?.[halfKey] ?? 0;

    // Victory formation: kneel if mathematically able to kill the game
    const offenseScore =
        offenseSide === "home" ? state.score.home : state.score.away;
    const defenseScore =
        offenseSide === "home" ? state.score.away : state.score.home;

    if (
        victoryFormationAvailable({
        quarter: state.quarter,
        secondsLeft: state.clockSec,
        offenseLead: offenseScore - defenseScore,
        timeoutsDefense,
        playClock: 40,
        })
    ) {
        const decision = { type: "kneel" };
        const playOutcome = simulateKneel(state, rng);
        applyPlayOutcomeToState(state, playOutcome, preState);
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

    // (REPLACE your old situation object with this one so timeouts are included)
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
        puntBias,
        offMomentum: state.momentum?.[offenseSide] ?? 0,
        timeoutsOffense,
        timeoutsDefense,
        clockIntent: state.clockIntent[offenseSide] || null,
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
      defenseTeam
    );
    state.plays.push(playLog);
  
    return playLog;
  }
  

  

// Choose between run / pass / FG / punt with improved 4th-down logic
function choosePlayType(situation, offenseUnits, defenseUnits, specialOff, rng) {
    const {
      down,
      distance,
      yardline,
      quarter,
      clockSec,
      scoreDiff,
      puntBias: _puntBias = 0,
      offMomentum = 0,            // NEW: offensive momentum in [-1, 1]
      clockIntent = null,   
    } = situation;
  
    const offPass  = offenseUnits.pass?.overall     ?? 60;
    const offRun   = offenseUnits.run?.overall      ?? 60;
    const defCover = defenseUnits.coverage?.overall ?? 60;
    const defRun   = defenseUnits.runFit?.overall   ?? 60;

      // ---------------- Hard clock overrides: kneel / spike ----------------
    if (clockIntent) {
        // Never spike on 4th, and only if there's actually time left
        if (clockIntent.forceKneel && clockSec > 0 && down >= 1 && down <= 4) {
        return { type: "kneel" };
        }
        if (clockIntent.forceSpike && clockSec > 0 && down >= 1 && down <= 3) {
        return { type: "spike" };
        }
    }
  
    // ---------------- Momentum wiring ----------------
    // Clamp momentum to [-1, 1]
    const m = clamp(offMomentum, -1, 1);
  
    // Base punt tendency from caller
    const basePuntBias = clamp(_puntBias, -0.40, 0.40); // + = punt more, - = go more
  
    // Effective punt bias: hot offense (m>0) → slightly less punty; cold → more conservative.
    // This is the only change to how puntBias feeds into the 4th-down logic.
    const puntBias = clamp(basePuntBias - 0.20 * m, -0.40, 0.40);
  
    // ---------------- Base run/pass tendency ----------------
    // Pass advantage relative to coverage -> baseline pass probability
    const passAdv = (offPass - defCover) / 15;
    let basePassProb = logistic(passAdv); // ~0.3–0.7 most of the time
  
    // Situation tweaks
    const isObviousPass =
      (down === 3 && distance >= 6) ||
      (down === 4 && distance >= 3);
  
    const isObviousRun =
      distance <= 2 && down <= 3 && yardline <= 80;
  
    if (isObviousPass) basePassProb = Math.max(basePassProb, 0.70);
    if (isObviousRun)  basePassProb = Math.min(basePassProb, 0.30);
  
    // Trailing late → throw more
    if (quarter >= 4 && clockSec <= 120 && scoreDiff < 0) {
      basePassProb = Math.max(basePassProb, 0.80);
    }
  
    // Momentum tilt on non-4th down:
    // Hot offense (m>0) → a bit more pass-happy, cold (m<0) → lean run.
    basePassProb += 0.05 * m;
  
    // Cap extremes a bit for variety
    basePassProb = clamp(basePassProb, 0.25, 0.80);
  
    // ---------------- 4th down decisions ----------------
    if (down === 4) {
        const yardsToGoal = 100 - yardline;
        const kAcc = specialOff.kicking?.accuracy ?? 60;
    
        // Approximate max "reasonable" FG distance as a function of kicker.
        // This is distance from LOS: yardsToGoal + 17.
        const rawKickDist = yardsToGoal + 17;
    
        // 40–100 accuracy → max distance from ~50–57 yards
        const maxFgDist = 50 + 0.12 * (kAcc - 60); // soft: ~48–57 range
        const inFgRange = rawKickDist <= maxFgDist;
    
        const oneScoreGame = Math.abs(scoreDiff) <= 8;
        const under2 = (quarter >= 4 && clockSec <= 120);
        const under5 = (quarter >= 4 && clockSec <= 300);
    
        // Field position bands
        const deepOwn   = yardline <= 35;       // backed up
        const midField  = yardline > 35 && yardline < 60;
        const plusTerr  = yardline >= 60;       // opp 40 and in
        const redZone   = yardsToGoal <= 20;
    
        const shortYds  = distance <= 2;
        const medYds    = distance > 2 && distance <= 5;
        const longYds   = distance > 5;
    
        // ---------- HARD MUST-GO OVERRIDES (fix end-game weirdness) ----------
        const secondsLeft = clockSec;
    
        // Trailing (or tied) by one score very late: never punt / try long FG.
        if (quarter === 4 && oneScoreGame && scoreDiff <= 0 && secondsLeft <= 90) {
        return { type: shortYds ? "run" : "pass" };
        }
    
        // Trailing by any amount with ~:40 or less: do not punt.
        if (quarter === 4 && scoreDiff < 0 && secondsLeft <= 40) {
        return { type: longYds ? "pass" : "run" };
        }
    
        // Down two scores late: don’t punt unless truly extreme.
        if (quarter === 4 && scoreDiff <= -9 && secondsLeft <= 120) {
        // If you somehow are at your own 5 and it’s 4th & 25+, allow a tiny punt chance.
        if (!(yardline < 20 && distance >= 25)) {
            return { type: longYds ? "pass" : "run" };
        }
        }
    
        // ----- MUST-GO situations (soft) -----
        // 4th-and-goal / very close in 4Q one-score when not leading → go-heavy.
        if (quarter >= 4 && oneScoreGame && redZone && scoreDiff <= 0) {
        let goProb = shortYds ? 0.80 : 0.60;
        // puntBias: if team punts more (positive), reduce go; if punts less (negative), increase go
        goProb += (-puntBias) * 0.20;
        goProb = clamp(goProb, 0.40, 0.90);
    
        if (rng.next() < goProb) {
            return { type: shortYds ? "run" : "pass" };
        }
        if (inFgRange) return { type: "field_goal" };
        return { type: shortYds ? "run" : "pass" };
        }
    
        // ----- Normal 4th-down logic (not must-go) -----
    
        // 1) Deep in own territory: very conservative → punt almost always.
        if (deepOwn) {
        // Rare YOLO when trailing big in 2H on 4th & short
        const desperate = quarter >= 3 && scoreDiff < -14 && shortYds;
        let goProb = desperate ? 0.25 : 0.02; // ~never, unless desperate
        goProb += (-puntBias) * (desperate ? 0.15 : 0.08);
        goProb = clamp(goProb, 0.00, 0.60);
    
        if (rng.next() < goProb) {
            return { type: shortYds ? "run" : "pass" };
        }
        return { type: "punt" };
        }
    
        // 2) Midfield (own 36–opp 39)
        if (midField) {
        // If in solid FG range and distance > 1, lean FG
        if (inFgRange && !shortYds) {
            // Slightly more aggressive to go when trailing
            let goProb = scoreDiff < 0 ? 0.25 : 0.10;
            goProb += (-puntBias) * 0.15;              // anti-punt teams go a bit more
            goProb = clamp(goProb, 0.05, 0.50);
    
            if (rng.next() < goProb) {
            return { type: longYds ? "pass" : "run" };
            }
            return { type: "field_goal" };
        }
    
        // 4th-and-short around midfield: mix go/punt
        if (shortYds) {
            // More likely to go if trailing or 2H
            let goProb = 0.25;
            if (quarter >= 2) goProb += 0.10;
            if (scoreDiff < 0) goProb += 0.15;
            if (under5 && oneScoreGame && scoreDiff < 0) goProb += 0.20;
            goProb += (-puntBias) * 0.25;              // key lever
            goProb = clamp(goProb, 0.20, 0.70);
    
            if (rng.next() < goProb) {
            return { type: basePassProb > 0.55 ? "pass" : "run" };
            }
            return { type: "punt" };
        }
    
        // 4th & medium/long at midfield → usually punt (but let anti-punt teams go a bit)
        const yoloGoProb = clamp((-puntBias) * 0.15, 0.00, 0.25);
        if (rng.next() < yoloGoProb) {
            return { type: basePassProb > 0.55 ? "pass" : "run" };
        }
        return { type: "punt" };
        }
    
        // 3) Plus territory (opp 40+)
        if (plusTerr) {
        // Inside comfortable FG range: mostly kick, but go sometimes on 4&short
        if (inFgRange) {
            if (shortYds) {
            let goProb = 0.35;
            if (quarter >= 2) goProb += 0.10;
            if (scoreDiff < 0) goProb += 0.15;
            if (under5 && oneScoreGame && scoreDiff < 0) goProb += 0.20;
            goProb += (-puntBias) * 0.20;
            goProb = clamp(goProb, 0.25, 0.75);
    
            if (rng.next() < goProb) {
                return { type: basePassProb > 0.55 ? "pass" : "run" };
            }
            }
            // Default in range: kick
            return { type: "field_goal" };
        }
    
        // Out of normal range (really long FG):
        // - Short/medium distance: go a decent chunk of the time
        if (shortYds || medYds) {
            let goProb = 0.60;
            if (scoreDiff < 0) goProb += 0.10;
            if (quarter >= 3) goProb += 0.10;
            goProb += (-puntBias) * 0.20;              // anti-punt teams go even more
            goProb = clamp(goProb, 0.50, 0.85);
    
            if (rng.next() < goProb) {
            return { type: basePassProb > 0.55 ? "pass" : "run" };
            }
            // fallback conservative choice
            return { type: "punt" };
        }
    
        // Long distance + out of range: mostly punt (but allow anti-punt flavor)
        const antiPuntGoProbPlus = clamp((-puntBias) * 0.20, 0.00, 0.30);
        if (rng.next() < antiPuntGoProbPlus) {
            return { type: basePassProb > 0.55 ? "pass" : "run" };
        }
        return { type: "punt" };
        }
    
        // Fallback (shouldn’t really hit, but just in case):
        // treat as midfield conservative
        if (inFgRange && !shortYds) {
        return { type: "field_goal" };
        }
        // tiny anti-punt bias even here
        const finalGoProb = clamp((-puntBias) * 0.10, 0.00, 0.20);
        if (rng.next() < finalGoProb) {
        return { type: basePassProb > 0.55 ? "pass" : "run" };
        }
        return { type: "punt" };
    }
    
  
    // ---------------- Non-4th downs: run vs pass ----------------
    return rng.next() < basePassProb ? { type: "pass" } : { type: "run" };
  }

  // ------------------------ Clock-management plays -----------------------------

function simulateKneelPlay(state, rng) {
    // Simple kneeldown: small loss, short in-play time, clock will run
    const yards = -1;
    const inPlayTime = rng.nextRange(1, 2); // ~1–2s
  
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
    const inPlayTime = rng.nextRange(1, 2); // ~1–2s
  
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
        let   runOff    = runUnit.overall ?? 60;   // changed to let
        let   frontRunD = defRun.overall ?? 60;    // changed to let
    
        const yardline = state.ballYardline;
        const down     = state.down;
        const distance = state.distance;
    
        // --- identify rusher (RB1 most of the time, occasional QB keep/scramble) ---
        const { offenseTeam, offenseSide, defenseSide } = getOffenseDefense(state); // include defenseSide
        const skill = getOffensiveSkillPlayers(offenseTeam);
    
        // Apply momentum multipliers
        const offMult = getMomentumMultiplier(state, offenseSide, "offense");
        const defMult = getMomentumMultiplier(state, defenseSide, "defense");
    
        runOff    = clamp(runOff    * offMult,  40, 99);
        frontRunD = clamp(frontRunD * defMult,  40, 99);
    
        let rusher = skill.rb1 || skill.qb || null;
        // very small chance of QB keep on obvious pass looks
        if (!rusher || (down >= 2 && distance >= 8 && rng.next() < 0.12)) {
        rusher = skill.qb || rusher;
        }
    
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
    
        // in-play time – if your micro engine gives it, use that, else estimate
        const inPlayTime = Number.isFinite(micro.timeElapsed)
        ? clamp(micro.timeElapsed, 3, 8.5)
        : clamp(3 + Math.abs(yards) * 0.2 + rng.nextRange(-0.5, 0.5), 3, 8.5);
    
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
        outOfBounds: false,        // OOB flag handled by macro clock logic if you want later
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
    let   passOff  = passUnit.overall ?? 60;  // changed to let
    let   coverDef = cover.overall ?? 60;     // changed to let
    let   rushDef  = rush.overall ?? 60;      // changed to let
  
    const yardline = state.ballYardline;
    const down     = state.down;
    const distance = state.distance;
  
    const { offenseTeam, offenseSide, defenseSide } = getOffenseDefense(state); // include defenseSide
    const skill = getOffensiveSkillPlayers(offenseTeam);
    const qb   = skill.qb || offenseTeam.getStarter?.("QB") || null;
    const rec  = chooseReceivingTarget(skill, rng);
  
    const offMult = getMomentumMultiplier(state, offenseSide, "offense");
    const defMult = getMomentumMultiplier(state, defenseSide, "defense");
  
    passOff  = clamp(passOff  * offMult, 40, 99);
    coverDef = clamp(coverDef * defMult, 40, 99);
    rushDef  = clamp(rushDef  * defMult, 40, 99);
  
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
    const interception = interceptionRaw && (rng.next() < 0.6);
    const fumble       = fumbleRaw       && (rng.next() < 0.6);
    const turnover     = interception || fumble;
  
    const sack       = sackRaw;
    const completion = completionRaw && !interception;
  
    // Incomplete if we didn't complete, and no INT/sack/fumble
    const incomplete = !completion && !interception && !sack && !fumble;
  
    const prospective = state.ballYardline + yards;
    const touchdown   = prospective >= 100;
    const safety      = prospective <= 0;
  
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
    if (qbRow) {
      qbRow.passAtt += 1;
      if (completion) {
        qbRow.passCmp  += 1;
        qbRow.passYds  += yards;
        if (touchdown) qbRow.passTD += 1;
      }
      if (interception) qbRow.passInt += 1;
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
      outOfBounds: false,  // you can wire explicit OOB later if desired
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
  
    const yardsToGoal  = 100 - state.ballYardline;
    const rawDistance  = yardsToGoal + 17; // LOS + 17 (standard NFL)
  
    const kAcc = specialOff.kicking?.accuracy ?? 60;
    const kPow = specialOff.kicking?.power   ?? 60;
  
    // Effective distance: stronger leg "shrinks" distance a bit
    const legBonus = (kPow - 70) * 0.15; // +/- ~4–5 yds across 40–100
    const effDist  = Math.max(18, rawDistance - legBonus);
  
    // Baseline make rate vs effective distance
    let base;
    if (effDist <= 30) {
      base = 0.985;
    } else if (effDist <= 35) {
      base = 0.985 - 0.006 * (effDist - 30);           // ~0.985 → ~0.955
    } else if (effDist <= 45) {
      base = 0.955 - 0.009 * (effDist - 35);           // ~0.955 → ~0.865
    } else if (effDist <= 55) {
      base = 0.865 - 0.015 * (effDist - 45);           // ~0.865 → ~0.715
    } else {
      base = 0.715 - 0.02 * (effDist - 55);            // then down toward 40s
    }
  
    // Kicker accuracy tweak: small but meaningful
    const accAdj = 0.0015 * (kAcc - 70);
    let prob = base + accAdj;
  
    // Context pressure: long, late, close game -> slightly harder
    const lateQuarter = state.quarter >= 4;
    const closeGame = Math.abs(state.score.home - state.score.away) <= 3;
    const longKick = rawDistance >= 50;
  
    if (lateQuarter && closeGame && longKick) {
      prob -= 0.03;
    }
  
    prob = clamp(prob, 0.10, 0.99);
  
    const made = rng.next() < prob;
  
    // Live clock on FGs: snap → whistle + brief admin
    const timeElapsed = rng.nextRange(5, 9);
  
    // Kicker stats
    const kicker =
      offenseSide === "home" ? state.homeKicker : state.awayKicker;
    const kickerRow = kicker ? ensurePlayerRow(state, kicker, offenseSide) : null;
    const kickerId   = getPlayerKey(kicker);
    const kickerName = getPlayerName(kicker);
  
    if (kickerRow) {
      kickerRow.fgAtt += 1;
      if (made) kickerRow.fgMade += 1;
    }
  
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
      kickDistance: rawDistance,
      offenseSide,
      kickerId,
      kickerName,
    };
  }
  
  
  
  
// ------------------------ Punt ----------------------------------------------
function simulatePunt(state, specialOff, rng) {
    const { cfg } = state;
    const { offenseSide, offenseTeam } = getOffenseDefense(state);
  
    const pControl   = specialOff.punting?.control   ?? 60;
    const pFieldFlip = specialOff.punting?.fieldFlip ?? 60;
  
    const base = cfg.puntBaseDistance;
    const adv  = (pControl + pFieldFlip - 120) / 5; // around average => 0
    const mean = base + adv;
    const std  = cfg.puntStd;
  
    let distance = normal(rng, mean, std);
    distance = clamp(distance, 25, 70);
  
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

    // Prefer simulator-provided in-play time; else estimate from context
    let inPlayTime = Number.isFinite(outcome.inPlayTime)
    ? outcome.inPlayTime
    : estimateInPlayTime(
        { playType, sack: isSack, incomplete: isIncompletion },
        rng
        );

    // Snap→whistle sanity clamp (live action only)
    inPlayTime = clamp(inPlayTime, 3.5, 8.5);

    // Late-clock windows where going out of bounds actually stops the clock
    const under2FirstHalf =
    state.quarter === 2 && prevClock <= 120;
    const under5Fourth =
    state.quarter === 4 && prevClock <= 300;
    const clockStopsWindow = under2FirstHalf || under5Fourth;

    // Only treat explicit out-of-bounds as a rule stoppage in those windows
    const oobStopsClock = !!outcome.outOfBounds && clockStopsWindow;

    // Clock is stopped after: incompletions always, plus late-window OOB.
    // We do *not* force a stop just because of scores or changes of possession;
    // their dead-ball time is absorbed into between-play runoff so that
    // total offensive TOP closely tracks the full 3600s of regulation.
    const clockStopsAfterPlay =
    isIncompletion || oobStopsClock;

    // Between-play runoff (0 when the clock is stopped awaiting next snap)
    const between = clockStopsAfterPlay
    ? 0
    : estimateBetweenPlayTime(state, outcome, preState, rng, offenseSide);

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

      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
  
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
      safetyProb = 0.38;     // very backed up and big loss
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
      state.possession = defenseSide;
      state.ballYardline = 25;
      state.down = 1;
      state.distance = 10;
      outcome.safety = true;
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
  
      outcome.touchdown = true;
      outcome.endOfDrive = true;
      applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
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
        applyMomentumFromOutcome(state, outcome, preState, offenseSide, defenseSide);
        state.down += 1;
        state.distance = yardsToFirst;
      }
    }

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
  
    const text = describePlay(
      decision,
      outcome,
      offenseTeam.teamName || offenseTeam.teamId
    );
  
    // Use PRE-PLAY state for ticker display
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
      playId: state.playId,
      driveId: state.driveId,
  
      // Display at snap-time
      quarter:  snapQuarter,
      clockSec: snapClockSec,
  
      offense: offenseSide,
      defense: defenseSide,
      offenseTeamId: offenseTeam.teamId,
      defenseTeamId: defenseTeam.teamId,
      offenseTeamName: offenseTeam.teamName,
      defenseTeamName: defenseTeam.teamName,
  
      // Ticker shows the *pre-snap* situation
      down:         snapDown,
      distance:     snapDistance,
      ballYardline: snapYardline,
  
      // Keep both pre/post for analytics
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
  
      // Raw outcome data (includes clockRunoff, etc.)
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
  