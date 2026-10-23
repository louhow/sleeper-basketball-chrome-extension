// "Optimize lineup" dialog: the changes model.bestLineup proposes for the shown
// week, with any score benching would throw away. Nothing saves until the
// owner applies. Pure: state -> HTML.
(globalThis.SNP ||= {}).optimize = (() => {
  const { playerDays, scoreTier } = globalThis.SNP.model;
  const { esc, f2, headshot, positions, injuryTag, slotBadge, weekday, nextGame, dialog, dialogErrors, shortName } = globalThis.SNP.ui;

  // Plain text for the "How it picks" tooltip.
  const HOW = [
    'How it picks:',
    'Starts your best projected players for the next day of games.',
    'Starters without a game that day can sit. Run it again before their next one.',
    'Keeps a finished game worth locking in, and leaves locked-in and live players alone.',
  ].join('\n');

  const games = (n) => `${n} game${n === 1 ? '' : 's'}`;
  const pts = (x) => (x == null ? '–' : f2(x));
  const gameText = (d) => `${weekday(d.date)} ${d.home ? 'vs' : '@'} ${d.opponent}`;
  const names = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]);

  function render(s, m = s.modal) {
    const { plan } = m;
    const name = (id) => s.players[id]?.name || `Player #${id}`;
    const how = `<span class="how" tabindex="0" aria-describedby="how-tip">How it picks<span class="how-tip" id="how-tip" role="tooltip">${esc(HOW)}</span></span>`;
    // Giving up a green score stops you until you confirm; any smaller lockable score is a softer warning.
    const good = plan.changes.filter((c) => c.goodScore);
    const soft = plan.changes.filter((c) => c.lost && !c.goodScore);
    const goodTotal = good.reduce((sum, c) => sum + c.lost.actual, 0);
    const blocked = good.length > 0 && !m.ack;
    const who = (list) => names(list.map((c) => `<b>${esc(name(c.id))}</b> ${score(c.lost.actual)}`));
    const warning = (good.length ? `<div class="lose-banner" role="alert">
        <p>${who(good)} ${good.length > 1 ? 'have green games' : 'has a green game'} you could still lock in.
        Bench players can't lock in, so benching them gives up ${f2(goodTotal)} pts.</p>
        <label class="ack"><input type="checkbox" data-op-ack ${m.ack ? 'checked' : ''} ${m.saving ? 'disabled' : ''}>
          <span>Bench ${names(good.map((c) => esc(shortName(s.players[c.id]))))} anyway</span>
        </label>
      </div>` : '') + (soft.length ? `<div class="warn-banner" role="status">
        <p>${who(soft)} ${soft.length > 1 ? 'have finished games' : 'has a finished game'} you could still lock in. On the bench ${soft.length > 1 ? 'those scores' : 'that score'} can't be locked.</p>
      </div>` : '');
    const fixed = plan.fixed.length ? `<p class="op-fixed">Staying put: ${plan.fixed.map((f) =>
      `${esc(shortName(s.players[f.id]))} (${f.reason === 'locked' ? 'locked in' : 'playing now'})`).join(', ')}</p>` : '';
    const body = plan.changes.length ? `
        ${summary(plan)}
        ${warning}
        <div class="op-head"><span>Move</span><span>Player</span><span class="dp-pts" title="Projected points on ${esc(day(plan))}">${esc(day(plan))}</span><span class="dp-avg" title="Projected points per game left this week">Pts/G</span></div>
        ${plan.changes.map((c) => row(s, c)).join('')}
        ${fixed}`
      : `${summary(plan)}<p class="msg">This is already your best lineup for week ${esc(s.week)}.</p>${fixed}`;
    const apply = good.length ? `Apply and lose ${f2(goodTotal)} pts` : 'Apply changes';
    return dialog('Optimize Lineup', `Week ${s.week}`, `
      <div class="dialog-body">
        ${dialogErrors(m.errors)}
        ${body}
      </div>
      <footer class="dialog-foot op-foot">
        <button data-action="close-modal" ${m.saving ? 'disabled' : ''}>${plan.changes.length ? 'Cancel' : 'Close'}</button>
        ${plan.changes.length ? `<button class="primary${good.length ? ' risky' : ''}" data-action="apply-lineup" ${m.saving || blocked ? 'disabled' : ''}
          ${blocked ? 'title="Tick the box above to confirm giving up that score"' : ''}>${m.saving ? 'Saving…' : esc(apply)}</button>` : ''}
      </footer>`, how);
  }

  // The day the plan is for, e.g. "Fri".
  const day = (plan) => (plan.date ? weekday(plan.date) : 'Day');

  // The starters' projected points on that day now and after the changes.
  function summary(plan) {
    const gain = plan.after - plan.before;
    return `<div class="op-sum">
      <span class="label">${plan.date ? `${esc(day(plan))} projection<span class="sub">Starters playing ${esc(day(plan))}</span>`
        : 'Lineup projection<span class="sub">No games left this week</span>'}</span>
      <span class="nums"><b>${f2(plan.before)}</b><span class="arrow">→</span><b class="after">${f2(plan.after)}</b>
        ${plan.changes.length ? `<span class="gain${gain < 0 ? ' down' : ''}">${gain >= 0 ? '+' : ''}${f2(gain)}</span>` : ''}</span>
    </div>`;
  }

  // One player's move: from-slot → to-slot, who, and what they're worth.
  function row(s, c) {
    const p = s.players[c.id] || { name: `Player #${c.id}`, positions: [] };
    const days = playerDays(s.weeks[s.week], p.team, c.id);
    const sub = c.lost
      ? `<span class="sub ${c.goodScore ? 'lose' : 'warn'}">Can't lock ${score(c.lost.actual)} · ${esc(gameText(c.lost))}</span>`
      : `<span class="sub">${esc(nextGame(days))}</span>`;
    return `<div class="op-row${c.goodScore ? ' losing' : c.lost ? ' warning' : ''}${c.to === 'BN' ? ' out' : ''}">
      <span class="op-move">${slotBadge(c.from)}<span class="arrow" aria-label="to">→</span>${slotBadge(c.to)}</span>
      <img class="headshot" src="${headshot(c.id)}" alt="" data-player="${esc(c.id)}">
      <span class="dp-info">
        <span class="dp-name"><button class="name" data-player="${esc(c.id)}">${esc(p.name)}</button> ${positions(p)} <span class="team">- ${esc(p.team || 'FA')}</span>${injuryTag(p)}</span>
        ${sub}
      </span>
      <span class="dp-pts">${pts(c.today)}</span>
      <span class="dp-avg" title="${esc(games(c.gamesLeft))} left">${f2(c.perGame)}</span>
    </div>`;
  }

  // A finished game's fantasy points in its score color (see model.scoreTier).
  function score(points) {
    return `<span class="score ${scoreTier(points)}">${f2(points)}</span>`;
  }

  return { render, HOW };
})();
