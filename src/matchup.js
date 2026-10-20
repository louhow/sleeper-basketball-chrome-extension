// Matchup view: the selected team (left) against its opponent (right), slot by
// slot, with Lock-In status and the lock control for the logged-in owner.
(globalThis.SNP ||= {}).matchup = (() => {
  const { playerDays, lockState, lockInDefault, winProbability } = globalThis.SNP.model;
  const { esc, f2, headshot, teamLogo, teamName, avatar, record, shortName, injuryTag, positions, gameTime, weekday, slotBadge, weekNav, lineup } =
    globalThis.SNP.ui;

  function render(s) {
    if (s.error) return `<p class="msg error">${esc(s.error)}</p>`;
    const mine = lineup(s);
    if (!mine) return '<p class="msg">Loading…</p>';
    if (!mine.week) return `<div class="section-head"><h3>Starters</h3>${weekNav(s, null)}</div><p class="msg">Loading week…</p>`;

    const oppId = opponentOf(mine);
    const theirs = oppId != null ? lineup(s, oppId) : null;
    const left = side(s, mine);
    const right = theirs && side(s, theirs);
    const [p1, p2] = right ? winProbability(left.points, left.proj, right.points, right.proj) : [null, null];
    const settings = s.league.settings || {};
    const rows = (title, slotFor, a, b, count = 0) => {
      const n = Math.max(a.length, b.length, count);
      if (!n) return '';
      return `<h3>${title}</h3>${Array.from({ length: n }, (_, i) => row(s, slotFor(i), left, a[i], right, b[i], false)).join('')}`;
    };

    return `
      <section class="mu-head">
        ${teamSide(s, left, p1, 'mine')}
        <div class="vs">VS</div>
        ${right ? teamSide(s, right, p2, 'theirs') : '<div class="mu-team theirs bye"><span class="sub">No opponent this week</span></div>'}
      </section>
      <div class="ytp">
        <div><b>Yet to play (${left.yetToPlay})</b></div>
        ${right ? `<div><b>Yet to play (${right.yetToPlay})</b></div>` : ''}
      </div>
      <div class="section-head">
        <div>
          <h3>Starters</h3>
          ${mine.lockable ? `<div class="hint">${s.saving ? 'Saving…' : 'Lock in a finished game before the player\'s next game starts'}</div>` : ''}
        </div>
        ${weekNav(s, mine.week)}
      </div>
      ${mine.slots.map((slot, i) => row(s, slot, left, mine.starters[i], right, theirs?.starters[i], true)).join('')}
      ${rows('Bench', () => 'BN', mine.bench, theirs?.bench || [])}
      ${rows('Injured Reserve', () => 'IR', mine.reserve, theirs?.reserve || [], settings.reserve_slots)}
      ${rows('Taxi Squad', () => 'TX', mine.taxi, theirs?.taxi || [], settings.taxi_slots)}`;
  }

  function opponentOf(l) {
    const own = l.leg ?? l.matchup;
    if (own?.matchup_id == null) return null;
    const pool = l.leg ? l.week.legs : l.week.matchups;
    return pool.find((m) => m.matchup_id === own.matchup_id && m.roster_id !== l.roster.roster_id)?.roster_id ?? null;
  }

  // Team totals. Sleeper's own leg numbers win when logged in; otherwise they're
  // rebuilt from Lock-In rules (locked game, else the final game of the week).
  function side(s, l) {
    const states = {};
    for (const id of l.starters) {
      if (!id || id === '0') continue;
      const days = playerDays(l.week, s.players[id]?.team, id);
      states[id] = { days, ...lockState(days, l.locks[id], s.now) };
    }
    const all = Object.values(states);
    const counted = all.reduce((sum, st) => sum + (st.points ?? 0), 0);
    const projected = all.reduce((sum, st) => sum + (st.counted ? st.points : lockInDefault(st.days) ?? 0), 0);
    const points = l.leg
      ? l.leg.custom_points ?? l.leg.points ?? counted
      : l.matchup?.custom_points ?? l.matchup?.points ?? counted;
    return {
      l,
      states,
      points: points ?? 0,
      anyPoints: all.some((st) => st.counted) || Boolean(l.leg?.points ?? l.matchup?.points),
      proj: l.leg?.proj_points ?? projected,
      yetToPlay: all.filter((st) => st.yetToPlay).length,
    };
  }

  function teamSide(s, sd, prob, cls) {
    const { roster } = sd.l;
    const owner = s.usersById?.[roster.owner_id];
    const image = avatar(s, roster);
    const pct = prob == null ? null : Math.round(prob * 100);
    const trend = pct == null ? '' : pct >= 50 ? 'up' : 'down';
    const rank = sd.l.week.ranks?.[roster.roster_id];
    return `<div class="mu-team ${cls}">
      ${image ? `<img class="avatar" src="${esc(image)}" alt="">` : '<div class="avatar"></div>'}
      <div class="mu-who">
        <div class="sub">@${esc(owner?.display_name || 'unknown')}</div>
        <div class="team-name">${esc(teamName(s, roster))}</div>
      </div>
      <div class="mu-pts">${sd.anyPoints ? f2(sd.points) : '–'}</div>
      <div class="mu-bar"><span class="${trend}" style="width:${pct ?? 0}%"></span></div>
      <div class="mu-meta">
        ${pct == null ? '' : `<b class="${trend}">${pct}% WIN</b>`}
        <span>${record(roster)}${rank ? ` (#${rank})` : ''}</span>
        <span class="proj">${f2(sd.proj)}</span>
      </div>
    </div>`;
  }

  function row(s, slot, left, idA, right, idB, starter) {
    return `<div class="mu-row">
      ${playerSide(s, left, idA, 'mine', starter)}
      ${slotBadge(slot)}
      ${right ? playerSide(s, right, idB, 'theirs', starter) : '<div class="mp theirs empty"></div>'}
    </div>`;
  }

  function playerSide(s, sd, id, cls, starter) {
    if (!id || id === '0') return `<div class="mp ${cls} empty"><span class="name">Empty</span></div>`;
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const st = sd.states[id] ?? (() => {
      const days = playerDays(sd.l.week, p.team, id);
      return { days, ...lockState(days, sd.l.locks[id], s.now) };
    })();
    const cur = st.current;
    const curDone = cur?.game.status === 'complete';
    const curValue = cur ? (curDone || cur.actual != null ? cur.actual ?? 0 : cur.proj) : null;
    return `<div class="mp ${cls}${st.locked ? ' is-locked' : ''}">
      <div class="mp-head">
        <img class="headshot" src="${headshot(id)}" alt="">
        <div class="mp-id">
          <div class="name">${esc(shortName(p))}${injuryTag(p)}</div>
          <div class="sub">${positions(p)} <span class="team">• ${esc(p.team || 'FA')}</span></div>
        </div>
        <div class="mp-pts">${starter && st.counted ? f2(st.points) : '–'}</div>
      </div>
      <div class="mp-box">
        <div class="mp-game">
          ${cur ? `<b>${cur.home ? 'vs' : '@'} ${esc(cur.opponent)}</b>
            <span class="sub">${esc(status(cur))}</span>` : '<span class="sub">No games this week</span>'}
        </div>
        <div class="mp-val">
          <span class="sub">${cur ? (curDone ? 'pts' : 'proj') : ''}</span>
          <b>${f2(curValue)}</b>
        </div>
        ${starter ? lockControl(s, sd, id, st) : ''}
      </div>
      <div class="mp-games">${st.games.map((d) => gameChip(d, st)).join('')}</div>
    </div>`;
  }

  function status(d) {
    const day = weekday(d.date);
    if (d.game.status === 'complete') return `Final · ${day}`;
    if (d.game.status === 'in_game') return `Live · ${day}`;
    return d.game.start ? `${day} ${gameTime(d.game.start)}` : day;
  }

  function lockControl(s, sd, id, st) {
    if (st.locked) return '<span class="lk locked">🔒 LOCKED</span>';
    if (!sd.l.lockable) return '<span class="lk">NOT LOCKED</span>';
    if (!st.lockable) {
      return '<button class="lk" disabled title="Opens once a game ends, until the player\'s next game starts">🔓 LOCK-IN</button>';
    }
    const value = f2(st.current?.actual ?? 0);
    const ref = `${sd.l.roster.roster_id}:${id}`;
    if (s.lockConfirm === ref) {
      return `<span class="lk-confirm">
        <button class="lk go" data-lock-confirm="${esc(ref)}" ${s.saving ? 'disabled' : ''}>Lock ${value}</button>
        <button class="lk cancel" data-lock-cancel aria-label="Cancel">✕</button>
      </span>`;
    }
    return `<button class="lk open" data-lock="${esc(ref)}" ${s.saving ? 'disabled' : ''} title="Lock in ${esc(status(st.current))}">🔓 LOCK-IN</button>`;
  }

  function gameChip(d, st) {
    const cls = [
      d.game.status === 'complete' ? 'done' : '',
      d === st.current ? 'current' : '',
      d === st.locked ? 'locked' : '',
    ].filter(Boolean).join(' ');
    const label = `${weekday(d.date)} ${d.home ? 'vs' : '@'} ${d.opponent}`;
    return `<span class="chip ${cls}" title="${esc(label)}"><img src="${teamLogo(d.opponent)}" alt="${esc(d.opponent)}"></span>`;
  }

  return { render };
})();
