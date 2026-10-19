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

  return { weekDays, gamesByTeam, pointsByGame, playerDays, lockInDefault, ownedPicks, swapTargets, applySwap };
})();
