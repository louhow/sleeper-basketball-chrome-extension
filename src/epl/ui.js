// Rendering helpers shared by every view. Pure: data in, HTML strings out.
(globalThis.SEP ||= {}).ui = (() => {
  const { playerGames, weekTotals, started, slotAccepts, savedFormation, slotLabels, formationOf } = globalThis.SEP.model;
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const f2 = (n) => (n == null || Number.isNaN(n) ? '–' : Number(n).toFixed(2));
  const f1 = (n) => (n == null || Number.isNaN(n) ? '–' : Number(n).toFixed(1));
  const CDN = 'https://sleepercdn.com';
  const INJURY_SEVERE = /^(out|ir|sus)/i;
  // Sleeper's apps list players by position in this order.
  const POSITION_ORDER = ['F', 'M', 'D', 'GK'];
  const positionRank = (p) => (p && POSITION_ORDER.includes(p.position) ? POSITION_ORDER.indexOf(p.position) : POSITION_ORDER.length);

  const headshot = (id) => `${CDN}/content/clubsoccer/players/thumb/${encodeURIComponent(id)}.jpg`;
  const teamLogo = (teamId) => (teamId ? `${CDN}/images/team_logos/clubsoccer/${encodeURIComponent(teamId)}.png` : '');

  function teamName(s, roster) {
    const user = roster && s.usersById?.[roster.owner_id];
    return user?.metadata?.team_name || user?.display_name || `Team ${roster?.roster_id ?? '?'}`;
  }

  function ownerName(s, roster) {
    return s.usersById?.[roster?.owner_id]?.display_name || '';
  }

  function avatar(s, roster) {
    const owner = s.usersById?.[roster?.owner_id];
    return owner?.metadata?.avatar || (owner?.avatar && `${CDN}/avatars/thumbs/${owner.avatar}`) || null;
  }

  const avatarImg = (s, roster, cls = 'avatar') => {
    const src = avatar(s, roster);
    return src ? `<img class="${cls}" src="${esc(src)}" alt="">` : `<div class="${cls}"></div>`;
  };

  function record(roster) {
    const st = roster?.settings || {};
    return `${st.wins ?? 0}-${st.losses ?? 0}${st.ties ? `-${st.ties}` : ''}`;
  }

  // "B. Mbeumo", falling back to the full name when first/last are missing.
  function shortName(p) {
    if (!p) return 'Unknown';
    return p.first && p.last ? `${p.first[0]}. ${p.last}` : p.name;
  }

  function injuryTag(p) {
    return p?.injury ? `<span class="inj ${INJURY_SEVERE.test(p.injury) ? 'severe' : ''}">${esc(p.injury)}</span>` : '';
  }

  function positions(p) {
    return (p?.positions || []).map((pos) => `<span class="pos ${esc(pos.toLowerCase())}">${esc(pos)}</span>`).join('');
  }

  const gameTime = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
  const weekday = (date, style = 'short') => (date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: style }) : '');
  const shortDate = (date) => (date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : '');

  // Slot badge: F, M, D, GK in their colors; flex slots split the colors they
  // accept. `label` is the resolved formation label (F for a FM_FLEX holding a
  // forward). Doubles as the lineup button when `spot` is given.
  function slotBadge(slot, spot, label) {
    const accepts = slotAccepts(slot).map((p) => p.toLowerCase());
    const flex = accepts.length > 1 && !['BN', 'IR'].includes(slot);
    const cls = flex ? `flex ${accepts.join(' ')}` : slot.toLowerCase();
    const stops = flex ? accepts.map((p, i) => `var(--${p}) ${(i / accepts.length) * 100}% ${((i + 1) / accepts.length) * 100}%`).join(', ') : '';
    const style = flex ? ` style="background:linear-gradient(135deg, ${stops})"` : '';
    const text = flex ? `<span class="slot-label">${esc(label || accepts.map((p) => p.toUpperCase()).join('/'))}</span><span class="slot-sub">${esc(accepts.map((p) => p.toUpperCase()).join('/'))}</span>` : esc(label || slot);
    const title = flex ? ` title="${esc(slot.replace('_FLEX', ' flex'))}: ${esc(accepts.map((p) => p.toUpperCase()).join(' or '))}"` : '';
    return spot
      ? `<button class="slot ${esc(cls)}"${style}${title} data-spot="${esc(spot)}" aria-label="Move ${esc(label || slot)}">${text}</button>`
      : `<span class="slot ${esc(cls)}"${style}${title}>${text}</span>`;
  }

  // A player's next game this week, e.g. "Sun 9:00am vs BOU", or the result.
  function nextGameText(games, now = Date.now()) {
    if (!games.length) return 'No match this week';
    const next = games.find((g) => !started(g.game, now) || g.game.status === 'in_game');
    if (!next) return `Final · ${games.map((g) => `${g.home ? 'vs' : '@'} ${g.opponentAbbr}`).join(', ')}`;
    const live = next.game.status === 'in_game' || (started(next.game, now) && next.game.status !== 'complete');
    const time = live ? 'Live' : next.game.start ? `${weekday(next.game.date)} ${gameTime(next.game.start)}` : weekday(next.game.date);
    return `${time} ${next.home ? 'vs' : '@'} ${next.opponentAbbr}`;
  }

  // Logo chips for a player's games this week, opponent's logo, dimmed once played.
  function gameChips(games, now = Date.now()) {
    return games.map((g) => `<span class="chip${g.game.status === 'complete' ? ' done' : started(g.game, now) ? ' live' : ''}" title="${esc(`${weekday(g.game.date)} ${g.home ? 'vs' : '@'} ${g.opponentAbbr}`)}"><img src="${teamLogo(g.opponent)}" alt="${esc(g.opponentAbbr || '')}"></span>`).join('');
  }

  // A dialog over the page; the backdrop and ✕ close it.
  function dialog(title, description, body, { cls = '', extra = '' } = {}) {
    return `<div class="modal">
      <div class="backdrop" data-action="close-modal"></div>
      <div class="dialog ${esc(cls)}" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header class="dialog-head">
          <div><h2 id="dialog-title">${esc(title)}${extra}</h2>${description ? `<div class="sub">${esc(description)}</div>` : ''}</div>
          <button class="icon close" data-action="close-modal" aria-label="Close">✕</button>
        </header>
        ${body}
      </div>
    </div>`;
  }

  function dialogErrors(list) {
    return list?.length ? `<div class="dialog-errors" role="alert">${list.map((e) => `<p>${esc(e)}</p>`).join('')}</div>` : '';
  }

  function weekNav(s) {
    return `<div class="week-nav">
      <button class="icon" data-action="prev" aria-label="Previous week" ${s.week <= s.minWeek ? 'disabled' : ''}>‹</button>
      <div class="week-label"><b>Week ${s.week ?? ''}</b>${s.week === s.currentWeek ? '<span>current</span>' : ''}</div>
      <button class="icon" data-action="next" aria-label="Next week" ${s.week >= s.maxWeek ? 'disabled' : ''}>›</button>
    </div>`;
  }

  function notice(s) {
    return s.notice ? `<p class="notice ${esc(s.notice.kind)}" role="status">${esc(s.notice.text)}</p>` : '';
  }

  const ROLE_ORDER = ['F', 'M', 'D', 'GK'];
  const ROLE_NAMES = { F: 'Forwards', M: 'Midfielders', D: 'Defenders', GK: 'Goalkeeper' };
  const roleRank = (label) => (ROLE_ORDER.includes(label) ? ROLE_ORDER.indexOf(label) : ROLE_ORDER.length);
  const roleName = (label, n) => (n === 1 && label !== 'GK' ? ROLE_NAMES[label]?.replace(/s$/, '') : ROLE_NAMES[label]) || label;

  const owns = (s, roster) => s.me != null && roster != null && (roster.owner_id === s.me || (roster.co_owners || []).includes(s.me));
  const myRoster = (s) => s.rosters?.find((r) => owns(s, r)) ?? null;

  const ownerOf = (s, playerId) => s.rosters?.find((r) => (r.players || []).includes(playerId)) ?? null;

  // Everything about one roster's lineup for the shown week. The logged-in
  // matchup leg is authoritative; the roster's own starters are the fallback.
  function lineup(s, rosterId = s.rosterId) {
    const roster = s.rosters?.find((r) => r.roster_id === rosterId);
    const week = s.weeks?.[s.week];
    if (!roster || !s.players) return null;
    const slots = (s.league.roster_positions || []).filter((p) => p !== 'BN');
    const leg = week?.legs?.find((l) => l.roster_id === roster.roster_id);
    const starters = leg?.starters ?? roster.starters ?? [];
    const reserve = roster.reserve || [];
    const placed = new Set([...starters, ...reserve]);
    const bench = (roster.players || [])
      .filter((id) => !placed.has(id))
      .sort((a, b) => positionRank(s.players[a]) - positionRank(s.players[b]));
    const inSeason = s.league.status === 'in_season';
    const current = Boolean(week) && s.week >= (s.currentWeek ?? s.week);
    const mine = owns(s, roster);
    const editable = mine && current && (!inSeason || Boolean(leg));
    const settings = s.league.settings || {};
    const active = (roster.players || []).length - reserve.length;
    // Players whose club has kicked off this week can't move (Sleeper locks them).
    const locked = new Set();
    if (week) {
      for (const id of [...starters, ...bench]) {
        if (id && id !== '0' && playerGames(week, s.players[id]?.team, id).some((g) => started(g.game, s.now))) locked.add(id);
      }
    }
    const labels = slotLabels(slots, starters, s.players, savedFormation(roster, s.week));
    // Starter indexes grouped by formation role, forwards first, as the app lays a formation out.
    const order = slots.map((_, i) => i).sort((a, b) => roleRank(labels[a]) - roleRank(labels[b]) || a - b);
    return {
      roster, week, slots, labels, order, formation: formationOf(labels), leg, starters, bench, reserve, players: s.players, settings,
      locked, mine, editable,
      reserveEditable: editable && (settings.reserve_slots || 0) > 0 && s.week === s.currentWeek,
      reserveRoom: Math.max(0, (settings.reserve_slots || 0) - reserve.length),
      benchRoom: Math.max(0, (s.league.roster_positions || []).length - active),
    };
  }

  // Team totals for the week: Sleeper's own leg numbers when logged in, else
  // added up from each starter's games.
  function teamTotals(s, l) {
    const games = {};
    let points = 0;
    let proj = 0;
    let yetToPlay = 0;
    let any = false;
    for (const id of l.starters) {
      if (!id || id === '0') continue;
      const g = playerGames(l.week, s.players[id]?.team, id);
      const t = weekTotals(g, s.now);
      games[id] = { games: g, ...t };
      points += t.points;
      proj += t.proj;
      if (t.played) any = true;
      if (t.left || t.live) yetToPlay++;
    }
    const leg = l.leg;
    return {
      games,
      points: leg?.custom_points ?? leg?.points ?? points,
      proj: leg?.proj_points ?? proj,
      anyPoints: any || Boolean(leg?.points),
      yetToPlay,
    };
  }

  // Which injury statuses the league lets onto IR.
  function reserveRule(settings) {
    const allowed = [['Out', 'reserve_allow_out'], ['Sus', 'reserve_allow_sus'], ['GTD', 'reserve_allow_dtd'], ['Doubtful', 'reserve_allow_doubtful']]
      .filter(([, key]) => settings[key]).map(([name]) => name);
    const list = ['IR', ...allowed];
    const names = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0];
    return `${names} players can move to IR.`;
  }

  const pct = (n) => (n == null ? '–' : `${Math.round(n)}%`);

  // Shared player row for lists: headshot, name, positions, club, injury, then whatever `right` is.
  function playerLine(s, id, { sub = '', nameButton = true } = {}) {
    const p = s.players?.[id] || { name: `Player #${id}`, positions: [] };
    const name = nameButton ? `<button class="name" data-player="${esc(id)}">${esc(p.name)}</button>` : `<span class="name">${esc(p.name)}</span>`;
    return `<img class="headshot" src="${headshot(id)}" alt="" data-player="${esc(id)}">
      <div class="info">
        <div class="line1">${name}${positions(p)}<span class="team">• ${esc(p.teamAbbr || 'FA')}</span>${injuryTag(p)}</div>
        ${sub ? `<div class="line2">${sub}</div>` : ''}
      </div>`;
  }

  return {
    esc, f2, f1, CDN, headshot, teamLogo, teamName, ownerName, avatar, avatarImg, record, shortName, injuryTag, positions,
    gameTime, weekday, shortDate, slotBadge, nextGameText, gameChips, dialog, dialogErrors, weekNav, notice,
    owns, myRoster, ownerOf, lineup, teamTotals, reserveRule, pct, playerLine, positionRank, roleName,
  };
})();
