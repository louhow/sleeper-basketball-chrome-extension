// NFL "Optimize lineup": the confirmation dialog for the lineup
// model.bestNflLineup proposes on Sleeper's own NFL Team tab. NFL has one game
// a week and no Lock-In, so it's a straight confirm; players with an injury
// designation moving into the lineup are highlighted. Pure: state -> HTML.
(globalThis.SNP ||= {}).nfl = (() => {
  const { esc, f2, CDN, dialog, dialogErrors } = globalThis.SNP.ui;

  // Plain text for the "How it picks" tooltip.
  const HOW = [
    'How it picks:',
    '1. Every player gets a number: their projected points for this week\'s game, with your league\'s scoring. A bye week, or a player ruled Out, means 0.',
    '2. It tries every way to fit your players into the starting slots and keeps the lineup whose numbers add up highest. Players who fit only one slot end up there, and the FLEX spots go to whoever is left.',
    '3. Anyone whose game has kicked off stays where they are.',
    '4. When two lineups add up the same, it keeps the one that moves the fewest players.',
    '5. Questionable and Doubtful players can still start; they are highlighted so you can check the news first.',
  ].join('\n');

  // Sleeper's slot colors; flex slots show the letters of the positions they take.
  const FLEX_LETTERS = { FLEX: ['W', 'R', 'T'], WRRB_FLEX: ['W', 'R'], REC_FLEX: ['W', 'T'], SUPER_FLEX: ['W', 'R', 'T', 'Q'] };
  const LETTER_POSITION = { W: 'wr', R: 'rb', T: 'te', Q: 'qb' };
  const INJURY_SHORT = { Questionable: 'Q', Doubtful: 'D', Out: 'O', Suspended: 'SUS', Sus: 'SUS' };
  // Designations that still let a player suit up, so they're worth a second look when starting.
  const WATCH = new Set(['Questionable', 'Doubtful']);

  function slotBadge(slot) {
    const letters = FLEX_LETTERS[slot];
    if (letters) {
      return `<span class="slot nfl flex" aria-label="${esc(slot)}">${letters.map((l) => `<i class="${LETTER_POSITION[l]}">${l}</i>`).join('')}</span>`;
    }
    const cls = slot === 'IDP_FLEX' ? 'idp' : slot.toLowerCase();
    return `<span class="slot nfl ${esc(cls)}">${esc(slot === 'IDP_FLEX' ? 'IDP' : slot)}</span>`;
  }

  // Team defenses use the team logo; everyone else their headshot.
  const headshot = (id, p) => (p?.position === 'DEF'
    ? `${CDN}/images/team_logos/nfl/${encodeURIComponent(String(id).toLowerCase())}.png`
    : `${CDN}/content/nfl/players/thumb/${encodeURIComponent(id)}.jpg`);

  function injury(p) {
    if (!p?.injury) return '';
    const watch = WATCH.has(p.injury);
    return `<span class="nfl-inj${watch ? ' watch' : ''}" title="${esc(p.injury)}">${esc(INJURY_SHORT[p.injury] || p.injury)}</span>`;
  }

  // The dialog over Sleeper's page.
  function render(s) {
    const m = s.modal;
    if (!m) return '';
    const { plan, lineup } = m;
    const how = `<span class="how" tabindex="0" aria-describedby="how-tip">How it picks<span class="how-tip" id="how-tip" role="tooltip">${esc(HOW)}</span></span>`;
    const shortName = (id) => lineup.players[id]?.name || `Player #${id}`;
    const fixed = plan.fixed.length ? `<p class="op-fixed">Staying put: ${plan.fixed.map((f) =>
      `${esc(shortName(f.id))} (game started)`).join(', ')}</p>` : '';
    const watching = plan.changes.filter((c) => c.to !== 'BN' && WATCH.has(lineup.players[c.id]?.injury));
    const watchNote = watching.length ? `<div class="warn-banner" role="status"><p>${watching.map((c) =>
      `<b>${esc(shortName(c.id))}</b> is ${esc(lineup.players[c.id].injury)}`).join(', ')}. Check the news before kickoff.</p></div>` : '';
    const body = plan.changes.length ? `
        ${summary(plan)}
        ${watchNote}
        <div class="op-head nfl"><span>Move</span><span>Player</span><span class="dp-pts" title="Projected points this week">Proj</span></div>
        ${plan.changes.map((c) => row(lineup, c)).join('')}
        ${fixed}`
      : `${summary(plan)}<p class="msg">This is already your best lineup for week ${esc(lineup.round)}.</p>${fixed}`;
    return dialog('Optimize Lineup', `Week ${lineup.round}`, `
      <div class="dialog-body">
        ${dialogErrors(m.errors)}
        ${body}
      </div>
      <footer class="dialog-foot op-foot">
        <button data-action="close-modal" ${m.saving ? 'disabled' : ''}>${plan.changes.length ? 'Cancel' : 'Close'}</button>
        ${plan.changes.length ? `<button class="primary" data-action="apply-lineup" ${m.saving ? 'disabled' : ''}>${m.saving ? 'Saving…' : 'Apply changes'}</button>` : ''}
      </footer>`, how);
  }

  function summary(plan) {
    const gain = plan.after - plan.before;
    return `<div class="op-sum">
      <span class="label">Lineup projection<span class="sub">Starters' projected points</span></span>
      <span class="nums"><b>${f2(plan.before)}</b><span class="arrow">→</span><b class="after">${f2(plan.after)}</b>
        ${plan.changes.length ? `<span class="gain${gain < 0 ? ' down' : ''}">${gain >= 0 ? '+' : ''}${f2(gain)}</span>` : ''}</span>
    </div>`;
  }

  function row(lineup, c) {
    const p = lineup.players[c.id] || { name: `Player #${c.id}`, positions: [] };
    // Sleeper's projection names the opponent but not home or away.
    const opponent = lineup.projections?.[c.id]?.opponent;
    const watch = c.to !== 'BN' && WATCH.has(p.injury);
    return `<div class="op-row nfl${watch ? ' watch' : ''}${c.to === 'BN' ? ' out' : ''}">
      <span class="op-move">${slotBadge(c.from)}<span class="arrow" aria-label="to">→</span>${slotBadge(c.to)}</span>
      <img class="headshot" src="${headshot(c.id, p)}" alt="">
      <span class="dp-info">
        <span class="dp-name"><b>${esc(p.name)}</b> <span class="team">${esc(p.position || '')} - ${esc(p.team || 'FA')}</span>${injury(p)}</span>
        <span class="sub">${opponent ? `Opp ${esc(opponent)}` : 'No game this week'}</span>
      </span>
      <span class="dp-pts">${f2(c.proj)}</span>
    </div>`;
  }

  // The OPTIMIZE button, built from the classes of Sleeper's own WAIVER and TRADE buttons so it matches them.
  const BUTTON = `<div class="btn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 4v16"/><path d="M3 8l4-4 4 4"/><path d="M17 20V4"/><path d="M13 16l4 4 4-4"/>
    </svg></div><div class="btn-text">OPTIMIZE</div>`;

  return { render, slotBadge, BUTTON, HOW };
})();
