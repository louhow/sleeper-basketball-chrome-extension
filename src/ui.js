// Rendering helpers shared by the Team and Matchup views.
(globalThis.SNP ||= {}).ui = (() => {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const f2 = (n) => (n == null ? '–' : n.toFixed(2));
  const CDN = 'https://sleepercdn.com';
  // Combo slots take the colors of the positions they accept.
  const SLOT_PARTS = { G: ['pg', 'sg'], F: ['sf', 'pf'] };
  const INJURY_SEVERE = /^(out|ir|sus|na|dnr)/i;
  // Sleeper's apps list bench players by primary position in this order.
  const POSITION_ORDER = ['PG', 'SG', 'SF', 'PF', 'C'];
  const positionRank = (p) => (p && POSITION_ORDER.includes(p.position) ? POSITION_ORDER.indexOf(p.position) : POSITION_ORDER.length);

  const headshot = (id) => `${CDN}/content/nba/players/thumb/${encodeURIComponent(id)}.jpg`;
  const teamLogo = (team) => `${CDN}/images/team_logos/nba/${encodeURIComponent(String(team).toLowerCase())}.webp`;

  function teamName(s, roster) {
    const user = s.usersById?.[roster.owner_id];
    return user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
  }

  function avatar(s, roster) {
    const owner = s.usersById?.[roster.owner_id];
    return owner?.metadata?.avatar || (owner?.avatar && `${CDN}/avatars/thumbs/${owner.avatar}`) || null;
  }

  function record(roster) {
    const st = roster.settings || {};
    return `${st.wins ?? 0}-${st.losses ?? 0}${st.ties ? `-${st.ties}` : ''}`;
  }

  // "L. Dončić", falling back to the full name when first/last are missing.
  function shortName(p) {
    if (!p) return 'Unknown';
    return p.first && p.last ? `${p.first[0]}. ${p.last}` : p.name;
  }

  function injuryTag(p) {
    return p?.injury ? `<span class="inj ${INJURY_SEVERE.test(p.injury) ? 'severe' : ''}">${esc(p.injury)}</span>` : '';
  }

  function positions(p) {
    return (p?.positions || []).map((pos) => `<span class="pos ${esc(pos.toLowerCase())}">${esc(pos)}</span>`).join(' ');
  }

  const gameTime = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
  const weekday = (date, style = 'short') => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: style });

  // A slot badge doubles as the lineup button when the lineup is editable.
  function slotBadge(slot, spot) {
    const parts = SLOT_PARTS[slot];
    const cls = parts ? `split ${parts.join(' ')}` : slot.toLowerCase();
    const style = parts ? ` style="--a:var(--${parts[0]});--b:var(--${parts[1]})"` : '';
    return spot
      ? `<button class="slot ${esc(cls)}"${style} data-spot="${esc(spot)}" aria-label="Move ${esc(slot)}">${esc(slot)}</button>`
      : `<span class="slot ${esc(cls)}"${style}>${esc(slot)}</span>`;
  }

  // A player's next game this week, e.g. "Thu @ MIA 7:30pm".
  function nextGame(days) {
    const d = days.find((x) => x.game && x.game.status !== 'complete');
    if (!d) return days.some((x) => x.game) ? 'No games left this week' : 'No games this week';
    const time = d.game.status === 'in_game' ? 'Live' : d.game.start ? gameTime(d.game.start) : '';
    return `${weekday(d.date)} ${d.home ? 'vs' : '@'} ${d.opponent}${time ? ` ${time}` : ''}`;
  }

  // A dialog over the page; the backdrop and ✕ close it. `extra` sits beside the title.
  function dialog(title, description, body, extra = '') {
    return `<div class="modal">
      <div class="backdrop" data-action="close-modal"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
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

  function notice(s) {
    return s.notice ? `<p class="notice ${esc(s.notice.kind)}" role="status">${esc(s.notice.text)}</p>` : '';
  }

  const owns = (s, roster) => s.me != null && (roster.owner_id === s.me || (roster.co_owners || []).includes(s.me));

  // Everything about one roster's lineup for the shown week. The logged-in
  // matchup leg is authoritative; the public matchup and roster are fallbacks.
  function lineup(s, rosterId = s.rosterId) {
    const roster = s.rosters?.find((r) => r.roster_id === rosterId);
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
    const inSeason = s.league.status === 'in_season';
    const current = Boolean(week) && s.week >= (s.currentWeek ?? s.week);
    const mine = owns(s, roster);
    const editable = mine && current && (!inSeason || Boolean(leg));
    const settings = s.league.settings || {};
    // Active roster = everyone not on IR or taxi; it can hold one player per roster position.
    const active = (roster.players || []).length - reserve.length - taxi.length;
    return {
      roster, week, slots, leg, matchup, starters, bench, taxi, reserve, players: s.players, settings,
      locks: leg?.starters_games || {},
      mine,
      editable,
      // Locks only exist on an in-season matchup leg.
      lockable: mine && current && inSeason && Boolean(leg),
      // Taxi belongs to the roster, not a week, so it's edited from the current week.
      taxiEditable: editable && (settings.taxi_slots || 0) > 0 && s.week === s.currentWeek,
      taxiOpen: globalThis.SNP.model.taxiOpen(settings, s.seasonType, s.currentWeek, weekStarted(s)),
      taxiRoom: Math.max(0, (settings.taxi_slots || 0) - taxi.length),
      // IR also belongs to the roster, so it's edited from the current week too.
      reserveEditable: editable && (settings.reserve_slots || 0) > 0 && s.week === s.currentWeek,
      reserveRoom: Math.max(0, (settings.reserve_slots || 0) - reserve.length),
      benchRoom: Math.max(0, (s.league.roster_positions || []).length - active),
    };
  }

  // Whether any game of the current week has tipped off.
  function weekStarted(s) {
    const games = s.weeks?.[s.currentWeek]?.games || [];
    return games.some((g) => g.status !== 'pre_game' || (g.start != null && g.start <= s.now));
  }

  // One-line summary of the league's taxi rules and whether taxi is open now.
  function taxiRule(l) {
    const { settings } = l;
    const limit = settings.taxi_years === 0 ? 'any experience'
      : `${settings.taxi_years || 0} or fewer years of experience`;
    const who = settings.taxi_allow_vets ? `Players with ${limit}` : 'Rookies only';
    if (!l.taxiOpen) {
      return `Taxi is locked for the season: players can only move up to the active roster${l.benchRoom ? '' : ' (roster is full)'}.`;
    }
    const until = settings.taxi_deadline === 0 ? 'any time'
      : settings.taxi_deadline === 4 ? 'until the first game of the regular season tips off'
      : `through preseason week ${settings.taxi_deadline || 1}`;
    return `${who} can move to taxi ${until}.`;
  }

  // Which injury statuses the league lets onto IR, e.g. "Out, DTD and DNR players can move to IR."
  function reserveRule(settings) {
    const allowed = ['Out', 'Sus', 'Doubtful', 'DTD', 'DNR', 'COV', 'NA']
      .filter((status) => settings[`reserve_allow_${status.toLowerCase()}`]);
    const list = ['IR', ...allowed];
    const names = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0];
    return `${names} players can move to IR.`;
  }

  return {
    reserveRule,
    esc, f2, CDN, headshot, teamLogo, teamName, avatar, record, shortName, injuryTag, positions,
    gameTime, weekday, nextGame, dialog, dialogErrors, slotBadge, weekNav, notice, lineup, taxiRule, owns,
  };
})();
