// config.js
// Core configuration, enums, math helpers, and RNG utilities
// for the DNA-based NFL-style simulation engine.
//
// This module is intentionally dependency-free and purely functional,
// so it can be safely imported from anywhere (data models, micro-engine,
// random models, game engine, etc.).

// -----------------------------------------------------------------------------
// Versioning / meta
// -----------------------------------------------------------------------------

export const ENGINE_VERSION = "0.1.0";
export const ENGINE_NAME = "DNA Football Engine";

// Layer semantics (for documentation / assertions)
export const LAYERS = Object.freeze({
  L0: "Human DNA seeds & base traits",
  L1: "Latent football factors + position & traits",
  L2: "Position-specific ratings (0–100) normalized by position",
  L3: "Team assignment, depth charts, team ratings",
  SIM: "Single-game simulation using micro- & macro-models",
});

// -----------------------------------------------------------------------------
// Positions / units / roles
// -----------------------------------------------------------------------------

// Canonical position list (matches Layer 1 / Layer 2 / Layer 3 code)
export const POSITIONS = Object.freeze([
  "QB",
  "RB",
  "WR",
  "TE",
  "FB",
  "LT",
  "LG",
  "C",
  "RG",
  "RT",
  "DT",
  "EDGE",
  "LB",
  "CB",
  "S",
  "K",
  "P",
]);

export const OFFENSE_POSITIONS = Object.freeze([
  "QB",
  "RB",
  "WR",
  "TE",
  "FB",
  "LT",
  "LG",
  "C",
  "RG",
  "RT",
]);

export const DEFENSE_POSITIONS = Object.freeze([
  "DT",
  "EDGE",
  "LB",
  "CB",
  "S",
]);

export const SPECIAL_POSITIONS = Object.freeze(["K", "P"]);

// Simple unit tags
export const UNIT = Object.freeze({
  OFFENSE: "OFFENSE",
  DEFENSE: "DEFENSE",
  SPECIAL: "SPECIAL",
});

// -----------------------------------------------------------------------------
// Simulation modes & high-level options
// -----------------------------------------------------------------------------

export const SIM_MODE = Object.freeze({
  FULL_GAME: "full-game",
  DRIVE_STEP: "drive-step",
  PLAY_STEP: "play-step",
});

// Play categories (micro-engine can refine further)
export const PLAY_CATEGORY = Object.freeze({
  RUN: "RUN",
  PASS: "PASS",
  SPECIAL: "SPECIAL",
});

// Basic down-and-distance classification
export const DOWN_DISTANCE_BUCKET = Object.freeze({
  SHORT: "SHORT", // 1–3
  MEDIUM: "MEDIUM", // 4–6
  LONG: "LONG", // 7–10
  VERY_LONG: "VERY_LONG", // 11+
});

// Simple field position coarse bands for heuristics
export const FIELD_ZONE = Object.freeze({
  OWN_DEEP: "OWN_DEEP", // own 1–20
  OWN_MID: "OWN_MID", // own 21–40
  MIDFIELD: "MIDFIELD", // 41–59 (either side)
  OPP_MID: "OPP_MID", // opp 40–21
  RED_ZONE: "RED_ZONE", // opp 20–1
  GOAL_TO_GO: "GOAL_TO_GO", // opp 10–1 w/ G2G context
});

// -----------------------------------------------------------------------------
// Game timing & structural config
// -----------------------------------------------------------------------------

export const GAME_CONFIG = Object.freeze({
  QUARTERS: 4,
  MINUTES_PER_QUARTER: 15,
  // Typical play durations (seconds) by type – used for clock modeling.
  PLAY_CLOCK_BASE: 40,
  PLAY_DURATIONS: {
    INCOMPLETE_PASS: 6,
    COMPLETE_PASS: 8,
    RUN: 7,
    SACK: 7,
    PENALTY: 4,
    SPIKE: 2,
    KNEEL: 3,
    FIELD_GOAL: 5,
    PUNT: 8,
    KICKOFF: 8,
  },
  // Time remaining threshold for "2-minute" logic in seconds.
  TWO_MINUTE_THRESHOLD_SECONDS: 120,
});

// -----------------------------------------------------------------------------
// Rating scales & normalization
// -----------------------------------------------------------------------------

