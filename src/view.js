// The panel shell: tab bar (Match, Team, Players, League, API), team picker,
// and the body for the shown tab. Pure: (state, api log) -> HTML.
(globalThis.SEP ||= {}).view = (() => {
  const { esc, teamName, notice } = globalThis.SEP.ui;
  const PAGES = [['match', 'Match'], ['team', 'Team'], ['players', 'Players'], ['league', 'League']];
  const PREVIEW_CHARS = 20000;

  function render(s, log) {
    const body = s.tab === 'api' ? apiView(s, log)
      : s.page === 'match' ? globalThis.SEP.matchup.render(s)
      : s.page === 'players' ? globalThis.SEP.players.render(s)
      : s.page === 'league' ? globalThis.SEP.league.render(s)
      : globalThis.SEP.team.render(s);
    return `<div class="app">${toolbar(s, log)}<div class="body" data-scroll="body">${body}</div>${s.tab === 'api' || s.modal ? '' : notice(s)}</div>`;
  }

  function toolbar(s, log) {
    const tab = (id, label) =>
      `<button role="tab" data-page="${id}" aria-selected="${s.tab === 'page' && s.page === id}" class="${s.tab === 'page' && s.page === id ? 'active' : ''}">${label}</button>`;
    const options = (s.rosters || [])
      .map((r) => `<option value="${r.roster_id}" ${r.roster_id === s.rosterId ? 'selected' : ''}>${esc(teamName(s, r))}${r.roster_id === s.myRosterId ? ' (you)' : ''}</option>`)
      .join('');
    return `<nav class="toolbar">
      <div class="tabs" role="tablist">${PAGES.map(([id, label]) => tab(id, label)).join('')}<button role="tab" data-tab="api" aria-selected="${s.tab === 'api'}" class="api-tab ${s.tab === 'api' ? 'active' : ''}">API <span class="count">${log.length}</span></button></div>
      <div class="tools">
        ${s.loggedIn ? '' : '<span class="sub" title="Log in to Sleeper to edit your lineup and add players">Logged out</span>'}
        ${options ? `<select data-action="roster" aria-label="Team to show">${options}</select>` : ''}
        <button class="icon" data-action="refresh" title="Refetch everything" aria-label="Refresh">↻</button>
      </div>
    </nav>`;
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
      const text = JSON.stringify(e.json, null, 2) ?? 'null';
      e.preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n… truncated (${size(text.length)} total).` : text;
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
