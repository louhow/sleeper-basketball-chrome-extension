// Pure functions that turn raw API responses into what the team view shows.
(globalThis.SNP ||= {}).model = (() => {
  const DAY_MS = 864e5;

  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  // Sleeper's NBA weeks run Monday through Sunday; anchor on the week's first game.
  function weekDays(games) {
    const first = games.map((g) => g.date).sort()[0];
    if (!first) return [];
    const noon = Date.parse(`${first}T12:00:00Z`);
    const monday = noon - ((new Date(noon).getUTCDay() + 6) % 7) * DAY_MS;
    return Array.from({ length: 7 }, (_, i) => isoDay(monday + i * DAY_MS));
  }

  // GraphQL `scores` rows -> { [team]: { [date]: game } }
  function gamesByTeam(scores) {
    const out = {};
    for (const s of scores) {
      const home = s.metadata?.home_team?.team;
      const away = s.metadata?.away_team?.team;
      const game = { id: s.game_id, date: s.date, start: s.start_time, status: s.status, home, away };
      for (const team of [home, away]) if (team) (out[team] ||= {})[s.date] = game;
    }
    return out;
  }

  // Projection or stat rows -> { [playerId]: { [gameId]: fantasy points } }
  function pointsByGame(rows, scoring, scoreStats) {
    const out = {};
    for (const row of rows) {
      if (!row.game_id) continue;
      (out[row.player_id] ||= {})[row.game_id] = scoreStats(scoring, row.stats || {});
    }
    return out;
  }

  // One cell per day of the week for a player's NBA team.
  function playerDays(week, team, playerId) {
    const games = week.gamesByTeam[team] || {};
    return week.days.map((date) => {
      const game = games[date];
      if (!game) return { date };
      const home = game.home === team;
      return {
        date,
        game,
        opponent: home ? game.away : game.home,
        home,
        proj: week.proj[playerId]?.[game.id],
        actual: week.actual[playerId]?.[game.id],
      };
    });
  }

  // In Lock-In mode an unlocked player scores their final game of the week,
  // so that game's projection is the player's default weekly projection.
  function lockInDefault(days) {
    const last = days.filter((d) => d.game).at(-1);
    return last ? last.proj ?? 0 : null;
  }

  // Which draft picks a roster holds, given trades. Each pick starts with its
  // original roster; a traded_picks row moves it to owner_id.
  function ownedPicks({ rosterId, rosterIds, seasons, rounds, traded }) {
    const moved = new Map(traded.map((t) => [`${t.season}:${t.round}:${t.roster_id}`, t.owner_id]));
    const picks = [];
    for (const season of seasons) {
      for (let round = 1; round <= rounds; round++) {
        for (const original of rosterIds) {
          const owner = moved.get(`${season}:${round}:${original}`) ?? original;
          if (owner === rosterId) picks.push({ season, round, original });
        }
      }
    }
    return picks;
  }

  // Which positions each NBA slot accepts, per Sleeper's slot descriptions
  // ("G: POINT GUARD / SHOOTING GUARD", "UTIL: UTILITY (ALL)"). Bench takes anyone.
  const SLOT_ACCEPTS = { G: ['PG', 'SG'], F: ['SF', 'PF'] };
  const OPEN_SLOTS = new Set(['UTIL', 'BN']);

  function fits(slot, player) {
    if (!player) return true; // an empty spot can go anywhere
    if (OPEN_SLOTS.has(slot)) return true;
    const accepts = SLOT_ACCEPTS[slot] || [slot];
    return (player.positions || []).some((p) => accepts.includes(p));
  }

  // A lineup spot is a starter slot (by index) or a bench player (by id).
  // `starters` uses '0' for an empty slot, like Sleeper does.
  function spotOf(ref, starters, slots) {
    if (ref.startsWith('s:')) {
      const index = Number(ref.slice(2));
      return { ref, index, slot: slots[index] ?? 'UTIL', id: starters[index] };
    }
    return { ref, slot: 'BN', id: ref.slice(2) };
  }

  const occupant = (players, id) => (id && id !== '0' ? players[id] || {} : null);

  function canSwap(a, b, players) {
    if (a.ref === b.ref) return false;
    if (a.slot === 'BN' && b.slot === 'BN') return false;
    if (!occupant(players, a.id) && !occupant(players, b.id)) return false;
    return fits(b.slot, occupant(players, a.id)) && fits(a.slot, occupant(players, b.id));
  }

  // Refs of every spot the selected spot can trade places with.
  function swapTargets(fromRef, { starters, slots, bench, players }) {
    const from = spotOf(fromRef, starters, slots);
    const refs = [...starters.map((_, i) => `s:${i}`), ...bench.map((id) => `b:${id}`)];
    return refs.filter((ref) => canSwap(from, spotOf(ref, starters, slots), players));
  }

  // New starters array after swapping two spots; bench is whatever isn't starting.
  function applySwap(fromRef, toRef, starters, slots) {
    const a = spotOf(fromRef, starters, slots);
    const b = spotOf(toRef, starters, slots);
    const next = [...starters];
    if (a.index != null) next[a.index] = b.id || '0';
    if (b.index != null) next[b.index] = a.id || '0';
    return next;
  }

  // Lock-In picks map player id -> game id (Sleeper's apps read them that way).
  const lockedGameId = (value) => (value && typeof value === 'object' ? value.game_id ?? value.id : value) ?? null;

  // Where a player stands under Lock-In rules this week:
  // - a finished game can be locked until the player's next game starts;
  // - a lock is final, and only one game counts;
  // - with no lock, the final game of the week counts.
  function lockState(days, lockValue, now = Date.now()) {
    const games = days.filter((d) => d.game);
    const lockId = lockedGameId(lockValue);
    const locked = lockId == null ? null : games.find((d) => String(d.game.id) === String(lockId)) ?? null;
    const lastDone = games.filter((d) => d.game.status === 'complete').at(-1) ?? null;
    const next = games.find((d) => d.game.status !== 'complete') ?? null;
    const nextStarted = Boolean(next) && (next.game.status === 'in_game' || (next.game.start != null && next.game.start <= now));
    const lockable = !locked && Boolean(lastDone) && !nextStarted;
    const counted = locked ?? (next ? null : games.at(-1) ?? null);
    return {
      games,
      locked,
      lockable,
      // The game to show: the lock, else the one that can be locked, else what's next.
      current: locked ?? (lockable ? lastDone : next ?? lastDone),
      counted,
      points: counted ? counted.actual ?? 0 : null,
      yetToPlay: !locked && Boolean(next),
    };
  }

  // Sleeper's win probability (ported from its web app): each side is a normal
  // distribution centred on its projection, tighter as the current score nears it.
  function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + z / 2);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v || 0));

  function winProbability(current1, proj1, current2, proj2) {
    const r2 = (n) => Number(n.toFixed(2));
    if (r2(current1) === r2(proj1) && r2(current2) === r2(proj2)) {
      const a = r2(current1);
      const b = r2(current2);
      return a === b ? [0, 0] : a > b ? [1, 0] : [0, 1];
    }
    const spread = (current, proj) => {
      const n = 1 + 10 * (1 - current / proj);
      const variance = Math.sqrt((current - proj) ** 2 / n) ** 2 || 0.1;
      return { mean: proj, variance };
    };
    const a = spread(current1, proj1);
    const b = spread(current2, proj2);
    const mean = a.mean - b.mean;
    const sd = Math.sqrt(a.variance + b.variance);
    const cdf0 = 0.5 * erfc(mean / (sd * Math.SQRT2));
    const p1 = clamp(0.01, 0.99, 1 - cdf0);
    return [p1, clamp(0.01, 0.99, 1 - p1)];
  }

  // roster_id -> rank. Uses Sleeper's roster_standings when it has rows; before
  // any games it falls back to the standings order (record, points, then waiver order).
  function standingsRanks(rosters, standings) {
    if (standings?.length) return Object.fromEntries(standings.map((s) => [s.roster_id, s.rank]));
    const pts = (r) => (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100;
    const order = [...rosters].sort((a, b) =>
      (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0) ||
      (b.settings?.ties ?? 0) - (a.settings?.ties ?? 0) ||
      pts(b) - pts(a) ||
      (a.settings?.waiver_position ?? 0) - (b.settings?.waiver_position ?? 0));
    return Object.fromEntries(order.map((r, i) => [r.roster_id, i + 1]));
  }

  return {
    weekDays, gamesByTeam, pointsByGame, playerDays, lockInDefault, ownedPicks, swapTargets, applySwap,
    lockedGameId, lockState, winProbability, standingsRanks,
  };
})();
