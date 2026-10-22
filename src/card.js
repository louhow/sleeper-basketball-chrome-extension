// Player card, laid out like the mobile app's: a club-colored hero with bio
// and add/drop, then Summary (next match, projections, news), Game Log and
// History (transactions and career). Pure: state -> HTML.
(globalThis.SEP ||= {}).card = (() => {
  const { playerGames, weekTotals, started } = globalThis.SEP.model;
  const { scoreStats, breakdown } = globalThis.SEP.scoring;
  const { esc, f2, f1, teamLogo, headshot, teamName, ownerOf, owns, positions, injuryTag, weekday, shortDate, gameTime, pct } = globalThis.SEP.ui;
  const TABS = [['summary', 'Summary'], ['log', 'Game Log'], ['history', 'History']];
  // Game log columns: stat key, header, whether it's shown for goalkeepers only / outfield only.
  const LOG_COLS = [
    ['min', 'MIN'], ['g', 'G'], ['at', 'AST'], ['sot', 'SOT'], ['kp', 'KP'], ['sm', 'DRB'], ['tkw', 'TKW'], ['int', 'INT'],
    ['cs', 'CS'], ['ga', 'GA'], ['sv', 'SV'], ['yc', 'YC'], ['rc', 'RC'],
  ];
  const NEWS_SOURCES = { rotowire: 'RotoWire', rotoworld: 'Rotoworld', fantasy_pros: 'FantasyPros' };

  const dash = (v) => (v == null || v === '' ? '-' : v);
  const num = (v, digits = 0) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(digits));
  const height = (inches) => {
    const n = Number(inches);
    return n ? `${Math.floor(n / 12)}'${n % 12}"` : '-';
  };
  function ago(ms, now) {
    const s = Math.max(0, (now - ms) / 1000);
    const [n, unit] = s < 3600 ? [Math.round(s / 60), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
    if (unit === 'minute' && n < 1) return 'just now';
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }

  // Heat color for a cell, as Sleeper shades stat tables: red (low) through olive to green (high).
  function heat(t) {
    if (t == null || Number.isNaN(t)) return '';
    const stops = [[150, 72, 96], [128, 122, 78], [84, 132, 100]];
    const x = Math.min(1, Math.max(0, t)) * 2;
    const [a, b] = x <= 1 ? [stops[0], stops[1]] : [stops[1], stops[2]];
    const f = x <= 1 ? x : x - 1;
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * f));
    return ` style="background:rgba(${c.join(',')},.5)"`;
  }
  function scaler(rows, key) {
    const vals = rows.map((r) => r[key]).filter((v) => v != null && !Number.isNaN(v));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return (v) => (v == null || Number.isNaN(v) || !vals.length ? null : hi === lo ? 0.5 : (v - lo) / (hi - lo));
  }

  function render(s) {
    const m = s.modal;
    const id = m.playerId;
    const c = s.cards?.[id] || {};
    const p = s.players?.[id] || { name: `Player #${id}`, positions: [] };
    const bio = c.bio || {};
    const owner = ownerOf(s, id);
    const mine = owner && owns(s, owner);
    const tab = m.tab || 'summary';
    const action = !s.loggedIn || !s.myRosterId ? ''
      : mine ? `<button class="hero-btn drop" data-drop-player="${esc(id)}">− Drop</button>`
      : owner ? '' : `<button class="hero-btn add" data-add="${esc(id)}">+ Add</button>`;
    const injury = p.injury ? `<div class="hero-injury">${injuryTag(p)} ${esc(p.injuryNote || (p.injuryReturn ? `expected back ${esc(p.injuryReturn)}` : ''))}</div>` : '';
    const tabs = TABS.map(([key, label]) => `<button role="tab" data-card-tab="${key}" aria-selected="${tab === key}" class="${tab === key ? 'active' : ''}">${label}</button>`).join('');
    const body = tab === 'log' ? gameLogView(s, id, c) : tab === 'history' ? historyView(s, id, c) : summaryView(s, id, c);
    return `<div class="modal">
      <div class="backdrop" data-action="close-modal"></div>
      <div class="dialog card-dialog" role="dialog" aria-modal="true" aria-label="${esc(p.name)}">
        <header class="hero">
          <img class="hero-logo" src="${teamLogo(p.team)}" alt="">
          <img class="hero-shot" src="${headshot(id)}" alt="">
          <div class="hero-main">
            <div class="sub">${owner ? `→ ${esc(teamName(s, owner))}` : 'Free agent'}</div>
            <div class="hero-name"><span>${esc(p.first || '')}</span><b>${esc(p.last || p.name)}</b></div>
            <div class="hero-meta">${positions(p)}<span class="team">• ${esc(p.teamAbbr || 'FA')}${p.number ? ` • #${p.number}` : ''}</span></div>
            <dl class="hero-bio">
              <div><dt>Age</dt><dd>${dash(bio.age ?? p.age)}</dd></div>
              <div><dt>Height</dt><dd>${height(bio.height ?? p.height)}</dd></div>
              <div><dt>Weight</dt><dd>${bio.weight || p.weight ? `${bio.weight || p.weight} lbs` : '-'}</dd></div>
              <div><dt>Exp</dt><dd>${dash(bio.years_exp ?? p.years_exp)}</dd></div>
              <div><dt>Country</dt><dd>${esc(dash(bio.birth_country))}</dd></div>
            </dl>
            ${injury}
          </div>
          <div class="hero-actions">${action}<button class="icon close" data-action="close-modal" aria-label="Close">✕</button></div>
        </header>
        <nav class="card-tabs" role="tablist">${tabs}</nav>
        <div class="dialog-body" data-scroll="card">${body}</div>
      </div>
    </div>`;
  }

  function summaryView(s, id, c) {
    const p = s.players[id] || {};
    const week = s.weeks?.[s.currentWeek];
    const games = week ? playerGames(week, p.team, id) : [];
    const next = games.find((g) => !started(g.game, s.now)) || games.at(-1);
    const research = week?.research?.[id];
    const scoring = s.league.scoring_settings || {};
    const upcoming = !next ? '<p class="msg">No match this week.</p>' : `<div class="up-game">
        <img class="headshot" src="${headshot(id)}" alt="">
        <div class="up-main">
          <div><b>${esc(p.name)}</b> ${next.home ? 'vs' : '@'} ${esc(next.opponentAbbr)} <img class="mini-logo" src="${teamLogo(next.opponent)}" alt=""></div>
          <div class="sub">${esc(weekday(next.game.date, 'long'))}, ${esc(shortDate(next.game.date))}${next.game.start ? ` · ${esc(gameTime(next.game.start))}` : ''}${next.game.status === 'complete' ? ' · Final' : ''}</div>
        </div>
        <div class="up-pts"><b>${next.played ? f2(next.actual) : f2(next.proj)}</b><span>${next.played ? 'pts' : 'proj'}</span></div>
      </div>
      ${next.played && next.stats ? statLine(scoring, next.stats) : projLine(week, id, next)}`;
    const projections = projectionsStrip(s, id, c);
    const news = c.news == null ? '<p class="msg">Loading news…</p>' : !c.news.length ? '<p class="msg">No recent news.</p>'
      : c.news.slice(0, 6).map((n) => `<article class="news">
          <h4>${esc(n.metadata?.title || '')}</h4>
          <p>${esc(n.metadata?.description || '')}</p>
          ${n.metadata?.analysis ? `<p class="sub">${esc(n.metadata.analysis)}</p>` : ''}
          <div class="sub src">${esc(NEWS_SOURCES[n.source] || n.source || '')} · ${esc(ago(n.published, s.now))}</div>
        </article>`).join('');
    return `
      <h3>Upcoming match <span class="sub">${research ? `${pct(research.started)} start · ${pct(research.owned)} rostered` : ''}</span></h3>
      ${upcoming}
      <h3>Projections</h3>
      ${projections}
      <h3>Recent news</h3>
      ${news}`;
  }

  // The stats behind a finished game's points, biggest first.
  function statLine(scoring, stats) {
    const parts = breakdown(scoring, stats).slice(0, 8);
    if (!parts.length) return '<p class="sub">No scoring stats recorded.</p>';
    return `<div class="stat-line">${parts.map((x) => `<span title="${esc(x.label)}"><b>${num(x.value, Number.isInteger(x.value) ? 0 : 1)}</b> ${esc(x.label)} <i>${x.points >= 0 ? '+' : ''}${num(x.points, 2)}</i></span>`).join('')}</div>`;
  }

  // The projected stat line for an upcoming game, biggest contributors first.
  function projLine(week, id, g) {
    const raw = week?.proj?.[id]?.[g.game.id]?.stats;
    const scoring = globalThis.SEP.scoring;
    if (!raw) return '';
    const parts = scoring.breakdown(week.scoring || {}, raw).slice(0, 6);
    return parts.length ? `<div class="stat-line proj">${parts.map((x) => `<span title="projected ${esc(x.label)}"><b>${num(x.value, 1)}</b> ${esc(x.label)}</span>`).join('')}</div>` : '';
  }

  // Projected points for this gameweek and the next two, with finals where played.
  function projectionsStrip(s, id, c) {
    const log = c.logs?.[s.league.season];
    const scoring = s.league.scoring_settings || {};
    const weeks = [s.currentWeek - 1, s.currentWeek, s.currentWeek + 1, s.currentWeek + 2].filter((w) => w >= s.minWeek);
    const p = s.players[id] || {};
    return `<div class="proj-strip">${weeks.map((w) => {
      const loaded = s.weeks[w];
      let proj = null;
      let final = null;
      let opp = '';
      if (loaded) {
        const games = playerGames(loaded, p.team, id);
        const t = weekTotals(games, s.now);
        proj = games.length ? t.proj : null;
        final = t.played ? t.points : null;
        opp = games.map((g) => `${g.home ? 'vs' : '@'} ${g.opponentAbbr}`).join(', ');
      } else if (log) {
        const rows = (list) => (list || []).filter(Boolean);
        const pr = rows(log.proj?.[w]);
        const st = rows(log.stats?.[w]).filter((r) => Object.keys(r.stats || {}).length);
        proj = pr.length ? pr.reduce((sum, r) => sum + scoreStats(scoring, r.stats || {}), 0) : null;
        final = st.length ? st.reduce((sum, r) => sum + scoreStats(scoring, r.stats || {}), 0) : null;
        opp = pr.concat(st).map((r) => `${r.is_away_team ? '@' : 'vs'} ${r.opponent_abbr || s.teamAbbr?.(r.opponent) || r.opponent || ''}`).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      }
      return `<div class="proj-cell${w === s.currentWeek ? ' now' : ''}">
        <div class="sub">GW ${w} <span>${esc(opp)}</span></div>
        <div class="pc-row"><span>Proj</span><b>${f2(proj)}</b></div>
        <div class="pc-row"><span>Final</span><b>${f2(final)}</b></div>
      </div>`;
    }).join('')}</div>`;
  }

  function gameLogView(s, id, c) {
    const m = s.modal;
    const seasons = c.seasons || [Number(s.league.season)];
    const season = m.season ?? seasons[0];
    const log = c.logs?.[season];
    const scoring = s.league.scoring_settings || {};
    const tabs = seasons.map((y) => `<button data-card-season="${y}" class="${y === season ? 'active' : ''}">${y}</button>`).join('');
    if (!log) return `<div class="season-tabs">${tabs}</div><p class="msg">Loading game log…</p>`;
    const p = s.players[id] || {};
    const gk = (p.positions || []).includes('GK');
    const cols = LOG_COLS.filter(([key]) => (gk ? !['sm', 'kp', 'sot', 'g', 'at'].includes(key) || key === 'g' : !['sv', 'ga'].includes(key) || key === 'ga'));
    const rows = gameLog(log, scoring, s);
    const fpts = scaler(rows.filter((r) => r.played), 'fpts');
    const scalers = Object.fromEntries(cols.map(([key]) => [key, scaler(rows.filter((r) => r.played), key)]));
    const body = rows.map((r) => `<tr class="${r.played ? 'played' : 'future'}">
      <td>${r.week}</td>
      <td>${r.away ? '@' : ''}${esc(r.opp)}</td>
      <td class="sub">${esc(shortDate(r.date))}</td>
      <td class="num fpts"${r.played ? heat(fpts(r.fpts)) : ''}>${r.played ? f2(r.fpts) : r.proj != null ? `<span class="sub">${f2(r.proj)}</span>` : '-'}</td>
      ${cols.map(([key]) => `<td class="num"${r.played ? heat(scalers[key](r[key])) : ''}>${r.played ? num(r[key]) : '-'}</td>`).join('')}
    </tr>`).join('');
    return `<div class="season-tabs">${tabs}</div>
      <div class="table-wrap"><table class="log">
        <thead><tr><th>WK</th><th>OPP</th><th>DATE</th><th class="num">FPTS</th>${cols.map(([, h]) => `<th class="num">${h}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="sub">Future rows show Sleeper's projection in the FPTS column.</p>`;
  }

  // One row per game of a season: played games from stats, upcoming ones from projections.
  function gameLog(log, scoring, s) {
    const byGame = new Map();
    const rows = (data) => Object.values(data || {}).flat().filter(Boolean);
    const abbr = (r) => r.opponent_abbr || s.teamAbbr?.(r.opponent) || r.opponent || '';
    for (const r of rows(log.proj)) byGame.set(r.game_id || `${r.week}-${r.date}`, { week: r.week, date: r.date, opp: abbr(r), away: Boolean(r.is_away_team), proj: scoreStats(scoring, r.stats || {}) });
    for (const r of rows(log.stats)) {
      const st = r.stats || {};
      if (!Object.keys(st).length) continue;
      const key = r.game_id || `${r.week}-${r.date}`;
      const row = { ...byGame.get(key), week: r.week, date: r.date, opp: abbr(r), away: Boolean(r.is_away_team), played: true, fpts: scoreStats(scoring, st) };
      for (const [k] of LOG_COLS) row[k] = st[k] ?? 0;
      byGame.set(key, row);
    }
    return [...byGame.values()].sort((a, b) => a.week - b.week || String(a.date).localeCompare(String(b.date)));
  }

  function historyView(s, id, c) {
    const byRoster = Object.fromEntries((s.rosters || []).map((r) => [r.roster_id, r]));
    const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const history = c.history == null ? (c.historyError ? '<p class="msg">Log in to Sleeper to see transaction history.</p>' : '<p class="msg">Loading…</p>')
      : !c.history.length ? '<p class="msg">No transactions in this league.</p>'
      : `<ul class="hist">${[...c.history].sort((a, b) => (b.status_updated || b.created) - (a.status_updated || a.created)).map((t) => {
        const added = t.adds?.[id];
        const dropped = t.drops?.[id];
        const team = (rid) => teamName(s, byRoster[rid]);
        const what = t.type === 'waiver' ? `claimed by ${team(added)}${t.settings?.waiver_bid != null ? ` for $${t.settings.waiver_bid}` : ''}`
          : t.type === 'free_agent' && added != null ? `added by ${team(added)}`
          : t.type === 'free_agent' ? `dropped by ${team(dropped)}`
          : t.type === 'trade' ? `traded to ${team(added)}` : t.type;
        return `<li><span class="kind">${esc(t.type)}</span><span>${esc(what)}</span><span class="sub">${esc(when(t.status_updated || t.created))}${t.status !== 'complete' ? ` · ${esc(t.status)}` : ''}</span></li>`;
      }).join('')}</ul>`;
    const career = c.career == null ? '<p class="msg">Loading…</p>' : `<table class="career">
      <thead><tr><th>Season</th><th class="num">GP</th><th class="num">MIN</th><th class="num">G</th><th class="num">AST</th><th class="num">FPTS</th><th class="num">Rank</th></tr></thead>
      <tbody>${c.career.map((r) => `<tr><td>${r.season}</td><td class="num">${num(r.stats?.gp)}</td><td class="num">${num(r.stats?.min)}</td><td class="num">${num(r.stats?.g)}</td><td class="num">${num(r.stats?.at)}</td><td class="num">${r.stats ? f1(scoreStats(s.league.scoring_settings || {}, r.stats)) : '-'}</td><td class="num">${num(r.stats?.rank_std)}</td></tr>`).join('')}</tbody>
    </table>`;
    return `<h3>Transaction history</h3>${history}<h3>Career <span class="sub">fantasy points with this league's scoring</span></h3>${career}`;
  }

  return { render };
})();
