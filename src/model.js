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
    return last?.proj ?? null;
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

  // Taxi rules, ported from Sleeper's apps. A player qualifies by experience:
  // up to taxi_years (0 = no limit) when non-rookies are allowed, else rookies only.
  function taxiEligible(player, settings) {
    if (!player) return false;
    const limit = settings.taxi_years === 0 ? Infinity : settings.taxi_years || 0;
    const exp = Number(player.years_exp);
    return settings.taxi_allow_vets ? exp <= limit : exp <= 0;
  }

  // Whether players may move onto taxi now. taxi_deadline is the last preseason
  // week to do so; 4 means "until the first regular-season game tips off", 0 means
  // no deadline. Moving off taxi is never restricted.
  function taxiOpen(settings, seasonType, week, weekStarted) {
    const deadline = settings.taxi_deadline || 1;
    if (['post', 'star'].includes(seasonType) && settings.leg === 1) return true;
    return seasonType === 'off' ||
      (seasonType === 'pre' && week <= deadline) ||
      (seasonType === 'regular' && deadline === 4 && week === 1 && !weekStarted) ||
      settings.taxi_deadline === 0;
  }

  // A lineup spot, by ref:
  //   's:<i>'  starter slot i ('0' in starters means empty, like Sleeper)
  //   'b:<id>' bench player       'be:<k>' open bench spot (roster has room)
  //   't:<id>' taxi player        'te:<k>' open taxi slot
  function spotOf(ref, l) {
    const cut = ref.indexOf(':');
    const kind = ref.slice(0, cut);
    const key = ref.slice(cut + 1);
    if (kind === 's') return { ref, kind, index: Number(key), slot: l.slots[Number(key)] ?? 'UTIL', id: l.starters[Number(key)] };
    if (kind === 'b' || kind === 'be') return { ref, kind, slot: 'BN', id: kind === 'b' ? key : null };
    return { ref, kind, slot: 'TX', id: kind === 't' ? key : null };
  }

  const occupant = (players, id) => (id && id !== '0' ? players[id] || {} : null);

  function canSwap(a, b, players) {
    if (a.slot === 'BN' && b.slot === 'BN') return false;
    if (!occupant(players, a.id) && !occupant(players, b.id)) return false;
    return fits(b.slot, occupant(players, a.id)) && fits(a.slot, occupant(players, b.id));
  }

  // One direction of a taxi move, as Sleeper validates it (from = picked first).
  function taxiMove(from, to, l) {
    const pf = occupant(l.players, from.id);
    const pt = occupant(l.players, to.id);
    const canTaxi = (p) => l.taxiOpen && taxiEligible(p, l.settings);
    // Off taxi into an open bench spot: always allowed.
    if (from.slot === 'TX' && pf) return to.kind === 'be';
    // Filling an open taxi slot.
    if (from.slot === 'TX') return Boolean(pt) && to.slot !== 'TX' && canTaxi(pt);
    // Onto taxi from the bench or a starting slot; a displaced taxi player takes the starter's slot.
    if (to.slot === 'TX' && pf && canTaxi(pf)) return from.slot === 'BN' || !pt || fits(from.slot, pt);
    return false;
  }

  function canMove(a, b, l) {
    if (a.ref === b.ref) return false;
    if (a.slot === 'TX' || b.slot === 'TX') return taxiMove(a, b, l) || taxiMove(b, a, l);
    return canSwap(a, b, l.players);
  }

  // Every spot in a lineup. Taxi and open bench spots only count when taxi is editable.
  function spotRefs(l) {
    const refs = [...l.starters.map((_, i) => `s:${i}`), ...l.bench.map((id) => `b:${id}`)];
    if (!l.taxiEditable) return refs;
    const open = (prefix, n) => Array.from({ length: Math.max(0, n) }, (_, k) => `${prefix}:${k}`);
    return [...refs, ...open('be', l.benchRoom), ...(l.taxi || []).map((id) => `t:${id}`), ...open('te', l.taxiRoom)];
  }

  // Refs of every spot the selected spot can trade places with.
  function swapTargets(fromRef, l) {
    const from = spotOf(fromRef, l);
    return spotRefs(l).filter((ref) => canMove(from, spotOf(ref, l), l));
  }

  // Starters and taxi after two spots trade occupants. The bench is implicit:
  // whoever isn't starting, on taxi or on IR.
  function applyMove(fromRef, toRef, l) {
    const a = spotOf(fromRef, l);
    const b = spotOf(toRef, l);
    const starters = [...l.starters];
    let taxi = [...(l.taxi || [])];
    const place = (spot, id) => {
      if (spot.kind === 's') starters[spot.index] = id || '0';
      else if (spot.kind === 't') taxi = id ? taxi.map((x) => (x === spot.id ? id : x)) : taxi.filter((x) => x !== spot.id);
      else if (spot.kind === 'te' && id) taxi.push(id);
    };
    const idOf = (spot) => (spot.id && spot.id !== '0' ? spot.id : null);
    const [ida, idb] = [idOf(a), idOf(b)];
    place(a, idb);
    place(b, ida);
    return { starters, taxi };
  }

  // Where each player affected by a move ends up: [{ id, to: slot | 'taxi' | 'bench' }].
  function describeMove(before, after) {
    const where = (l, id) => {
      const i = l.starters.indexOf(id);
      if (i >= 0) return before.slots[i] ?? 'UTIL';
      return (l.taxi || []).includes(id) ? 'taxi' : 'bench';
    };
    const ids = new Set([...before.starters, ...(before.taxi || []), ...after.starters, ...(after.taxi || [])]);
    return [...ids]
      .filter((id) => id && id !== '0')
      .map((id) => ({ id, from: where(before, id), to: where(after, id) }))
      .filter((m) => m.from !== m.to)
      .map(({ id, to }) => ({ id, to }));
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

  // Waivers, ported from Sleeper's add/drop dialog. waiver_type 2 is FAAB.
  const FAAB = 2;

  // Open active-roster spots: one per roster position, and IR and taxi players don't count.
  function rosterRoom(league, roster) {
    const r = roster || {};
    return (league.roster_positions || []).length - (r.players || []).length + (r.reserve || []).length + (r.taxi || []).length;
  }

  function faabLeft(league, roster) {
    return Math.max(0, (league.settings?.waiver_budget || 0) - (roster?.settings?.waiver_budget_used || 0));
  }

  // Why a claim can't be submitted yet, or null. Only dropping an active player
  // opens a spot, since IR and taxi players don't count toward the roster.
  function claimError({ league, roster, waiver, bid, drops }) {
    const settings = league.settings || {};
    const inactive = new Set([...(roster.reserve || []), ...(roster.taxi || [])]);
    const room = rosterRoom(league, roster) + drops.filter((id) => !inactive.has(id)).length;
    if (room <= 0) {
      const need = 1 - rosterRoom(league, roster);
      return `You must select ${need} player${need > 1 ? 's' : ''} to drop`;
    }
    if (waiver && settings.waiver_type === FAAB) {
      const min = settings.waiver_bid_min || 0;
      const left = faabLeft(league, roster);
      if (bid === '' || bid == null || Number.isNaN(Number(bid))) return 'Invalid bid amount';
      if (Number(bid) < 0) return 'Bid cannot be negative';
      if (!Number.isInteger(Number(bid))) return 'Bids are whole dollars';
      if (Number(bid) < min) return `Bid must be a minimum of $${min}`;
      if (Number(bid) > left) return `You only have $${left} remaining`;
    }
    return null;
  }

  // Pending claims in the order Sleeper processes them: highest bid, then priority.
  function sortClaims(claims) {
    const bid = (c) => c.settings?.waiver_bid ?? 0;
    const priority = (c) => c.settings?.priority ?? Infinity;
    return [...claims].sort((a, b) =>
      bid(b) - bid(a) || priority(a) - priority(b) || String(a.transaction_id).localeCompare(String(b.transaction_id)));
  }

  return {
    weekDays, gamesByTeam, pointsByGame, playerDays, lockInDefault, ownedPicks, spotRefs, swapTargets, applyMove, describeMove,
    taxiEligible, taxiOpen,
    lockedGameId, lockState, winProbability, standingsRanks,
    FAAB, rosterRoom, faabLeft, claimError, sortClaims,
  };
})();
