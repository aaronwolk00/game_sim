// league_stats.js
// -----------------------------------------------------------------------------
// Franchise GM – League Stats Aggregator
//
// Aggregates all individual game results stored in LeagueState.gameStats into
// season-to-date totals for players and teams. Used by stats.js and other pages.
// -----------------------------------------------------------------------------

import { TEAM_META } from "./league_schedule.js";

// -----------------------------------------------------------------------------
// Merge helpers
// -----------------------------------------------------------------------------

/**
 * Merge source player statline into target totals.
 */
export function mergePlayerStats(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "number") {
      target[k] = (target[k] || 0) + v;
    } else if (typeof v === "string" && !target[k]) {
      target[k] = v;
    }
  }
  return target;
}

/**
 * Merge source team totals into target.
 */
export function mergeTeamStats(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "number") {
      target[k] = (target[k] || 0) + v;
    }
  }
  return target;
}

// -----------------------------------------------------------------------------
// Core aggregation logic
// -----------------------------------------------------------------------------

/**
 * Insert a single game's stats into LeagueState.gameStats, keyed by week.
 * Idempotent – overwrites same game key cleanly.
 *
 * @param {object} leagueState
 * @param {number} weekIndex0
 * @param {string} gameKey
 * @param {object} gameResult
 */
export function upsertGameStatsFromResult(leagueState, weekIndex0, gameKey, gameResult) {
  if (!leagueState) return;
  if (!leagueState.gameStats) leagueState.gameStats = {};
  if (!leagueState.gameStats[weekIndex0]) leagueState.gameStats[weekIndex0] = {};
  leagueState.gameStats[weekIndex0][gameKey] = gameResult;
}

/**
 * Rebuild season-to-date cumulative stats.
 *
 * @param {object} leagueState
 * @param {{ throughWeekIndex0?: number|null }} [options]
 * @returns {object} leagueState.seasonStats
 */
export function rebuildSeasonStats(leagueState, options = {}) {
  if (!leagueState) return {};
  const throughWeekIndex0 = options.throughWeekIndex0 ?? null;

  const seasonStats = {
    updatedThroughWeekIndex0: throughWeekIndex0,
    teams: {},
    players: {}
  };

  const gameStats = leagueState.gameStats || {};
  const weekKeys = Object.keys(gameStats)
    .map((k) => parseInt(k, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  for (const weekIndex0 of weekKeys) {
    if (throughWeekIndex0 !== null && weekIndex0 > throughWeekIndex0) break;
    const weekGames = gameStats[weekIndex0];
    if (!weekGames) continue;

    for (const [gameId, gameResult] of Object.entries(weekGames)) {
      if (!gameResult) continue;

      // ---- Team stats
      if (gameResult.teamStats) {
        for (const [teamCode, stats] of Object.entries(gameResult.teamStats)) {
          if (!seasonStats.teams[teamCode]) {
            seasonStats.teams[teamCode] = { teamCode, gamesPlayed: 0 };
          }
          seasonStats.teams[teamCode].gamesPlayed++;
          mergeTeamStats(seasonStats.teams[teamCode], stats);
        }
      }

      // ---- Player stats
      if (gameResult.playerStats) {
        for (const [pid, pstats] of Object.entries(gameResult.playerStats)) {
          if (!pstats || typeof pstats !== "object") continue;
          const name = pstats.name || pid;
          const teamCode = pstats.teamCode || pstats.team || "UNK";
          const key = `${name}::${teamCode}`;
          if (!seasonStats.players[key]) {
            seasonStats.players[key] = { name, teamCode };
          }
          mergePlayerStats(seasonStats.players[key], pstats);
        }
      }
    }
  }

  // Sort normalization for later consumers
  seasonStats.players = Object.fromEntries(
    Object.entries(seasonStats.players).sort((a, b) => {
      const an = a[1].name || "";
      const bn = b[1].name || "";
      return an.localeCompare(bn);
    })
  );

  leagueState.seasonStats = seasonStats;
  return seasonStats;
}

// -----------------------------------------------------------------------------
// Utility for fast team-level summaries
// -----------------------------------------------------------------------------

/**
 * Compute quick per-team season summary (PF, PA, record) for use in statsSummary.
 * @param {object} leagueState
 */
export function rebuildStatsSummary(leagueState) {
  if (!leagueState || !leagueState.schedule || !leagueState.schedule.byTeam) return;
  const byTeam = leagueState.schedule.byTeam;
  const summary = {};

  for (const meta of TEAM_META) {
    const code = meta.teamCode;
    const games = byTeam[code] || [];
    let w = 0, l = 0, t = 0, pf = 0, pa = 0;
    for (const g of games) {
      if (g.status !== "final") continue;
      if (typeof g.teamScore === "number" && typeof g.opponentScore === "number") {
        pf += g.teamScore;
        pa += g.opponentScore;
        if (g.teamScore > g.opponentScore) w++;
        else if (g.teamScore < g.opponentScore) l++;
        else t++;
      }
    }
    summary[code] = {
      record: t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`,
      pf, pa, w, l, t
    };
  }

  leagueState.statsSummary = { ...leagueState.statsSummary, teams: summary };
  return summary;
}