// We know from Layer 2 diagnostics (1696 players) that rating_overall is roughly:
//   min ≈ 45, max ≈ 93, mean ≈ 67, std ≈ 8.8–9.0
// We'll encode that as a global scale so micro-models can treat ratings as a
// quasi-normal latent ability metric.
export const GLOBAL_RATING_SCALE = Object.freeze({
  mean: 67.0,
  std: 8.9,
  floor: 35.0, // allow some "floor" below current min for potential generation
  ceiling: 99.0,
});

// Convert a 0–100-ish rating into a z-score in the global skill space.
// This is used all over: time-to-pressure means, separation, etc.
export function ratingToZ(rating, scale = GLOBAL_RATING_SCALE) {
  const { mean, std } = scale;
  if (!isFinite(rating)) return 0;
  return (rating - mean) / (std || 1);
}

// Convert a z-score back to an approximate rating.
export function zToRating(z, scale = GLOBAL_RATING_SCALE) {
  const { mean, std, floor, ceiling } = scale;
  const raw = mean + (std || 1) * z;
  return clamp(raw, floor, ceiling);
}

// Map a rating (0–100) to a [0,1] talent score using a smooth logistic transform.
// This is handy when we want probabilities influenced by ratings, but not
// linearly (e.g., catch rate, sack rate, etc.).
export function ratingToTalent01(
  rating,
  center = GLOBAL_RATING_SCALE.mean,
  width = GLOBAL_RATING_SCALE.std * 2
) {
  const x = (rating - center) / (width || 1);
  return sigmoid(x);
}

// -----------------------------------------------------------------------------
// RNG system: deterministic, multi-stream
// -----------------------------------------------------------------------------

// We want reproducible randomness across:
// - Baseline talent / latent sampling (if needed).
// - Player "form" / game context.
// - Momentum / drive-level noise.
// - Play outcome noise.
// - Environment / chaos events.
//
// We use a lightweight 32-bit PRNG (Mulberry32-like) plus a deterministic
// string->seed hash to derive independent streams from a master seed.

