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

  // Which positions each slot accepts, per Sleeper's slot descriptions
  // ("G: POINT GUARD / SHOOTING GUARD", "UTIL: UTILITY (ALL)"). Bench takes anyone.
  const SLOT_ACCEPTS = {
    G: ['PG', 'SG'], F: ['SF', 'PF'],
    // NFL flex slots, from Sleeper's web app; every other NFL slot takes only its own position.
    FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], IDP_FLEX: ['DL', 'LB', 'DB'],
  };
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

  // IR rules, ported from Sleeper's apps: IR and PUP always qualify, other
  // injury statuses only when the league allows them.
  const RESERVE_ALLOW = { Out: 'reserve_allow_out', Sus: 'reserve_allow_sus', Doubtful: 'reserve_allow_doubtful', DTD: 'reserve_allow_dtd', DNR: 'reserve_allow_dnr', COV: 'reserve_allow_cov', NA: 'reserve_allow_na' };
  function reserveEligible(player, settings) {
    const status = player?.injury;
    if (!status) return false;
    if (status === 'IR' || status === 'PUP') return true;
    return Boolean(RESERVE_ALLOW[status] && settings[RESERVE_ALLOW[status]]);
  }

  // A lineup spot, by ref:
  //   's:<i>'  starter slot i ('0' in starters means empty, like Sleeper)
  //   'b:<id>' bench player       'be:<k>' open bench spot (roster has room)
  //   't:<id>' taxi player        'te:<k>' open taxi slot
  //   'r:<id>' IR player          're:<k>' open IR slot
  function spotOf(ref, l) {
    const cut = ref.indexOf(':');
    const kind = ref.slice(0, cut);
    const key = ref.slice(cut + 1);
    if (kind === 's') return { ref, kind, index: Number(key), slot: l.slots[Number(key)] ?? 'UTIL', id: l.starters[Number(key)] };
    if (kind === 'b' || kind === 'be') return { ref, kind, slot: 'BN', id: kind === 'b' ? key : null };
    if (kind === 'r' || kind === 're') return { ref, kind, slot: 'IR', id: kind === 'r' ? key : null };
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

  // One direction of an IR move (from = the IR side). Only injured players
  // the league allows go onto IR; coming off IR needs room on the active roster,
  // unless the player trades places with someone going onto IR.
  function reserveMove(from, to, l) {
    if (from.slot !== 'IR' || to.slot === 'IR' || to.slot === 'TX') return false;
    const pf = occupant(l.players, from.id);
    const pt = occupant(l.players, to.id);
    if (pt) return reserveEligible(pt, l.settings) && (!pf || fits(to.slot, pf));
    if (!pf) return false;
    return to.kind === 'be' || (to.kind === 's' && l.benchRoom > 0 && fits(to.slot, pf));
  }

  function canMove(a, b, l) {
    if (a.ref === b.ref) return false;
    if (a.slot === 'TX' || b.slot === 'TX') return taxiMove(a, b, l) || taxiMove(b, a, l);
    if (a.slot === 'IR' || b.slot === 'IR') return reserveMove(a, b, l) || reserveMove(b, a, l);
    return canSwap(a, b, l.players);
  }

  // Every spot in a lineup. Taxi, IR and open bench spots only count when they're editable.
  function spotRefs(l) {
    const refs = [...l.starters.map((_, i) => `s:${i}`), ...l.bench.map((id) => `b:${id}`)];
    const open = (prefix, n) => Array.from({ length: Math.max(0, n || 0) }, (_, k) => `${prefix}:${k}`);
    if (l.taxiEditable || l.reserveEditable) refs.push(...open('be', l.benchRoom));
    if (l.taxiEditable) refs.push(...(l.taxi || []).map((id) => `t:${id}`), ...open('te', l.taxiRoom));
    if (l.reserveEditable) refs.push(...(l.reserve || []).map((id) => `r:${id}`), ...open('re', l.reserveRoom));
    return refs;
  }

  // Refs of every spot the selected spot can trade places with.
  function swapTargets(fromRef, l) {
    const from = spotOf(fromRef, l);
    return spotRefs(l).filter((ref) => canMove(from, spotOf(ref, l), l));
  }

  // Starters, taxi and IR after two spots trade occupants. The bench is implicit:
  // whoever isn't starting, on taxi or on IR.
  function applyMove(fromRef, toRef, l) {
    const a = spotOf(fromRef, l);
    const b = spotOf(toRef, l);
    const starters = [...l.starters];
    const lists = { t: [...(l.taxi || [])], r: [...(l.reserve || [])] };
    const place = (spot, id) => {
      if (spot.kind === 's') starters[spot.index] = id || '0';
      const key = { t: 't', te: 't', r: 'r', re: 'r' }[spot.kind];
      if (!key) return;
      // A player spot swaps its occupant (or empties); an open slot gains one.
      if (spot.id) lists[key] = id ? lists[key].map((x) => (x === spot.id ? id : x)) : lists[key].filter((x) => x !== spot.id);
      else if (id) lists[key].push(id);
    };
    const idOf = (spot) => (spot.id && spot.id !== '0' ? spot.id : null);
    const [ida, idb] = [idOf(a), idOf(b)];
    place(a, idb);
    place(b, ida);
    return { starters, taxi: lists.t, reserve: lists.r };
  }

  // Where each player affected by a move ends up: [{ id, to: slot | 'taxi' | 'IR' | 'bench' }].
  function describeMove(before, after) {
    const where = (l, id) => {
      const i = l.starters.indexOf(id);
      if (i >= 0) return before.slots[i] ?? 'UTIL';
      if ((l.reserve || []).includes(id)) return 'IR';
      return (l.taxi || []).includes(id) ? 'taxi' : 'bench';
    };
    const ids = new Set([...before.starters, ...(before.taxi || []), ...(before.reserve || []),
      ...after.starters, ...(after.taxi || []), ...(after.reserve || [])]);
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

  // Score colors as Sleeper's mobile app shows a game's fantasy points
  // (green 24+, yellow 15+, red below). Thresholds observed, not from the API.
  const SCORE_TIERS = [[24, 'green'], [15, 'yellow'], [-Infinity, 'red']];
  const scoreTier = (points) => SCORE_TIERS.find(([min]) => points >= min)[1];

  // Lineup optimizer. Under Lock-In a lineup can change every day, so it picks
  // for the next day of games: a starter with no game that day can sit and come
  // back later, while whoever plays gets a shot at a score worth locking. A
  // player's worth is their projection that day; a starter whose finished game
  // can still be locked, and beats what they're projected to score later, is
  // worth at least that score, which benching them gives up. The rest of the
  // week (projected points per game left) breaks ties. Locked players and
  // players in a game right now stay put.
  const gameLive = (game, now) => game.status === 'in_game' ||
    (game.status === 'pre_game' && game.start != null && game.start <= now);

  function outlook(days, lockValue, starting, now) {
    const st = lockState(days, lockValue, now);
    const left = st.games.filter((d) => d.game.status === 'pre_game' && !gameLive(d.game, now));
    const perGame = left.length ? left.reduce((sum, d) => sum + (d.proj ?? 0), 0) / left.length : 0;
    // Only starters can lock, so only a starter's finished game is worth keeping.
    const banked = starting && st.lockable ? st.current : null;
    return {
      perGame,
      gamesLeft: left.length,
      left,
      banked,
      value: Math.max(perGame, banked?.actual ?? 0),
      fixed: st.locked ? 'locked' : st.games.some((d) => gameLive(d.game, now)) ? 'live' : null,
    };
  }

  // Slots that take fewer positions come first on a tie, so a pure center
  // sits at C and UTIL (or FLEX) stays open for anyone.
  const slotSpecificity = (slot) => (OPEN_SLOTS.has(slot) ? 0 : 6 - (SLOT_ACCEPTS[slot]?.length ?? 1));

  // Hungarian algorithm: the row -> column assignment with the lowest total
  // cost, for an n x m matrix with n <= m. Runs in O(n^2 m), so even a 20-slot
  // IDP lineup solves instantly.
  function cheapestAssignment(cost) {
    const n = cost.length;
    const m = cost[0]?.length ?? 0;
    const u = new Array(n + 1).fill(0);
    const v = new Array(m + 1).fill(0);
    const row = new Array(m + 1).fill(0); // column j's row (1-based), 0 when free
    const way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      row[0] = i;
      let j0 = 0;
      const minv = new Array(m + 1).fill(Infinity);
      const used = new Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = row[j0];
        let delta = Infinity;
        let j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const reduced = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (reduced < minv[j]) {
            minv[j] = reduced;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) {
            u[row[j]] += delta;
            v[j] -= delta;
          } else {
            minv[j] -= delta;
          }
        }
        j0 = j1;
      } while (row[j0] !== 0);
      do {
        const j1 = way[j0];
        row[j0] = row[j1];
        j0 = j1;
      } while (j0);
    }
    const colOf = new Array(n);
    for (let j = 1; j <= m; j++) if (row[j]) colOf[row[j] - 1] = j - 1;
    return colOf;
  }

  // The starting lineup with the highest total worth: every movable player is
  // matched to an open slot they fit, or to the bench. Ties go to the higher
  // total `later`, then to the lineup that moves the fewest players, then to
  // players in their most specific slot.
  //   worth(id): points a player is worth starting; later(id): the tie-breaker;
  //   fixedReason(id): why they can't move, or null.
  function solveLineup({ slots, starters: current, bench, players, worth, later = () => 0, fixedReason }) {
    const real = (id) => id && id !== '0';
    const fixed = [];
    const open = [];
    current.forEach((id, i) => {
      const reason = real(id) && fixedReason(id);
      if (reason) fixed.push({ id, reason });
      else open.push(i);
    });
    const benchFixed = bench.filter((id) => fixedReason(id));
    fixed.push(...benchFixed.map((id) => ({ id, reason: fixedReason(id) })));
    const pool = [...current.filter((id, i) => real(id) && open.includes(i)), ...bench.filter((id) => !benchFixed.includes(id))];

    const slotOf = (i) => slots[i] ?? 'UTIL';
    // Lexicographic in one number: worth (to the cent), then later (to the cent), then
    // staying put, then a specific slot. Each tier's unit outweighs 20 players' worth of
    // the tiers below it, and the totals stay exact in a double.
    const cents = (x) => Math.max(0, Math.min(Math.round(x * 100), 9999));
    const weight = (id, i) => cents(worth(id)) * 1e9 + cents(later(id)) * 4096 + (current[i] === id ? 128 : 0) + slotSpecificity(slotOf(i));
    const NO = 1e15; // can't play that slot
    // Rows: players. Columns: the open slots, then one bench spot per player.
    const cost = pool.map((id) => [
      ...open.map((i) => (fits(slotOf(i), players[id] || {}) ? -weight(id, i) : NO)),
      ...pool.map(() => 0),
    ]);
    const starters = current.map((id, i) => (open.includes(i) ? '0' : id));
    if (pool.length) {
      cheapestAssignment(cost).forEach((col, k) => {
        if (col < open.length) starters[open[col]] = pool[k];
      });
    }

    const where = (list, id) => {
      const i = list.indexOf(id);
      return i < 0 ? 'BN' : slotOf(i);
    };
    const changes = [...new Set([...current, ...starters])]
      .filter((id) => real(id) && current.indexOf(id) !== starters.indexOf(id))
      .map((id) => ({ id, from: where(current, id), to: where(starters, id) }))
      // Lineup order, then whoever goes to the bench.
      .sort((a, b) => (starters.includes(a.id) ? starters.indexOf(a.id) : 100 + current.indexOf(a.id)) -
        (starters.includes(b.id) ? starters.indexOf(b.id) : 100 + current.indexOf(b.id)));
    const total = (list) => list.reduce((sum, id) => sum + (real(id) ? worth(id) : 0), 0);
    return { starters, changes, fixed, before: total(current), after: total(starters) };
  }

  // NBA (Lock-In): the best lineup for the next day of games (`date`).
  function bestLineup(l, now = Date.now()) {
    if (!l.week) return null;
    const look = {};
    const consider = (id, starting) => {
      look[id] = outlook(playerDays(l.week, l.players[id]?.team, id), l.locks?.[id], starting, now);
    };
    l.starters.forEach((id) => id && id !== '0' && consider(id, true));
    l.bench.forEach((id) => consider(id, false));
    const date = Object.values(look).map((o) => o.left[0]?.date).filter(Boolean).sort()[0] ?? null;
    // A finished game is worth keeping only if it beats what the player is projected to score later.
    const keep = (o) => (o.banked && o.banked.actual > 0 && o.banked.actual >= o.perGame ? o.banked : null);
    const today = (id) => {
      const o = look[id];
      return Math.max(o.left.find((d) => d.date === date)?.proj ?? 0, keep(o)?.actual ?? 0);
    };
    const plan = solveLineup({
      slots: l.slots, starters: l.starters, bench: l.bench, players: l.players,
      worth: today,
      later: (id) => look[id].value,
      fixedReason: (id) => look[id].fixed,
    });
    plan.date = date;
    plan.changes = plan.changes.map((c) => {
      const o = look[c.id];
      const { perGame, gamesLeft, banked } = o;
      // Benching a starter whose finished game could still be locked throws that score away.
      const lost = c.to === 'BN' && banked?.actual > 0 && (keep(o) || scoreTier(banked.actual) === 'green') ? banked : null;
      return {
        ...c,
        perGame,
        gamesLeft,
        today: o.left.find((d) => d.date === date)?.proj ?? null,
        lost,
        // A green score is worth stopping for; anything less is a softer warning.
        goodScore: Boolean(lost) && scoreTier(lost.actual) === 'green',
      };
    });
    return plan;
  }

  // NFL injury statuses that mean a player won't play this week.
  const NFL_SITTING = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'COV', 'DNR']);

  // NFL: one game a week, so a player's worth is that game's projection (0 on a
  // bye or when ruled out). Players whose team has kicked off are locked by Sleeper.
  //   l: { slots, starters, bench, players: { id: { positions, injury } }, proj: { id: points }, played: { id: true } }
  function bestNflLineup(l) {
    const worth = (id) => (NFL_SITTING.has(l.players[id]?.injury) ? 0 : l.proj[id] ?? 0);
    const plan = solveLineup({
      slots: l.slots, starters: l.starters, bench: l.bench, players: l.players,
      worth,
      fixedReason: (id) => (l.played[id] ? 'played' : null),
    });
    plan.changes = plan.changes.map((c) => ({ ...c, proj: worth(c.id) }));
    return plan;
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

  // Each id's place when the list is ranked by `value`, highest first. Ties
  // share a place, as in standings.
  function ranks(ids, value) {
    const sorted = ids.map(value).sort((a, b) => b - a);
    const first = new Map();
    sorted.forEach((v, i) => { if (!first.has(v)) first.set(v, i + 1); });
    return Object.fromEntries(ids.map((id) => [id, first.get(value(id))]));
  }

  // How many places each player moves when a list is ranked by `after` instead
  // of `before` (positive = up), so nothing moves until a value changes.
  function rankShift(ids, before, after) {
    const [was, now] = [ranks(ids, before), ranks(ids, after)];
    return Object.fromEntries(ids.map((id) => [id, was[id] - now[id]]));
  }

  // Background for a rank shift: green up, red down, deeper the further it moves
  // relative to the biggest move in the list. No move, no color.
  const SHIFT_UP = '52, 168, 83';
  const SHIFT_DOWN = '214, 69, 80';
  function shiftTint(shift, biggest) {
    if (!shift || !biggest) return '';
    const strength = Math.min(1, Math.abs(shift) / biggest);
    return `rgba(${shift > 0 ? SHIFT_UP : SHIFT_DOWN}, ${(0.2 + 0.7 * strength).toFixed(2)})`;
  }

  return {
    ranks, rankShift, shiftTint,
    weekDays, gamesByTeam, pointsByGame, playerDays, lockInDefault, ownedPicks, spotRefs, swapTargets, applyMove, describeMove,
    taxiEligible, taxiOpen, reserveEligible,
    lockedGameId, lockState, scoreTier, bestLineup, bestNflLineup, cheapestAssignment, winProbability, standingsRanks,
    FAAB, rosterRoom, faabLeft, claimError, sortClaims,
  };
})();
