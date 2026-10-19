// Pure render functions: (state, api log) -> HTML string for the shadow root.
(globalThis.SNP ||= {}).view = (() => {
  const { playerDays, lockInDefault, spotRefs, swapTargets, lockedGameId } = globalThis.SNP.model;
  const { esc, f2, headshot, teamName, avatar, record, injuryTag, positions, gameTime, weekday, slotBadge, weekNav, notice, lineup, taxiRule } =
    globalThis.SNP.ui;
  const PREVIEW_CHARS = 20000;
  const PAGES = { team: 'Team', matchup: 'Matchup' };

  function render(state, log) {
    const body = state.tab === 'api' ? apiView(state, log)
      : state.page === 'matchup' ? globalThis.SNP.matchup.render(state)
      : teamView(state);
    // The notice floats over the panel so showing or clearing it never shifts the cards being clicked.
    return `<div class="app">${toolbar(state, log)}<div class="body">${body}</div>${state.tab === 'api' ? '' : notice(state)}</div>`;
  }

  function toolbar(s, log) {
    const tab = (id, label) =>
      `<button role="tab" data-tab="${id}" aria-selected="${s.tab === id}" class="${s.tab === id ? 'active' : ''}">${label}</button>`;
    const options = (s.rosters || [])
      .map((r) => `<option value="${r.roster_id}" ${r.roster_id === s.rosterId ? 'selected' : ''}>${esc(teamName(s, r))}</option>`)
      .join('');
    return `<nav class="toolbar">
      <div class="tabs" role="tablist">${tab('page', PAGES[s.page] || 'Team')}${tab('api', `API calls <span class="count">${log.length}</span>`)}</div>
      <div class="tools">
        ${options ? `<select data-action="roster" aria-label="Team to show">${options}</select>` : ''}
        <button class="icon" data-action="refresh" title="Refetch everything" aria-label="Refresh">↻</button>
      </div>
    </nav>`;
  }

  function teamView(s) {
    if (s.error) return `<p class="msg error">${esc(s.error)}</p>`;
    const l = lineup(s);
    if (!l) return '<p class="msg">Loading…</p>';
    const { roster, week, leg, matchup, starters, editable } = l;
    const targets = new Set(editable && s.swap ? swapTargets(s.swap, l) : []);
    // Only spots with somewhere to go get a button, so nothing is a dead click.
    const movable = new Set(editable ? spotRefs(l).filter((ref) => swapTargets(ref, l).length) : []);
    const ctx = {
      movable,
      s,
      week,
      points: matchup?.players_points || {},
      locks: l.locks,
      editable: editable && !s.saving,
      selecting: Boolean(editable && s.swap),
      targets,
    };

    const picked = s.swap && s.players[spotId(s.swap, starters)];

    return `
      ${teamCard(s, roster, week, matchup, leg, starters)}
      <div class="section-head">
        <div>
          <h3>Starters</h3>
          ${editable ? `<div class="hint">${s.saving ? 'Saving lineup…'
            : picked ? `Pick a player to swap with ${esc(picked.name)} · Esc to cancel`
            : s.swap ? 'Pick a player for this slot · Esc to cancel'
            : 'Tap on a position button to update your lineup'}</div>` : ''}
        </div>
        ${weekNav(s, week)}
      </div>
      ${week ? rosterSections(ctx, l) : '<p class="msg">Loading week…</p>'}`;
  }

  // Every player card needs the week's schedule, so these only render once it's loaded.
  function rosterSections(ctx, l) {
    const { s } = ctx;
    const { slots, starters, bench, taxi, reserve, taxiEditable } = l;
    const settings = s.league.settings || {};
    const card = (slot, id, spot) => playerCard(ctx, slot, id, spot);
    const padded = (ids, count) => [...ids, ...Array(Math.max(0, (count || 0) - ids.length)).fill('0')];
    const openSpots = (prefix, n, slot) => Array.from({ length: n }, (_, k) => card(slot, '0', `${prefix}:${k}`)).join('');
    const taxiCards = taxiEditable
      ? taxi.map((id) => card('TX', id, `t:${id}`)).join('') + openSpots('te', l.taxiRoom, 'TX')
      : padded(taxi, settings.taxi_slots).map((id) => card('TX', id)).join('');
    const benchCards = bench.map((id) => card('BN', id, `b:${id}`)).join('') + (taxiEditable ? openSpots('be', l.benchRoom, 'BN') : '');
    return `
      ${starters.map((id, i) => card(slots[i] ?? 'UTIL', id, `s:${i}`)).join('')}
      ${benchCards ? `<h3>Bench</h3>${benchCards}` : ''}
      ${reserve.length || settings.reserve_slots ? `<h3>Injured Reserve</h3>${padded(reserve, settings.reserve_slots).map((id) => card('IR', id)).join('')}` : ''}
      ${taxi.length || settings.taxi_slots ? `<div class="section-head taxi-head"><div><h3>Taxi Squad</h3>
        ${taxiEditable ? `<div class="hint">${esc(taxiRule(l))}</div>` : ''}</div></div>${taxiCards}` : ''}
      ${picksView(s)}`;
  }

  // The player in a spot ref (see model.spotOf), or null for an open spot.
  function spotId(ref, starters) {
    const [kind, key] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    if (kind === 's') return starters[Number(key)];
    return kind === 'b' || kind === 't' ? key : null;
  }

  function teamCard(s, roster, week, matchup, leg, starters) {
    const owner = s.usersById?.[roster.owner_id];
    const image = avatar(s, roster);
    const proj = leg?.proj_points ??
      (week && starters.reduce((sum, id) => sum + (lockInDefault(playerDays(week, s.players[id]?.team, id)) ?? 0), 0));
    const points = leg?.custom_points ?? leg?.points ?? matchup?.custom_points ?? matchup?.points;
    const opp = matchup?.matchup_id != null &&
      week.matchups.find((m) => m.matchup_id === matchup.matchup_id && m.roster_id !== roster.roster_id);
    const oppRoster = opp && s.rosters.find((r) => r.roster_id === opp.roster_id);
    const name = teamName(s, roster);
    return `<section class="team-card">
      ${image ? `<img class="avatar" src="${esc(image)}" alt="">` : '<div class="avatar"></div>'}
      <div class="who">
        <div class="team-name">${esc(name)}</div>
        <div class="sub">${owner && owner.display_name !== name ? `${esc(owner.display_name)} · ` : ''}${record(roster)}</div>
      </div>
      <div class="score">
        <div class="pts">${points ? f2(points) : '–'}</div>
        <div class="sub">proj ${f2(proj)}</div>
        ${oppRoster ? `<div class="sub">vs ${esc(teamName(s, oppRoster))}</div>` : ''}
      </div>
    </section>`;
  }

  function cardClass({ s, editable, selecting, targets }, spot) {
    if (!editable || !spot) return '';
    if (s.swap === spot) return ' selected';
    if (selecting) return targets.has(spot) ? ' target' : ' dim';
    return '';
  }

  function playerCard(ctx, slot, id, spot) {
    const { s, week, points, locks, editable, movable } = ctx;
    const button = editable && spot && (movable.has(spot) || s.swap === spot) ? spot : null;
    const cls = cardClass(ctx, spot);
    if (!id || id === '0') {
      return `<article class="card empty${cls}"><div class="top">${slotBadge(slot, button)}<div class="info"><span class="name">Empty</span></div></div></article>`;
    }
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const locked = lockedGameId(locks[id]);
    const days = playerDays(week, p.team, id).map((d) => ({ ...d, locked: locked != null && String(d.game?.id) === String(locked) }));
    const lockedDay = days.find((d) => d.locked);
    const research = week.research[id];
    const pct = (n) => (n == null ? '–' : `${Math.ceil(n)}%`);
    return `<article class="card${cls}">
      <div class="top">
        ${slotBadge(slot, button)}
        <img class="headshot" src="${headshot(id)}" alt="" loading="lazy">
        <div class="info">
          <div class="line1">
            <span class="name">${esc(p.name)}</span>
            ${positions(p)}
            <span class="team">- ${esc(p.team || 'FA')}</span>${injuryTag(p)}
          </div>
          <div class="line2"><b>${pct(research?.owned)}</b> Rostered <span class="bar">|</span> <b>${pct(research?.started)}</b> Start</div>
        </div>
        <div class="week-pts">
          <div>${f2(points[id])}</div>
          <div class="sub">${lockedDay ? `locked ${f2(lockedDay.actual ?? lockedDay.proj)}` : `proj ${f2(lockInDefault(days))}`}</div>
        </div>
      </div>
      <div class="days">${days.map((d) => dayCell(d, s.today)).join('')}</div>
    </article>`;
  }

  function dayCell(d, today) {
    const letter = weekday(d.date, 'narrow');
    const isToday = (d.date === today ? ' today' : '') + (d.locked ? ' locked' : '');
    if (!d.game) return `<div class="day${isToday}"><div class="cell"><span class="d">${letter}</span></div></div>`;
    const done = d.game.status === 'complete';
    const value = done || d.actual != null ? d.actual : d.proj;
    const time = done ? 'Final' : d.game.status === 'in_game' ? 'Live' : d.game.start ? gameTime(d.game.start) : '';
    return `<div class="day game${isToday}${done ? ' done' : ''}">
      <div class="cell">
        <span class="d">${letter}${d.locked ? ' <span class="lock" title="Locked in">🔒</span>' : ''}</span>
        <span class="v">${value == null ? '' : f2(value)}</span>
        <span class="o">${d.home ? 'vs ' : '@'}${esc(d.opponent)}</span>
      </div>
      <div class="time">${esc(time)}</div>
    </div>`;
  }

  function picksView(s) {
    if (!s.picks?.length) return '';
    const ordinal = (n) => {
      const teen = n % 100 >= 11 && n % 100 <= 13;
      return `${n}${(!teen && { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10]) || 'th'}`;
    };
    const byId = Object.fromEntries(s.rosters.map((r) => [r.roster_id, r]));
    return `<h3>Draft Picks</h3><ul class="picks">${s.picks.map((p) => `<li>
      <b>${esc(p.season)} ${ordinal(p.round)} Rd</b>
      ${p.original !== s.rosterId ? `<span class="sub">via ${esc(teamName(s, byId[p.original] || { roster_id: p.original }))}</span>` : ''}
    </li>`).join('')}</ul>`;
  }

  function apiView(s, log) {
    if (!log.length) return '<p class="msg">No calls yet.</p>';
    return `<ol class="calls">${log.map((e) => callItem(s, e)).join('')}</ol>`;
  }

  function callItem(s, e) {
    const kind = e.status === 'pending' ? 'pending'
      : e.status === 'cache' ? 'cache'
      : typeof e.status === 'number' && e.status < 400 && !e.error ? 'ok' : 'bad';
    const meta = [
      e.ms != null && e.status !== 'cache' ? `${Math.round(e.ms)} ms` : '',
      e.bytes != null ? size(e.bytes) : '',
      new Date(e.at).toLocaleTimeString(),
    ].filter(Boolean).join(' · ');
    const open = s.openCalls.has(e.id);
    const detail = !open ? '' : [
      e.request ? `<pre class="request">${esc(e.request.trim())}</pre>` : '',
      e.error ? `<pre class="error">${esc(e.error)}</pre>` : '',
      e.json !== undefined ? `<pre>${esc(preview(e))}</pre>` : '',
    ].join('');
    return `<li><details data-call="${e.id}" ${open ? 'open' : ''}>
      <summary><span class="status ${kind}">${esc(e.status)}</span><span class="call"><code>${esc(e.path)}</code><span class="meta">${e.auth ? '<span class="auth">auth</span> · ' : ''}${meta}</span></span></summary>
      ${detail}
      ${e.request ? '' : `<a href="${esc(e.url)}" target="_blank" rel="noreferrer">Open raw response ↗</a>`}
    </details></li>`;
  }

  function preview(e) {
    if (e.preview == null) {
      const text = JSON.stringify(e.json, null, 2);
      e.preview = text.length > PREVIEW_CHARS
        ? `${text.slice(0, PREVIEW_CHARS)}\n… truncated (${size(text.length)} total).`
        : text;
    }
    return e.preview;
  }

  function size(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  return { render };
})();