function hashStringToUint32(str) {
  // Simple but effective 32-bit hash (xorshift-ish).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Final avalanche
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

// Core PRNG: mulberry32-style
export class SeededRng {
  constructor(seed) {
    // Seed is coerced into 32-bit unsigned integer.
    this.state = (seed >>> 0) || 1;
  }

  _nextUint32() {
    // Mulberry32
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  // Uniform [0,1)
  nextFloat() {
    return this._nextUint32() / 0xffffffff;
  }

  // Inclusive integer [min, max]
  nextInt(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error("SeededRng.nextInt requires finite min and max");
    }
    if (max < min) [min, max] = [max, min];
    const range = max - min + 1;
    return min + Math.floor(this.nextFloat() * range);
  }

  // Bernoulli(p)
  nextBool(p = 0.5) {
    return this.nextFloat() < p;
  }

  // Standard normal using Box–Muller transform
  nextNormal(mean = 0, std = 1) {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.nextFloat();
    while (v === 0) v = this.nextFloat();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const z0 = mag * Math.cos(2.0 * Math.PI * v);
    return mean + (std || 1) * z0;
  }

  // Log-normal with given log-mean/log-std (or mean/std in log space).
  nextLogNormal(mu = 0, sigma = 1) {
    const z = this.nextNormal(mu, sigma);
    return Math.exp(z);
  }

  // Truncated normal [min, max], simple rejection sampling with max iterations.
  nextTruncatedNormal(mean, std, min, max, maxAttempts = 12) {
    let x;
    for (let i = 0; i < maxAttempts; i += 1) {
      x = this.nextNormal(mean, std);
      if (x >= min && x <= max) return x;
    }
    // Fallback clamp
    return clamp(x ?? mean, min, max);
  }

  // Weighted random choice from array of items given array of weights.
  // weights can be raw; negative values will be treated as zero.
  weightedChoice(items, weights) {
    if (!Array.isArray(items) || !Array.isArray(weights)) {
      throw new Error("weightedChoice requires arrays of items and weights");
    }
    if (items.length !== weights.length || items.length === 0) {
      throw new Error("weightedChoice requires non-empty arrays of equal length");
    }
    let total = 0;
    const nonNegative = new Array(weights.length);
    for (let i = 0; i < weights.length; i += 1) {
      const w = weights[i];
      const v = w > 0 ? w : 0;
      nonNegative[i] = v;
      total += v;
    }
    if (total <= 0) {
      return items[this.nextInt(0, items.length - 1)];
    }
    let r = this.nextFloat() * total;
    for (let i = 0; i < items.length; i += 1) {
      r -= nonNegative[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  // In-place Fisher–Yates shuffle.
  shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Create a "child" RNG deterministically derived from this one
  // plus an optional label. This is useful to have sub-streams
  // per player, per drive, etc.
  spawn(label = "") {
    const baseSeed = this._nextUint32();
    const mix = hashStringToUint32(String(label));
    return new SeededRng(baseSeed ^ mix);
  }
}

// Named streams for our layered randomness model.
export const RANDOM_STREAM = Object.freeze({
  CORE: "core", // baseline / structural
  FORM: "form", // player form & volatility
  MOMENTUM: "momentum", // drive / game momentum
  PLAY: "play", // play-level noise
  ENV: "env", // environment / weather / ref variance
});

// Given a masterSeed, build a bundle of independent RNGs for each stream.
export function createRngBundle(masterSeed) {
  const base = new SeededRng(masterSeed || 1);
  return {
    masterSeed,
    core: base.spawn(RANDOM_STREAM.CORE),
    form: base.spawn(RANDOM_STREAM.FORM),
    momentum: base.spawn(RANDOM_STREAM.MOMENTUM),
    play: base.spawn(RANDOM_STREAM.PLAY),
    env: base.spawn(RANDOM_STREAM.ENV),
  };
}

// -----------------------------------------------------------------------------
// General math / probability helpers
// -----------------------------------------------------------------------------

export function clamp(x, min, max) {
  if (!Number.isFinite(x)) return isFinite(min) ? min : 0;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, v) {
  if (a === b) return 0.0;
  return (v - a) / (b - a);
}

// Logistic sigmoid σ(x) = 1 / (1 + e^-x)
export function sigmoid(x) {
  if (x < -40) return 0;
  if (x > 40) return 1;
  return 1 / (1 + Math.exp(-x));
}

// Logit inverse of sigmoid: log(p / (1-p))
export function logit(p) {
  const eps = 1e-9;
  const q = clamp(p, eps, 1 - eps);
  return Math.log(q / (1 - q));
}

// Approximate normal PDF and CDF for N(0,1)
// Mostly for diagnostics / calibration, not heavy-duty stats.
export function normalPdf(z) {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z);
}

// Abramowitz-Stegun-ish approximation for Φ(z)
export function normalCdf(z) {
  // Save the sign of z
  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z) / Math.sqrt(2);
  // erf approximation
  const t = 1 / (1 + 0.3275911 * absZ);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ);
  const phi = 0.5 * (1 + sign * erf);
  return phi;
}

// Softmax over arbitrary scores: returns array of probs
export function softmax(scores, temperature = 1.0) {
  if (!Array.isArray(scores) || scores.length === 0) return [];
  const t = temperature <= 0 ? 1 : temperature;
  let maxScore = -Infinity;
  for (const s of scores) {
    if (s > maxScore) maxScore = s;
  }
  const exps = scores.map((s) => Math.exp((s - maxScore) / t));
  const total = exps.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const n = scores.length;
    return new Array(n).fill(1 / n);
  }
  return exps.map((e) => e / total);
}

// Weighted random index for a vector of scores via softmax
export function softmaxSampleIndex(scores, rng, temperature = 1.0) {
  const probs = softmax(scores, temperature);
  if (!probs.length) return -1;
  const r = rng.nextFloat();
  let accum = 0;
  for (let i = 0; i < probs.length; i += 1) {
    accum += probs[i];
    if (r <= accum) return i;
  }
  return probs.length - 1;
}

// Convenience: Bernoulli(p) using global math (pass rng explicitly)
export function bernoulli(p, rng) {
  return rng.nextFloat() < p;
}

