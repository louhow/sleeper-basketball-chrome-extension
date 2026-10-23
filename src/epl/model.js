// Pure functions that turn raw API responses into what the views show, plus
// the lineup, waiver and standings rules. No DOM, no network.
(globalThis.SEP ||= {}).model = (() => {
  // GraphQL `scores` rows (or /schedule rows) -> games, earliest first.
  function gamesFromScores(rows) {
    return (rows || []).map((s) => {
      const home = s.metadata?.home_team || s.home || {};
      const away = s.metadata?.away_team || s.away || {};
      return {
        id: String(s.game_id),
        date: s.date,
        start: s.start_time ?? null,
        status: s.status || 'pre_game',
        home: home.team, homeAbbr: home.abbr, homeName: home.name,
        away: away.team, awayAbbr: away.abbr, awayName: away.name,
      };
    }).sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || String(a.date).localeCompare(String(b.date)));
  }

  // games -> { [teamId]: [game, ...] } (a club can play twice in a gameweek).
  function gamesByTeam(games) {
    const out = {};
    for (const g of games) for (const team of [g.home, g.away]) if (team) (out[team] ||= []).push(g);
    return out;
  }

  // Projection or stat rows -> { [playerId]: { [gameId]: { points, stats } } }
  function pointsByGame(rows, scoring, scoreStats) {
    const out = {};
    for (const row of rows || []) {
      if (!row.game_id) continue;
      const stats = row.stats || {};
      (out[row.player_id] ||= {})[String(row.game_id)] = { points: scoreStats(scoring, stats), stats, opponent: row.opponent };
    }
    return out;
  }

  const started = (game, now) => game.status !== 'pre_game' || (game.start != null && game.start <= now);
  const finished = (game) => game.status === 'complete';

  // A player's games this week, in order: the game, home/away, opponent, projection and result.
  function playerGames(week, team, playerId) {
    const games = (team && week?.gamesByTeam?.[team]) || [];
    return games.map((game) => {
      const home = game.home === team;
      const proj = week.proj?.[playerId]?.[game.id];
      const actual = week.actual?.[playerId]?.[game.id];
      return {
        game, home,
        opponent: home ? game.away : game.home,
        opponentAbbr: home ? game.awayAbbr : game.homeAbbr,
        proj: proj?.points ?? null,
        actual: actual?.points ?? null,
        stats: actual?.stats ?? null,
        // Played: the game has started and Sleeper has a stat line, or it's over.
        played: finished(game) || (actual != null && started(game, Date.now())),
      };
    });
  }

  // A player's week in numbers: points so far, the projected total (actual once
  // played, else projection), and how many games are left.
  function weekTotals(games, now = Date.now()) {
    let points = 0;
    let proj = 0;
    let played = 0;
    let left = 0;
    let live = false;
    for (const g of games) {
      const on = started(g.game, now);
      if (on && !finished(g.game)) live = true;
      if (on) {
        points += g.actual ?? 0;
        proj += g.actual ?? (finished(g.game) ? 0 : g.proj ?? 0);
        played++;
      } else {
        proj += g.proj ?? 0;
        left++;
      }
    }
    return { points, proj, played, left, live, any: games.length > 0 };
  }

  // Which positions a slot accepts. Soccer flex slots spell out their positions
  // (FM_FLEX: forward or midfielder); every other slot takes its own position.
  const POSITIONS = ['GK', 'D', 'M', 'F'];
  const OPEN_SLOTS = new Set(['UTIL', 'BN', 'FLEX']);
  function slotAccepts(slot) {
    if (OPEN_SLOTS.has(slot)) return POSITIONS;
    const flex = slot.match(/^([A-Z]+)_FLEX$/);
    if (!flex) return [slot];
    return flex[1].match(/GK|F|M|D/g) || POSITIONS;
  }

  function fits(slot, player) {
    if (!player) return true; // an empty spot can go anywhere
    if (slot === 'BN' || slot === 'IR') return true;
    const accepts = slotAccepts(slot);
    return (player.positions || []).some((p) => accepts.includes(p));
  }

  // Injury statuses the league lets onto IR. Sleeper's soccer statuses are Out, Sus and GTD.
  function reserveEligible(player, settings) {
    const status = String(player?.injury || '').toLowerCase();
    if (!status) return false;
    if (status === 'ir') return true;
    const allow = { out: 'reserve_allow_out', sus: 'reserve_allow_sus', doubtful: 'reserve_allow_doubtful', gtd: 'reserve_allow_dtd' };
    if (status === 'gtd') return Boolean(settings?.reserve_allow_dtd || settings?.reserve_allow_doubtful);
    return Boolean(settings?.[allow[status]] ?? settings?.[`reserve_allow_${status}`]);
  }

  // A spot in a lineup: 's:<index>' (starter), 'b:<id>' (bench player),
  // 'r:<id>' (IR player), 're:<n>' (open IR spot), 'be:<n>' (open bench spot).
  function spotOf(ref, l) {
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i);
    const key = ref.slice(i + 1);
    if (kind === 's') return { ref, kind, index: Number(key), slot: l.slots[Number(key)] ?? 'FLEX', id: l.starters[Number(key)] };
    if (kind === 'b') return { ref, kind, slot: 'BN', id: key };
    if (kind === 'r') return { ref, kind, slot: 'IR', id: key };
    if (kind === 're') return { ref, kind, slot: 'IR', id: null };
    return { ref, kind, slot: 'BN', id: null };
  }

  const occupant = (players, id) => (id && id !== '0' ? players[id] || { positions: [] } : null);

  function canSwap(a, b, l) {
    if (a.slot === 'BN' && b.slot === 'BN') return false;
    const pa = occupant(l.players, a.id);
    const pb = occupant(l.players, b.id);
    if (!pa && !pb) return false;
    if ((pa && l.locked?.has(a.id)) || (pb && l.locked?.has(b.id))) return false;
    return fits(b.slot, pa) && fits(a.slot, pb);
  }

  // One direction of an IR move (from = the IR side). Only injured players the
  // league allows go onto IR; coming off IR needs room on the active roster,
  // unless the player trades places with someone going onto IR.
  function reserveMove(from, to, l) {
    if (from.slot !== 'IR' || to.slot === 'IR') return false;
    const pf = occupant(l.players, from.id);
    const pt = occupant(l.players, to.id);
    if (pt) return reserveEligible(pt, l.settings) && (!pf || fits(to.slot, pf));
    if (!pf) return false;
    return to.kind === 'be' || (to.kind === 's' && l.benchRoom > 0 && fits(to.slot, pf));
  }

  function canMove(a, b, l) {
    if (a.ref === b.ref) return false;
    if (a.slot === 'IR' || b.slot === 'IR') return reserveMove(a, b, l) || reserveMove(b, a, l);
    return canSwap(a, b, l);
  }

  // Every spot in a lineup. IR and open bench spots only count when IR is editable.
  function spotRefs(l) {
    const refs = [...l.starters.map((_, i) => `s:${i}`), ...l.bench.map((id) => `b:${id}`)];
    const open = (prefix, n) => Array.from({ length: Math.max(0, n || 0) }, (_, k) => `${prefix}:${k}`);
    if (l.reserveEditable) {
      refs.push(...open('be', l.benchRoom), ...(l.reserve || []).map((id) => `r:${id}`), ...open('re', l.reserveRoom));
    }
    return refs;
  }

  function swapTargets(fromRef, l) {
    const from = spotOf(fromRef, l);
    return spotRefs(l).filter((ref) => canMove(from, spotOf(ref, l), l));
  }

  // Starters and IR after two spots trade occupants. The bench is implicit.
  function applyMove(fromRef, toRef, l) {
    const a = spotOf(fromRef, l);
    const b = spotOf(toRef, l);
    const starters = [...l.starters];
    let reserve = [...(l.reserve || [])];
    const place = (spot, id) => {
      if (spot.kind === 's') starters[spot.index] = id || '0';
      if (spot.kind === 'r') reserve = id ? reserve.map((x) => (x === spot.id ? id : x)) : reserve.filter((x) => x !== spot.id);
      if (spot.kind === 're' && id) reserve.push(id);
    };
    const idOf = (spot) => (spot.id && spot.id !== '0' ? spot.id : null);
    const [ida, idb] = [idOf(a), idOf(b)];
    place(a, idb);
    place(b, ida);
    return { starters, reserve };
  }

  // Where each player affected by a move ends up: [{ id, to }].
  function describeMove(before, after) {
    const where = (l, id) => {
      const i = l.starters.indexOf(id);
      if (i >= 0) return before.labels?.[i] ?? before.slots[i] ?? 'FLEX';
      return (l.reserve || []).includes(id) ? 'IR' : 'bench';
    };
    const ids = new Set([...before.starters, ...(before.reserve || []), ...after.starters, ...(after.reserve || [])]);
    return [...ids]
      .filter((id) => id && id !== '0')
      .map((id) => ({ id, from: where(before, id), to: where(after, id) }))
      .filter((m) => m.from !== m.to)
      .map(({ id, to }) => ({ id, to }));
  }

  // Formations. Sleeper's soccer lineups put the flex slots to use as extra
  // defenders, midfielders or forwards; the app shows that as "3-4-3" and
  // saves the choice in roster metadata ({ [week]: "3-4-3" }). Each flex slot
  // gets a display label (F, M or D) that matches the formation when one is
  // saved, else its occupant's position.
  const FORMATION_ORDER = ['D', 'M', 'F'];

  function parseFormation(text) {
    const m = String(text || '').match(/^(\d+)-(\d+)-(\d+)$/);
    return m ? { D: Number(m[1]), M: Number(m[2]), F: Number(m[3]) } : null;
  }

  function savedFormation(roster, week) {
    try {
      const map = JSON.parse(roster?.metadata?.formation || '{}');
      return parseFormation(map?.[String(week)]);
    } catch {
      return null;
    }
  }

  // Display label per slot. Fixed slots keep their position; flex slots are
  // labeled to reach the saved formation's counts, preferring the occupant's position.
  function slotLabels(slots, starters, players, formation) {
    const labels = slots.map((slot) => (slotAccepts(slot).length === 1 ? slot : null));
    const flex = slots.map((slot, i) => (labels[i] ? null : i)).filter((i) => i != null);
    const prefer = (i) => {
      const p = occupant(players, starters[i]);
      const accepts = slotAccepts(slots[i]).filter((pos) => pos !== 'GK');
      const own = (p?.positions || []).find((pos) => accepts.includes(pos));
      return own || accepts[0];
    };
    if (formation) {
      // Try every labeling of the flex slots; keep the one matching the formation
      // that keeps the most occupants in their own position.
      let best = null;
      const need = { ...formation };
      for (const [i, label] of labels.entries()) if (label && need[label] != null) need[label]--;
      const choices = flex.map((i) => slotAccepts(slots[i]).filter((pos) => pos !== 'GK'));
      const walk = (k, picked, score) => {
        if (k === flex.length) {
          const counts = { D: 0, M: 0, F: 0 };
          for (const pos of picked) counts[pos]++;
          if (FORMATION_ORDER.every((pos) => counts[pos] === need[pos]) && (!best || score > best.score)) best = { picked: [...picked], score };
          return;
        }
        for (const pos of choices[k]) walk(k + 1, [...picked, pos], score + (pos === prefer(flex[k]) ? 1 : 0));
      };
      walk(0, [], 0);
      if (best) {
        flex.forEach((i, k) => { labels[i] = best.picked[k]; });
        return labels;
      }
    }
    for (const i of flex) labels[i] = prefer(i);
    return labels;
  }

  function formationOf(labels) {
    const counts = { D: 0, M: 0, F: 0 };
    for (const label of labels) if (counts[label] != null) counts[label]++;
    return FORMATION_ORDER.map((pos) => counts[pos]).join('-');
  }

  // Hungarian algorithm: the row -> column assignment with the lowest total
  // cost, for an n x m matrix with n <= m.
  function cheapestAssignment(cost) {
    const n = cost.length;
    const m = cost[0]?.length ?? 0;
    const u = new Array(n + 1).fill(0);
    const v = new Array(m + 1).fill(0);
    const row = new Array(m + 1).fill(0);
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

  // Slots that take fewer positions come first on a tie, so a pure forward
  // sits at F and the flex stays open for anyone.
  const slotSpecificity = (slot) => 5 - slotAccepts(slot).length;

  // The starting lineup with the highest total worth: every movable player is
  // matched to an open slot they fit, or to the bench. Ties keep players where
  // they are, then put them in their most specific slot.
  function solveLineup({ slots, starters: current, bench, players, worth, fixedReason }) {
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
    const slotOf = (i) => slots[i] ?? 'FLEX';
    const weight = (id, i) => Math.round(worth(id) * 100) * 1e6 + (current[i] === id ? 1000 : 0) + slotSpecificity(slotOf(i));
    const NO = 1e15;
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
      .sort((a, b) => (starters.includes(a.id) ? starters.indexOf(a.id) : 100 + current.indexOf(a.id)) -
        (starters.includes(b.id) ? starters.indexOf(b.id) : 100 + current.indexOf(b.id)));
    const total = (list) => list.reduce((sum, id) => sum + (real(id) ? worth(id) : 0), 0);
    return { starters, changes, fixed, before: total(current), after: total(starters) };
  }

  // A player's worth this week: projected points for games not yet played
  // (plus whatever they already scored). Players whose game has kicked off stay put.
  function bestLineup(l, now = Date.now()) {
    if (!l.week) return null;
    const look = {};
    const consider = (id) => {
      const games = playerGames(l.week, l.players[id]?.team, id);
      const t = weekTotals(games, now);
      const sitting = /^(out|sus|ir)/i.test(l.players[id]?.injury || '');
      look[id] = { value: sitting && !t.played ? 0 : t.proj, left: t.left, fixed: l.locked?.has(id) ? 'locked' : null };
    };
    l.starters.forEach((id) => id && id !== '0' && consider(id));
    l.bench.forEach(consider);
    const plan = solveLineup({
      slots: l.slots, starters: l.starters, bench: l.bench, players: l.players,
      worth: (id) => look[id].value,
      fixedReason: (id) => look[id].fixed,
    });
    plan.changes = plan.changes.map((c) => ({ ...c, proj: look[c.id].value, left: look[c.id].left }));
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
    const r2 = (n) => Number((n || 0).toFixed(2));
    if (r2(current1) === r2(proj1) && r2(current2) === r2(proj2)) {
      const a = r2(current1);
      const b = r2(current2);
      return a === b ? [0.5, 0.5] : a > b ? [1, 0] : [0, 1];
    }
    const spread = (current, proj) => {
      const n = 1 + 10 * (1 - current / (proj || 1));
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

  // Standings order: record, then points for, then waiver order. Returns rosters sorted.
  const pointsFor = (r) => (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100;
  const pointsAgainst = (r) => (r.settings?.fpts_against ?? 0) + (r.settings?.fpts_against_decimal ?? 0) / 100;
  function standings(rosters) {
    return [...rosters].sort((a, b) =>
      (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0) ||
      (b.settings?.ties ?? 0) - (a.settings?.ties ?? 0) ||
      pointsFor(b) - pointsFor(a) ||
      (a.settings?.waiver_position ?? 0) - (b.settings?.waiver_position ?? 0));
  }
  function standingsRanks(rosters, standingsRows) {
    if (standingsRows?.length) return Object.fromEntries(standingsRows.map((s) => [s.roster_id, s.rank]));
    return Object.fromEntries(standings(rosters).map((r, i) => [r.roster_id, i + 1]));
  }

  // "WLLWWLW" -> last five, and the streak as Sleeper shows it ("3W").
  function streak(roster) {
    const s = roster.metadata?.streak;
    if (s) return s;
    const rec = roster.metadata?.record || '';
    const last = rec.at(-1);
    if (!last) return '';
    let n = 0;
    for (let i = rec.length - 1; i >= 0 && rec[i] === last; i--) n++;
    return `${n}${last}`;
  }

  // Waivers, ported from Sleeper's add/drop dialog. waiver_type 2 is FAAB.
  const FAAB = 2;

  function rosterRoom(league, roster) {
    const r = roster || {};
    return (league.roster_positions || []).length - (r.players || []).length + (r.reserve || []).length + (r.taxi || []).length;
  }

  function faabLeft(league, roster) {
    return Math.max(0, (league.settings?.waiver_budget || 0) - (roster?.settings?.waiver_budget_used || 0));
  }

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

  function sortClaims(claims) {
    const bid = (c) => c.settings?.waiver_bid ?? 0;
    const priority = (c) => c.settings?.priority ?? Infinity;
    return [...claims].sort((a, b) =>
      bid(b) - bid(a) || priority(a) - priority(b) || String(a.transaction_id).localeCompare(String(b.transaction_id)));
  }

  // Best guess at whether an unrostered player is on waivers: dropped within the
  // league's waiver_clear_days, or (with waiver_after_game_start) their club
  // has already kicked off this week. Sleeper has the final say when a claim is sent.
  function waiverGuess({ league, playerId, transactions, games, now = Date.now() }) {
    const settings = league.settings || {};
    const clearMs = (settings.waiver_clear_days || 0) * 864e5;
    const dropped = (transactions || []).some((t) =>
      t.status === 'complete' && t.drops?.[playerId] != null && now - (t.status_updated || t.created || 0) < clearMs);
    if (dropped) return 'waiver';
    if (settings.waiver_after_game_start && games?.some((g) => started(g.game, now))) return 'waiver';
    return 'free_agent';
  }

  // Each club's record and recent form from Sleeper's fixture list, which
  // carries a club's record (wins-draws-losses) after every match it has
  // played. Comparing consecutive records gives the result of each match.
  //   -> { [teamId]: { abbr, record: "6-0-1", form: ['W', 'D', ...] (oldest first, last 5) } }
  function clubForms(schedule, last = 5) {
    const byTeam = {};
    const parse = (text) => String(text || '').split('-').map((n) => Number(n) || 0);
    for (const g of schedule || []) {
      if (g.status !== 'complete') continue;
      for (const side of [g.home, g.away]) {
        if (!side?.team) continue;
        (byTeam[side.team] ||= { abbr: side.abbr, games: [] }).games.push({ week: g.week, date: g.date, record: parse(side.record) });
      }
    }
    const out = {};
    for (const [team, { abbr, games }] of Object.entries(byTeam)) {
      games.sort((a, b) => a.week - b.week || String(a.date).localeCompare(String(b.date)));
      let prev = [0, 0, 0];
      const form = [];
      for (const g of games) {
        const [w, d, l] = g.record;
        form.push(w > prev[0] ? 'W' : d > prev[1] ? 'D' : l > prev[2] ? 'L' : '?');
        prev = g.record;
      }
      out[team] = { abbr, record: games.at(-1)?.record.join('-') || '0-0-0', form: form.slice(-last) };
    }
    return out;
  }

  return {
    clubForms,
    gamesFromScores, gamesByTeam, pointsByGame, playerGames, weekTotals, started, finished,
    slotAccepts, fits, reserveEligible, spotOf, spotRefs, swapTargets, applyMove, describeMove,
    parseFormation, savedFormation, slotLabels, formationOf, FORMATION_ORDER,
    cheapestAssignment, solveLineup, bestLineup, winProbability,
    standings, standingsRanks, pointsFor, pointsAgainst, streak,
    FAAB, rosterRoom, faabLeft, claimError, sortClaims, waiverGuess,
  };
})();
