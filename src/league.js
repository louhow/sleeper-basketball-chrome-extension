// League tab: this week's matchups, the standings table and the week's
// transactions, as the mobile app's League tab shows them. Pure: state -> HTML.
(globalThis.SEP ||= {}).league = (() => {
  const { winProbability, standings, pointsFor, pointsAgainst, streak, faabLeft } = globalThis.SEP.model;
  const { esc, f2, teamName, ownerName, avatarImg, record, lineup, teamTotals, weekNav, headshot, positions, owns } = globalThis.SEP.ui;

  function render(s) {
    if (s.error) return `<p class="msg error">${esc(s.error)}</p>`;
    if (!s.rosters || !s.players) return '<p class="msg">Loading…</p>';
    const week = s.weeks?.[s.week];
    return `
      <div class="section-head"><h3>Matchups</h3>${weekNav(s)}</div>
      ${week ? matchups(s, week) : '<p class="msg">Loading week…</p>'}
      <div class="section-head"><h3>Standings</h3></div>
      ${standingsTable(s)}
      <div class="section-head"><h3>Transactions <span class="sub">week ${s.week}</span></h3></div>
      ${week ? transactions(s, week) : ''}`;
  }

  // Pairs from the logged-in matchup legs; without them there's nothing to pair.
  function matchups(s, week) {
    const legs = week.legs;
    if (!legs) return `<p class="msg">${s.loggedIn ? 'Matchups for this week aren\'t available.' : 'Log in to Sleeper to see matchups.'}</p>`;
    const byMatch = new Map();
    for (const leg of legs) {
      if (leg.matchup_id == null) continue;
      (byMatch.get(leg.matchup_id) || byMatch.set(leg.matchup_id, []).get(leg.matchup_id)).push(leg.roster_id);
    }
    const pairs = [...byMatch.entries()].sort((a, b) => a[0] - b[0]);
    if (!pairs.length) return '<p class="msg">No matchups this week.</p>';
    return `<div class="mu-list">${pairs.map(([, ids]) => pair(s, ids)).join('')}</div>`;
  }

  function pair(s, [a, b]) {
    const la = lineup(s, a);
    const lb = b != null ? lineup(s, b) : null;
    if (!la) return '';
    const ta = teamTotals(s, la);
    const tb = lb && teamTotals(s, lb);
    const [p1, p2] = tb ? winProbability(ta.points, ta.proj, tb.points, tb.proj) : [null, null];
    const side = (l, t, p, cls) => {
      const pctValue = p == null ? null : Math.round(p * 100);
      const trend = pctValue == null ? '' : pctValue >= 50 ? 'up' : 'down';
      const rank = s.weeks[s.week]?.ranks?.[l.roster.roster_id];
      const mine = owns(s, l.roster);
      return `<div class="mu-team ${cls}${mine ? ' is-mine' : ''}" data-roster="${l.roster.roster_id}" role="button" tabindex="0">
        ${avatarImg(s, l.roster)}
        <div class="mu-who"><div class="team-name">${esc(teamName(s, l.roster))}</div><div class="sub">@${esc(ownerName(s, l.roster))} · ${record(l.roster)}${rank ? ` (#${rank})` : ''}</div></div>
        <div class="mu-pts"><b>${t.anyPoints ? f2(t.points) : '–'}</b><span>${f2(t.proj)}</span></div>
        <div class="mu-bar"><span class="${trend}" style="width:${pctValue ?? 0}%"></span></div>
        <div class="mu-meta">${pctValue == null ? '' : `<b class="${trend}">${pctValue}% WIN</b>`}<span class="ytp">Yet to play (${t.yetToPlay})</span></div>
      </div>`;
    };
    return `<section class="mu-head">
      ${side(la, ta, p1, 'mine')}
      <div class="vs">VS</div>
      ${lb ? side(lb, tb, p2, 'theirs') : '<div class="mu-team theirs bye"><span class="sub">Bye</span></div>'}
    </section>`;
  }

  function standingsTable(s) {
    const rows = standings(s.rosters);
    const faab = s.league.settings?.waiver_type === 2;
    return `<table class="standings">
      <thead><tr><th>Rank</th><th>Name</th><th class="num">${faab ? 'Waiver' : 'Priority'}</th><th class="num">PF</th><th class="num">PA</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${owns(s, r) ? 'is-mine' : ''}${r.roster_id === s.rosterId ? ' shown' : ''}" data-roster="${r.roster_id}">
        <td class="rank">${i + 1}</td>
        <td class="name-cell">${avatarImg(s, r, 'avatar small')}<div><div class="team-name">${esc(teamName(s, r))}</div><div class="sub">@${esc(ownerName(s, r))} · ${record(r)} · ${esc(streak(r))}</div></div></td>
        <td class="num">${faab ? `$${faabLeft(s.league, r)}` : ''} <span class="sub">(${r.settings?.waiver_position ?? '–'})</span></td>
        <td class="num">${f2(pointsFor(r))}</td>
        <td class="num">${f2(pointsAgainst(r))}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function transactions(s, week) {
    const list = week.transactions;
    if (list == null) return '<p class="msg">Loading…</p>';
    if (!list.length) return '<p class="msg">No transactions this week.</p>';
    const byRoster = Object.fromEntries(s.rosters.map((r) => [r.roster_id, r]));
    const player = (id, sign) => {
      const p = s.players[id] || { name: `Player #${id}`, positions: [] };
      return `<div class="cp ${sign === '+' ? 'add' : 'drop'}"><span class="sign">${sign}</span><img class="headshot" src="${headshot(id)}" alt="" data-player="${esc(id)}"><span class="cp-name"><button class="name" data-player="${esc(id)}">${esc(p.name)}</button> ${positions(p)}<span class="team">• ${esc(p.teamAbbr || 'FA')}</span></span></div>`;
    };
    const items = [...list].sort((a, b) => (b.status_updated || b.created) - (a.status_updated || a.created)).map((t) => {
      const who = (t.roster_ids || []).map((id) => teamName(s, byRoster[id])).join(' ↔ ');
      const kind = t.type === 'waiver' ? 'waiver claim' : t.type === 'free_agent' ? 'free agent move' : t.type;
      const bid = t.settings?.waiver_bid != null ? ` · $${t.settings.waiver_bid}` : '';
      const failed = t.status !== 'complete' ? ` <span class="status bad">${esc(t.status)}</span>` : '';
      const when = new Date(t.status_updated || t.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `<li class="tx">
        <div class="tx-head"><b>${esc(who)}</b> <span class="sub">${esc(kind)}${bid} · ${esc(when)}</span>${failed}</div>
        <div class="tx-players">${Object.keys(t.adds || {}).map((id) => player(id, '+')).join('')}${Object.keys(t.drops || {}).map((id) => player(id, '−')).join('')}</div>
        ${t.metadata?.notes ? `<div class="sub">${esc(t.metadata.notes)}</div>` : ''}
      </li>`;
    });
    return `<ul class="txs">${items.join('')}</ul>`;
  }

  return { render };
})();
