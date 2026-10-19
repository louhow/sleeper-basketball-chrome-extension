// Pure render functions: (state, api log) -> HTML string for the shadow root.
(globalThis.SNP ||= {}).view = (() => {
  const { playerDays, lockInDefault, swapTargets } = globalThis.SNP.model;
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const f2 = (n) => (n == null ? '–' : n.toFixed(2));
  const PREVIEW_CHARS = 20000;
  const CDN = 'https://sleepercdn.com';
  // Combo slots take the colors of the positions they accept.
  const SLOT_PARTS = { G: ['pg', 'sg'], F: ['sf', 'pf'] };
  const INJURY_SEVERE = /^(out|ir|sus|na|dnr)/i;
  // Sleeper's apps list bench players by primary position in this order.
  const POSITION_ORDER = ['PG', 'SG', 'SF', 'PF', 'C'];
  const positionRank = (p) => (p && POSITION_ORDER.includes(p.position) ? POSITION_ORDER.indexOf(p.position) : POSITION_ORDER.length);

  function render(state, log) {
    const body = state.tab === 'api' ? apiView(state, log) : teamView(state);
    return `<div class="app">${toolbar(state, log)}<div class="body">${body}</div></div>`;
  }

  function toolbar(s, log) {
    const tab = (id, label) =>
      `<button role="tab" data-tab="${id}" aria-selected="${s.tab === id}" class="${s.tab === id ? 'active' : ''}">${label}</button>`;
    const options = (s.rosters || [])
      .map((r) => `<option value="${r.roster_id}" ${r.roster_id === s.rosterId ? 'selected' : ''}>${esc(teamName(s, r))}</option>`)
      .join('');
    return `<nav class="toolbar">
      <div class="tabs" role="tablist">${tab('team', 'Team')}${tab('api', `API calls <span class="count">${log.length}</span>`)}</div>
      <div class="tools">
        ${options ? `<select data-action="roster" aria-label="Team to show">${options}</select>` : ''}
        <button class="icon" data-action="refresh" title="Refetch everything" aria-label="Refresh">↻</button>
      </div>
    </nav>`;
  }

  function teamName(s, roster) {
    const user = s.usersById?.[roster.owner_id];
    return user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
  }

  // Everything about the shown roster's lineup for the shown week. The logged-in
  // matchup leg is authoritative; the public matchup and roster are fallbacks.
  function lineup(s) {
    const roster = s.rosters?.find((r) => r.roster_id === s.rosterId);
    const week = s.weeks?.[s.week];
    if (!roster || !s.players) return null;
    const slots = (s.league.roster_positions || []).filter((p) => p !== 'BN');
    const leg = week?.legs?.find((l) => l.roster_id === roster.roster_id);
    const matchup = week?.matchups.find((m) => m.roster_id === roster.roster_id);
    const starters = leg?.starters ?? matchup?.starters ?? roster.starters ?? [];
    const taxi = roster.taxi || [];
    const reserve = roster.reserve || [];
    const placed = new Set([...starters, ...taxi, ...reserve]);
    const bench = (roster.players || [])
      .filter((id) => !placed.has(id))
      .sort((a, b) => positionRank(s.players[a]) - positionRank(s.players[b]));
    const owns = s.me != null && (roster.owner_id === s.me || (roster.co_owners || []).includes(s.me));
    const inSeason = s.league.status === 'in_season';
    const editable = Boolean(week) && owns && s.week >= (s.currentWeek ?? s.week) && (!inSeason || Boolean(leg));
    return { roster, week, slots, leg, matchup, starters, bench, taxi, reserve, players: s.players, editable };
  }

  function teamView(s) {
    if (s.error) return `<p class="msg error">${esc(s.error)}</p>`;
    const l = lineup(s);
    if (!l) return '<p class="msg">Loading…</p>';
    const { roster, week, slots, leg, matchup, starters, bench, taxi, reserve, editable } = l;
    const settings = s.league.settings || {};
    const targets = new Set(editable && s.swap ? swapTargets(s.swap, l) : []);
    const ctx = {
      s,
      week,
      points: matchup?.players_points || {},
      locks: leg?.starters_games || {},
      editable: editable && !s.saving,
      selecting: Boolean(editable && s.swap),
      targets,
    };

    const card = (slot, id, spot) => playerCard(ctx, slot, id, spot);
    const padded = (ids, count) => [...ids, ...Array(Math.max(0, (count || 0) - ids.length)).fill('0')];
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
      ${s.notice ? `<p class="notice ${esc(s.notice.kind)}" role="status">${esc(s.notice.text)}</p>` : ''}
      ${week ? starters.map((id, i) => card(slots[i] ?? 'UTIL', id, `s:${i}`)).join('') : '<p class="msg">Loading week…</p>'}
      ${week ? `
        ${bench.length ? `<h3>Bench</h3>${bench.map((id) => card('BN', id, `b:${id}`)).join('')}` : ''}
        ${reserve.length || settings.reserve_slots ? `<h3>Injured Reserve</h3>${padded(reserve, settings.reserve_slots).map((id) => card('IR', id)).join('')}` : ''}
        ${taxi.length || settings.taxi_slots ? `<h3>Taxi Squad</h3>${padded(taxi, settings.taxi_slots).map((id) => card('TX', id)).join('')}` : ''}
        ${picksView(s)}` : ''}`;
  }

  const spotId = (ref, starters) => (ref.startsWith('s:') ? starters[Number(ref.slice(2))] : ref.slice(2));

  function teamCard(s, roster, week, matchup, leg, starters) {
    const owner = s.usersById?.[roster.owner_id];
    const st = roster.settings || {};
    const record = `${st.wins ?? 0}-${st.losses ?? 0}${st.ties ? `-${st.ties}` : ''}`;
    const avatar = owner?.metadata?.avatar || (owner?.avatar && `${CDN}/avatars/thumbs/${owner.avatar}`);
    const proj = leg?.proj_points ??
      (week && starters.reduce((sum, id) => sum + (lockInDefault(playerDays(week, s.players[id]?.team, id)) ?? 0), 0));
    const points = leg?.custom_points ?? leg?.points ?? matchup?.custom_points ?? matchup?.points;
    const opp = matchup?.matchup_id != null &&
      week.matchups.find((m) => m.matchup_id === matchup.matchup_id && m.roster_id !== roster.roster_id);
    const oppRoster = opp && s.rosters.find((r) => r.roster_id === opp.roster_id);
    const name = teamName(s, roster);
    return `<section class="team-card">
      ${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="">` : '<div class="avatar"></div>'}
      <div class="who">
        <div class="team-name">${esc(name)}</div>
        <div class="sub">${owner && owner.display_name !== name ? `${esc(owner.display_name)} · ` : ''}${record}</div>
      </div>
      <div class="score">
        <div class="pts">${f2(points ?? null)}</div>
        <div class="sub">proj ${f2(proj)}</div>
        ${oppRoster ? `<div class="sub">vs ${esc(teamName(s, oppRoster))}</div>` : ''}
      </div>
    </section>`;
  }

  function weekNav(s, week) {
    const range = week?.days.length ? dateRange(week.days[0], week.days.at(-1)) : '';
    return `<div class="week-nav">
      <button class="icon" data-action="prev" aria-label="Previous week" ${s.week <= s.minWeek ? 'disabled' : ''}>‹</button>
      <div class="week-label"><b>Week ${s.week ?? ''}</b><span>${range}</span></div>
      <button class="icon" data-action="next" aria-label="Next week" ${s.week >= s.maxWeek ? 'disabled' : ''}>›</button>
    </div>`;
  }

  function dateRange(from, to) {
    const fmt = (d, opts) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, opts).toUpperCase();
    const sameMonth = from.slice(0, 7) === to.slice(0, 7);
    return `${fmt(from, { month: 'short', day: 'numeric' })}-${fmt(to, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
  }

  // A slot badge doubles as the lineup button when the lineup is editable.
  function slotBadge(slot, spot) {
    const parts = SLOT_PARTS[slot];
    const cls = parts ? `split ${parts.join(' ')}` : slot.toLowerCase();
    const style = parts ? ` style="--a:var(--${parts[0]});--b:var(--${parts[1]})"` : '';
    return spot
      ? `<button class="slot ${esc(cls)}"${style} data-spot="${esc(spot)}" aria-label="Move ${esc(slot)}">${esc(slot)}</button>`
      : `<span class="slot ${esc(cls)}"${style}>${esc(slot)}</span>`;
  }

  // Lock-In picks map player -> locked game; accept a bare id or an object.
  const lockedGame = (value) => (value && typeof value === 'object' ? value.game_id ?? value.id : value) ?? null;

  function cardClass({ s, editable, selecting, targets }, spot) {
    if (!editable || !spot) return '';
    if (s.swap === spot) return ' selected';
    if (selecting) return targets.has(spot) ? ' target' : ' dim';
    return '';
  }

  function playerCard(ctx, slot, id, spot) {
    const { s, week, points, locks, editable } = ctx;
    const button = editable && spot ? spot : null;
    const cls = cardClass(ctx, spot);
    if (!id || id === '0') {
      return `<article class="card empty${cls}"><div class="top">${slotBadge(slot, button)}<div class="info"><span class="name">Empty</span></div></div></article>`;
    }
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const locked = lockedGame(locks[id]);
    const days = playerDays(week, p.team, id).map((d) => ({ ...d, locked: locked != null && String(d.game?.id) === String(locked) }));
    const lockedDay = days.find((d) => d.locked);
    const research = week.research[id];
    const pct = (n) => (n == null ? '–' : `${Math.ceil(n)}%`);
    const injury = p.injury
      ? `<span class="inj ${INJURY_SEVERE.test(p.injury) ? 'severe' : ''}">${esc(p.injury)}</span>` : '';
    return `<article class="card${cls}">
      <div class="top">
        ${slotBadge(slot, button)}
        <img class="headshot" src="${CDN}/content/nba/players/thumb/${esc(id)}.jpg" alt="" loading="lazy">
        <div class="info">
          <div class="line1">
            <span class="name">${esc(p.name)}</span>
            ${p.positions.map((pos) => `<span class="pos ${esc(pos.toLowerCase())}">${esc(pos)}</span>`).join('')}
            <span class="team">- ${esc(p.team || 'FA')}</span>${injury}
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
    const letter = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' });
    const isToday = (d.date === today ? ' today' : '') + (d.locked ? ' locked' : '');
    if (!d.game) return `<div class="day${isToday}"><div class="cell"><span class="d">${letter}</span></div></div>`;
    const done = d.game.status === 'complete';
    const value = done || d.actual != null ? d.actual : d.proj;
    const time = done ? 'Final'
      : d.game.status === 'in_game' ? 'Live'
      : d.game.start ? new Date(d.game.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase() : '';
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

  return { render, lineup };
})();