// Combine multiple signals (e.g., QB accuracy, WR hands, DB ball skills)
// into a single logistic "log-odds" additive model.
//
// Example usage (inside micro-engine):
//   const lo = logisticCombine([
//     { weight: +0.8, value: qbAccuracyZ },
//     { weight: +0.5, value: wrHandsZ },
//     { weight: -0.6, value: dbBallSkillsZ },
//   ], intercept);
//   const pCatch = sigmoid(lo);
//
export function logisticCombine(terms, intercept = 0) {
  let sum = intercept;
  if (Array.isArray(terms)) {
    for (const term of terms) {
      if (!term) continue;
      const w = term.weight ?? 1;
      const v = term.value ?? 0;
      sum += w * v;
    }
  }
  return sum;
}

// -----------------------------------------------------------------------------
// DNA latent-space hints (non-binding, but useful shared constants)
// -----------------------------------------------------------------------------

// Latent vector names we expect from upstream (Layer 1/2-derived),
// not strictly required but helpful for consistent naming / debugging.
export const LATENT_KEYS = Object.freeze({
  ATHLETIC: "A", // explosiveness, speed, COD, strength, durability...
  COGNITIVE: "C", // processing, pattern recognition, working memory...
  TECHNICAL: "T", // position-specific craft (routes, coverage, blocking...)
  PSYCHE: "P", // conscientiousness, grit, aggression, emo stability...
  VARIANCE: "V", // chaos, stability, environmental volatility...
});

// For some quick heuristics, we may want canonical component names inside each
// latent vector; these are advisory (micro-engine or random-models can define
// richer structures on top).
export const ATHLETIC_COMPONENTS = Object.freeze([
  "explosiveness",
  "topSpeed",
  "cod",
  "playStrength",
  "durability",
]);

export const COGNITIVE_COMPONENTS = Object.freeze([
  "processing",
  "patternIq",
  "workingMemory",
  "discipline",
]);

export const TECHNICAL_COMPONENTS = Object.freeze([
  "positionSkill", // generic
  "ballSkills",
  "coverageSkill",
  "routeSkill",
  "blockingSkill",
  "tacklingSkill",
]);

export const PSYCHE_COMPONENTS = Object.freeze([
  "conscientiousness",
  "grit",
  "riskTolerance",
  "aggression",
  "emotionalStability",
  "leadership",
]);

export const VARIANCE_COMPONENTS = Object.freeze([
  "shortTermVolatility",
  "longTermVolatility",
  "environmentNoise",
  "clutchSwing",
]);

// -----------------------------------------------------------------------------
// Convenience: basic event tags for logging
// -----------------------------------------------------------------------------

export const PLAY_TAG = Object.freeze({
  NORMAL: "NORMAL",
  KEY_PLAY: "KEY_PLAY",
  SCORING: "SCORING",
  TURNOVER: "TURNOVER",
  PENALTY: "PENALTY",
});

// Simple helper to classify field zone given yardline where 0 = own goal,
// 50 = midfield, 100 = opponent goal.
export function classifyFieldZone(yardline) {
  if (!Number.isFinite(yardline)) return FIELD_ZONE.MIDFIELD;
  if (yardline <= 20) return FIELD_ZONE.OWN_DEEP;
  if (yardline <= 40) return FIELD_ZONE.OWN_MID;
  if (yardline < 60) return FIELD_ZONE.MIDFIELD;
  if (yardline <= 80) return FIELD_ZONE.OPP_MID;
  if (yardline <= 90) return FIELD_ZONE.RED_ZONE;
  return FIELD_ZONE.GOAL_TO_GO;
}

// -----------------------------------------------------------------------------
// Debug helpers (non-essential, safe to ignore in engine logic)
// -----------------------------------------------------------------------------

export function formatRating(r) {
  if (!Number.isFinite(r)) return "–";
  return r.toFixed(1);
}

export function formatPercent(p) {
  if (!Number.isFinite(p)) return "–";
  return `${(100 * p).toFixed(1)}%`;
}

// Attach some meta for optional debugging from the console.
if (typeof window !== "undefined") {
  // Non-fatal: just makes it easier to poke at from DevTools
  window.__DNA_SIM_CONFIG__ = {
    ENGINE_VERSION,
    ENGINE_NAME,
    GLOBAL_RATING_SCALE,
    SIM_MODE,
    RANDOM_STREAM,
  };
}
