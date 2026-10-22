// Team tab, laid out like the mobile app: team card, lineup by slot with each
// player's match and points, then bench and injured reserve. Pure: state -> HTML.
(globalThis.SEP ||= {}).team = (() => {
  const { playerGames, weekTotals, spotRefs, swapTargets, reserveEligible } = globalThis.SEP.model;
  const { esc, f2, teamName, ownerName, avatarImg, record, slotBadge, weekNav, lineup, teamTotals, reserveRule, nextGameText, gameChips, playerLine, pct, myRoster } = globalThis.SEP.ui;

  function render(s) {
    if (s.error) return `<p class="msg error">${esc(s.error)}</p>`;
    const l = lineup(s);
    if (!l) return '<p class="msg">Loading…</p>';
    if (!l.week) return `${teamCard(s, l)}<p class="msg">Loading week…</p>`;
    const { editable } = l;
    const targets = new Set(editable && s.swap ? swapTargets(s.swap, l) : []);
    const movable = new Set(editable ? spotRefs(l).filter((ref) => swapTargets(ref, l).length) : []);
    const ctx = { s, l, movable, targets, editable: editable && !s.saving, selecting: Boolean(editable && s.swap) };
    const picked = s.swap && s.players[spotId(s.swap, l.starters)];
    const hint = !editable ? (l.mine ? 'This week can no longer be edited' : '')
      : s.saving ? 'Saving lineup…'
      : picked ? `Pick a player to swap with ${esc(picked.name)} · Esc to cancel`
      : s.swap ? 'Pick a player for this spot · Esc to cancel'
      : 'Tap a position badge to update your lineup';
    return `${teamCard(s, l)}${sections(ctx, hint)}`;
  }

  function spotId(ref, starters) {
    const [kind, key] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    if (kind === 's') return starters[Number(key)];
    return kind === 'b' || kind === 'r' ? key : null;
  }

  function teamCard(s, l) {
    const { roster } = l;
    const totals = l.week ? teamTotals(s, l) : null;
    const owner = ownerName(s, roster);
    const name = teamName(s, roster);
    const claims = s.claims?.length || 0;
    const mine = l.mine;
    return `<section class="team-card">
      ${avatarImg(s, roster)}
      <div class="who">
        <div class="team-name">${esc(name)}</div>
        <div class="sub">${owner && owner !== name ? `@${esc(owner)} · ` : ''}${record(roster)}${roster.settings?.waiver_position ? ` · waiver #${roster.settings.waiver_position}` : ''}</div>
      </div>
      <div class="score">
        <div class="pts">${totals?.anyPoints ? f2(totals.points) : '–'}</div>
        <div class="sub">proj ${totals ? f2(totals.proj) : '–'}</div>
      </div>
      <div class="team-actions">
        <button data-page="players" title="Find players to add">+ Players</button>
        ${mine ? `<button data-action="claims" title="Pending waiver claims">Waivers${claims ? ` <span class="count">${claims}</span>` : ''}</button>` : ''}
        ${l.editable && l.week ? `<button class="optimize" data-action="optimize" title="Propose the best starting lineup for this week" ${s.saving ? 'disabled' : ''}>Optimize</button>` : ''}
      </div>
    </section>`;
  }

  function sectionHead(title, hint, right = '') {
    return `<div class="rhead">
      <div class="rtitle"><h3>${esc(title)}</h3>${hint ? `<div class="hint">${hint}</div>` : ''}</div>
      ${right}
    </div>`;
  }

  function sections(ctx, hint) {
    const { s, l } = ctx;
    const settings = s.league.settings || {};
    const card = (slot, id, spot, label) => playerCard(ctx, slot, id, spot, label);
    const padded = (ids, count) => [...ids, ...Array(Math.max(0, (count || 0) - ids.length)).fill('0')];
    const openSpots = (prefix, n, slot) => Array.from({ length: n }, (_, k) => card(slot, '0', `${prefix}:${k}`)).join('');
    const reserveCards = l.reserveEditable
      ? l.reserve.map((id) => card('IR', id, `r:${id}`)).join('') + openSpots('re', l.reserveRoom, 'IR')
      : padded(l.reserve, settings.reserve_slots).map((id) => card('IR', id)).join('');
    const benchCards = l.bench.map((id) => card('BN', id, `b:${id}`)).join('') + (l.reserveEditable ? openSpots('be', l.benchRoom, 'BN') : '');
    const lineupHead = `<div class="rhead lineup-head">
      <div class="rtitle"><h3>Lineup <span class="formation" title="Formation (defenders-midfielders-forwards)">${esc(l.formation)}</span></h3>${hint ? `<div class="hint">${hint}</div>` : ''}</div>
      ${weekNav(s)}
    </div>`;
    return `
      ${lineupHead}
      <div class="rcols"><span>Pos</span><span>Player</span><span class="rc-match">Match</span><span class="rc-pts">Pts</span></div>
      ${l.starters.map((id, i) => card(l.slots[i] ?? 'FLEX', id, `s:${i}`, l.labels[i])).join('')}
      ${benchCards ? `${sectionHead('Bench')}${benchCards}` : ''}
      ${l.reserve.length || settings.reserve_slots ? `${sectionHead('Injured Reserve', l.reserveEditable ? esc(reserveRule(settings)) : '')}${reserveCards}` : ''}`;
  }

  function cardClass({ s, editable, selecting, targets }, spot) {
    if (!editable || !spot) return '';
    if (s.swap === spot) return ' selected';
    if (selecting) return targets.has(spot) ? ' target' : ' dim';
    return '';
  }

  function playerCard(ctx, slot, id, spot, label) {
    const { s, l, editable, movable } = ctx;
    const button = editable && spot && (movable.has(spot) || s.swap === spot) ? spot : null;
    const cls = cardClass(ctx, spot);
    if (!id || id === '0') {
      return `<article class="card empty${cls}">${slotBadge(slot, button, label)}<div class="headshot"></div><div class="info"><span class="name">Empty</span></div></article>`;
    }
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const games = playerGames(l.week, p.team, id);
    const t = weekTotals(games, s.now);
    const research = l.week.research?.[id];
    const locked = l.locked.has(id);
    const sub = `<span title="Started and rostered in leagues like this one"><b>${pct(research?.started)}</b> Start · <b>${pct(research?.owned)}</b> Rostered</span>`;
    return `<article class="card${cls}${locked ? ' locked' : ''}">
      ${slotBadge(slot, button, label)}
      ${playerLine(s, id, { sub })}
      <div class="match">
        <span class="when">${esc(nextGameText(games, s.now))}</span>
        <span class="chips">${gameChips(games, s.now)}</span>
      </div>
      <div class="week-pts">
        <b>${t.played ? f2(t.points) : '–'}</b>
        <span>${t.any ? `proj ${f2(t.proj)}` : 'no match'}</span>
      </div>
    </article>`;
  }

  return { render, teamCard };
})();
