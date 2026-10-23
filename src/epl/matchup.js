// Match tab: the selected team (left) against its opponent (right), slot by
// slot, with win probability and each player's match. Pure: state -> HTML.
(globalThis.SEP ||= {}).matchup = (() => {
  const { playerGames, weekTotals, winProbability, started } = globalThis.SEP.model;
  const { breakdown } = globalThis.SEP.scoring;
  const { esc, f2, teamName, ownerName, avatarImg, record, shortName, injuryTag, positions, headshot, slotBadge, weekNav, lineup, teamTotals, gameChips, weekday, gameTime, roleName } = globalThis.SEP.ui;

  function render(s) {
    if (s.error) return `<p class="msg error">${esc(s.error)}</p>`;
    const mine = lineup(s);
    if (!mine) return '<p class="msg">Loading…</p>';
    if (!mine.week) return `<div class="section-head"><h3>Match</h3>${weekNav(s)}</div><p class="msg">Loading week…</p>`;
    const oppId = opponentOf(mine);
    const theirs = oppId != null ? lineup(s, oppId) : null;
    const left = { l: mine, ...teamTotals(s, mine) };
    const right = theirs && { l: theirs, ...teamTotals(s, theirs) };
    const [p1, p2] = right ? winProbability(left.points, left.proj, right.points, right.proj) : [null, null];
    const settings = s.league.settings || {};
    const rows = (title, a, b, slot, count = 0) => {
      const n = Math.max(a.length, b.length, count);
      if (!n) return '';
      return `<h3 class="mu-title">${title}</h3>${Array.from({ length: n }, (_, i) => row(s, slot, left, a[i], right, b[i], null)).join('')}`;
    };
    const noLegs = s.loggedIn && mine.week.legs == null && s.week <= s.currentWeek;
    return `
      <section class="mu-head">
        ${teamSide(s, left, p1, 'mine')}
        <div class="vs">VS</div>
        ${right ? teamSide(s, right, p2, 'theirs') : `<div class="mu-team theirs bye"><span class="sub">${s.loggedIn ? 'No opponent this week' : 'Log in to Sleeper to see this week\'s matchup'}</span></div>`}
      </section>
      ${noLegs ? '<p class="hint center">Matchup pairings come from Sleeper\'s logged-in API, which didn\'t answer; showing the roster\'s saved lineup.</p>' : ''}
      <div class="mu-starters">
        <div><h3>Starters</h3></div>
        ${weekNav(s)}
      </div>
      <div class="mu-forms"><b class="mine">${esc(mine.formation)}</b><span class="sub">Formation</span><b class="theirs">${theirs ? esc(theirs.formation) : '–'}</b></div>
      ${Array.from({ length: Math.max(mine.order.length, theirs?.order.length || 0) }, (_, k) => {
        const i = mine.order[k];
        const j = theirs?.order[k];
        return pairRow(s, left, i, right, j);
      }).join('')}
      ${rows('Bench', mine.bench, theirs?.bench || [], 'BN')}
      ${rows('Injured Reserve', mine.reserve, theirs?.reserve || [], 'IR', settings.reserve_slots)}`;
  }

  function opponentOf(l) {
    const own = l.leg;
    if (own?.matchup_id == null) return null;
    return l.week.legs.find((m) => m.matchup_id === own.matchup_id && m.roster_id !== l.roster.roster_id)?.roster_id ?? null;
  }

  function teamSide(s, sd, prob, cls) {
    const { roster } = sd.l;
    const pctValue = prob == null ? null : Math.round(prob * 100);
    const trend = pctValue == null ? '' : pctValue >= 50 ? 'up' : 'down';
    const rank = sd.l.week.ranks?.[roster.roster_id];
    return `<div class="mu-team ${cls}">
      ${avatarImg(s, roster)}
      <div class="mu-who">
        <div class="team-name">${esc(teamName(s, roster))}</div>
        <div class="sub">@${esc(ownerName(s, roster) || 'unknown')} · ${record(roster)}${rank ? ` (#${rank})` : ''}</div>
      </div>
      <div class="mu-pts"><b>${sd.anyPoints ? f2(sd.points) : '–'}</b><span>${f2(sd.proj)}</span></div>
      <div class="mu-bar"><span class="${trend}" style="width:${pctValue ?? 0}%"></span></div>
      <div class="mu-meta">
        ${pctValue == null ? '' : `<b class="${trend}">${pctValue}% WIN</b>`}
        <span class="ytp">Yet to play (${sd.yetToPlay})</span>
      </div>
    </div>`;
  }

  // One row of starters: each side's k-th player in its own formation order.
  // The badge shows both roles when the formations put different ones side by side.
  function pairRow(s, left, i, right, j) {
    const a = left.l;
    const b = right?.l;
    const labelA = i == null ? null : a.labels[i];
    const labelB = j == null ? null : b.labels[j];
    const slotA = i == null ? null : a.slots[i];
    const badge = labelA && labelB && labelA !== labelB
      ? `<span class="slot pair" title="${esc(`${labelA} vs ${labelB}`)}"><b class="${esc(labelA.toLowerCase())}">${esc(labelA)}</b><b class="${esc(labelB.toLowerCase())}">${esc(labelB)}</b></span>`
      : slotBadge(slotA || b.slots[j], null, labelA || labelB);
    return `<div class="mu-row">
      ${i == null ? '<div class="mp mine empty"></div>' : playerSide(s, left, a.starters[i], 'mine')}
      ${badge}
      ${right && j != null ? playerSide(s, right, b.starters[j], 'theirs') : '<div class="mp theirs empty"></div>'}
    </div>`;
  }

  function row(s, slot, left, idA, right, idB, label) {
    return `<div class="mu-row">
      ${playerSide(s, left, idA, 'mine')}
      ${slotBadge(slot, null, label)}
      ${right ? playerSide(s, right, idB, 'theirs') : '<div class="mp theirs empty"></div>'}
    </div>`;
  }

  function matchText(games, now) {
    const next = games.find((g) => !started(g.game, now) || g.game.status === 'in_game');
    if (!games.length) return ['No match', ''];
    if (!next) {
      const last = games.at(-1);
      return [`${last.home ? 'vs' : '@'} ${last.opponentAbbr}`, 'Final'];
    }
    const live = next.game.status === 'in_game' || (started(next.game, now) && next.game.status !== 'complete');
    return [`${next.home ? 'vs' : '@'} ${next.opponentAbbr}`, live ? 'Live' : next.game.start ? `${weekday(next.game.date)} ${gameTime(next.game.start)}` : weekday(next.game.date)];
  }

  // Stat abbreviations as the app prints them where they differ from Sleeper's keys.
  const STAT_ABBR = { at: 'AST', sm: 'DRB', acnc: 'AC', yc2: 'YC2', hcs: 'HCS' };

  // The scoring stats behind a played match, biggest first: "2 G, 3 KP, 1 AER".
  function statLine(s, games) {
    const totals = {};
    for (const g of games) {
      if (!g.played || !g.stats) continue;
      for (const part of breakdown(s.league.scoring_settings || {}, g.stats)) {
        const t = (totals[part.stat] ||= { value: 0, points: 0 });
        t.value += part.value;
        t.points += part.points;
      }
    }
    return Object.entries(totals)
      .filter(([stat]) => stat !== 'min')
      .sort((x, y) => Math.abs(y[1].points) - Math.abs(x[1].points))
      .slice(0, 5)
      .map(([stat, t]) => `${Number.isInteger(t.value) ? t.value : t.value.toFixed(1)} ${STAT_ABBR[stat] || stat.toUpperCase()}`)
      .join(', ');
  }

  function playerSide(s, sd, id, cls) {
    if (!id || id === '0') return `<div class="mp ${cls} empty"><div class="headshot"></div><div class="mp-id"><span class="name">Empty</span></div></div>`;
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const st = sd.games[id] ?? (() => {
      const games = playerGames(sd.l.week, p.team, id);
      return { games, ...weekTotals(games, s.now) };
    })();
    const [opp, when] = matchText(st.games, s.now);
    const who = `<span class="mp-who">${positions(p)}<span class="team">• ${esc(p.teamAbbr || 'FA')}</span></span>`;
    const chips = `<span class="mp-games">${gameChips(st.games, s.now)}</span>`;
    return `<div class="mp ${cls}${st.live ? ' live' : ''}">
      <img class="headshot" src="${headshot(id)}" alt="" data-player="${esc(id)}">
      <div class="mp-id">
        <div class="name"><button class="name" data-player="${esc(id)}">${esc(shortName(p))}</button>${injuryTag(p)}</div>
        <div class="sub">${cls === 'theirs' ? `${chips}${who}` : `${who}${chips}`}</div>
        ${st.played ? `<div class="mp-stats sub">${esc(statLine(s, st.games) || 'No scoring stats')}</div>` : ''}
      </div>
      <div class="mp-game"><b>${esc(opp)}</b><span class="sub">${esc(when)}</span></div>
      <div class="mp-pts"><b>${st.played ? f2(st.points) : '–'}</b><span>${st.any ? f2(st.proj) : ''}</span></div>
    </div>`;
  }

  return { render };
})();
