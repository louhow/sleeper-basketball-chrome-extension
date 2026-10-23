// Dialogs over the page: add a player (free agent or waiver bid, with drops),
// drop a player, pending waiver claims, and the Optimize lineup proposal.
// Pure: state -> HTML.
(globalThis.SEP ||= {}).dialogs = (() => {
  const { playerGames, weekTotals, rosterRoom, faabLeft, sortClaims, FAAB, started } = globalThis.SEP.model;
  const { esc, f2, headshot, positions, injuryTag, slotBadge, lineup, nextGameText, dialog, dialogErrors, myRoster, shortName } = globalThis.SEP.ui;

  function render(s) {
    const m = s.modal;
    if (!m) return '';
    if (m.kind === 'claims') return claimsDialog(s, m);
    if (m.kind === 'drop') return dropDialog(s, m);
    if (m.kind === 'optimize') return optimizeDialog(s, m);
    return addDialog(s, m);
  }

  function gamesOf(s, id) {
    const week = s.weeks?.[s.currentWeek];
    return week ? playerGames(week, s.players[id]?.team, id) : [];
  }

  function playerRow(s, slot, id, { button = false, selected = false, disabled = false, label } = {}) {
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const games = gamesOf(s, id);
    const t = weekTotals(games, s.now);
    const inner = `
      ${slotBadge(slot, null, label)}
      <img class="headshot" src="${headshot(id)}" alt="">
      <span class="dp-info">
        <span class="dp-name"><b>${esc(p.name)}</b> ${positions(p)} <span class="team">• ${esc(p.teamAbbr || 'FA')}</span>${injuryTag(p)}</span>
        <span class="sub">${esc(nextGameText(games, s.now))}</span>
      </span>
      <span class="dp-pts">${games.length ? f2(t.proj) : '–'}</span>`;
    if (!button) return `<div class="dp-row adding">${inner}</div>`;
    return `<button class="dp-row${selected ? ' selected' : ''}" data-drop="${esc(id)}" aria-pressed="${selected}" ${disabled ? 'disabled title="This player\'s match has started"' : ''}>${inner}</button>`;
  }

  function dropList(s, roster, drops, { lockPlayed = false } = {}) {
    const l = lineup(s, roster.roster_id);
    const played = (id) => lockPlayed && gamesOf(s, id).some((g) => started(g.game, s.now));
    const row = (slot, id, label) => playerRow(s, slot, id, { button: true, selected: drops.has(id), disabled: !drops.has(id) && played(id), label });
    return [
      ...l.starters.map((id, i) => (id && id !== '0' ? row(l.slots[i] ?? 'FLEX', id, l.labels[i]) : '')),
      ...l.bench.map((id) => row('BN', id)),
      ...l.reserve.map((id) => row('IR', id)),
    ].join('');
  }

  function addDialog(s, m) {
    const roster = myRoster(s);
    const p = s.players?.[m.playerId] || { name: `Player #${m.playerId}` };
    const settings = s.league?.settings || {};
    const waiver = m.status === 'waiver';
    const faab = settings.waiver_type === FAAB;
    const [title, description] = !waiver ? ['Add Player', `Add ${p.name} to your roster`]
      : faab ? ['Make Waiver Bid', `Bid for ${p.name}`]
      : ['Make Waiver Claim', `${p.name} will be added to your roster once waivers clear`];
    if (!s.ready) return dialog(title, description, '<p class="msg">Loading…</p>');
    if (!roster) return dialog(title, description, `<p class="msg">Log in to Sleeper with a team in this league to ${waiver ? 'bid' : 'add players'}.</p>`);
    const room = rosterRoom(s.league, roster);
    const banner = room <= 0
      ? `Your roster is full, please select ${room < 0 ? `${1 - room} players` : 'a player'} to drop`
      : `You have ${room} empty ${room > 1 ? 'slots' : 'slot'} on your roster. You can ${waiver ? 'claim' : 'add'} this player without dropping anyone.`;
    const left = faabLeft(s.league, roster);
    const min = settings.waiver_bid_min || 0;
    const bidForm = waiver && faab ? `<label class="bid-form">
        <span class="label">Bid amount <span class="sub">($${left} remaining)${min ? ` ($${min} min)` : ''}</span></span>
        <span class="bid-input">$ <input type="number" inputmode="numeric" min="${min}" max="${left}" step="1" data-bid value="${esc(m.bid)}" placeholder="Bid"></span>
      </label>` : '';
    const toggle = `<div class="mode-row">
        <span class="sub">${m.guess === 'waiver' ? 'Sleeper will likely treat this player as on waivers.' : 'This player looks like a free agent.'}</span>
        <button class="link" data-add-mode="${waiver ? 'free_agent' : 'waiver'}">${waiver ? 'Add as free agent instead' : 'Place a waiver claim instead'}</button>
      </div>`;
    return dialog(title, description, `
      <div class="dialog-body">
        ${dialogErrors(m.errors)}
        ${playerRow(s, 'BN', m.playerId)}
        ${toggle}
        <p class="banner">${esc(banner)}</p>
        ${bidForm}
        <div class="dp-head"><span>Pos</span><span>Player to drop</span><span class="dp-pts">Proj</span></div>
        ${dropList(s, roster, new Set(m.drops), { lockPlayed: !waiver })}
      </div>
      <footer class="dialog-foot">
        <button class="primary" data-action="submit-claim" ${m.saving ? 'disabled' : ''}>${m.saving ? 'Saving…' : esc(title)}</button>
      </footer>`);
  }

  function dropDialog(s, m) {
    const roster = myRoster(s);
    const p = s.players?.[m.playerId] || { name: `Player #${m.playerId}` };
    if (!roster) return dialog('Drop Player', '', '<p class="msg">Log in to Sleeper to drop players.</p>');
    const games = gamesOf(s, m.playerId);
    const locked = games.some((g) => started(g.game, s.now));
    return dialog('Drop Player', `Drop ${p.name} from your roster`, `
      <div class="dialog-body">
        ${dialogErrors(m.errors)}
        ${playerRow(s, 'BN', m.playerId)}
        <p class="banner ${locked ? 'warn' : ''}">${locked ? `${esc(p.name)}'s match this week has already started, so Sleeper may refuse the drop until the week ends.` : `${esc(p.name)} will go to waivers for ${s.league.settings?.waiver_clear_days ?? 1} day(s) before anyone can add them.`}</p>
      </div>
      <footer class="dialog-foot">
        <button class="primary danger" data-action="confirm-drop" ${m.saving ? 'disabled' : ''}>${m.saving ? 'Dropping…' : 'Drop Player'}</button>
      </footer>`);
  }

  function claimsDialog(s, m) {
    const roster = myRoster(s);
    const faab = s.league?.settings?.waiver_type === FAAB;
    const claims = sortClaims(s.claims || []);
    const description = roster && faab ? `$${faabLeft(s.league, roster)} remaining · waiver position ${roster.settings?.waiver_position ?? '–'}` : '';
    if (!roster) return dialog('Waiver Claims', '', '<p class="msg">Log in to Sleeper to see your claims.</p>');
    const player = (id, sign) => {
      const p = s.players[id] || { name: `Player #${id}`, positions: [] };
      return `<div class="cp ${sign === '+' ? 'add' : 'drop'}">
        <span class="sign">${sign}</span>
        <img class="headshot" src="${headshot(id)}" alt="">
        <span class="cp-name"><b>${esc(p.name)}</b> <span class="team">${esc(p.position || '')} • ${esc(p.teamAbbr || 'FA')}</span></span>
      </div>`;
    };
    const items = claims.map((c, i) => `<li class="claim">
        <span class="rank">${i + 1}</span>
        <div class="claim-players">
          ${Object.keys(c.adds || {}).map((id) => player(id, '+')).join('')}
          ${Object.keys(c.drops || {}).map((id) => player(id, '−')).join('')}
        </div>
        ${m.confirmCancel === c.transaction_id ? `<div class="claim-actions confirm" role="alert">
          <span>Cancel this claim?</span>
          <button class="danger solid" data-claim-cancel-confirm="${esc(c.transaction_id)}" ${m.saving ? 'disabled' : ''}>Yes, cancel</button>
          <button data-claim-cancel-keep ${m.saving ? 'disabled' : ''}>Keep</button>
        </div>` : `<div class="claim-actions">
          ${faab ? `<span class="bid-input">$ <input type="number" inputmode="numeric" min="0" step="1" aria-label="Bid" data-claim-bid="${esc(c.transaction_id)}" value="${esc(c.settings?.waiver_bid ?? 0)}"></span>
          <button data-claim-save="${esc(c.transaction_id)}" ${m.saving ? 'disabled' : ''}>Save</button>` : ''}
          <button class="danger" data-claim-cancel="${esc(c.transaction_id)}" ${m.saving ? 'disabled' : ''}>Cancel</button>
        </div>`}
      </li>`).join('');
    return dialog('Waiver Claims', description, `
      <div class="dialog-body">
        ${dialogErrors(m.errors)}
        ${s.claims == null ? '<p class="msg">Loading…</p>'
          : items ? `<ol class="claims">${items}</ol>`
          : '<p class="msg">No pending claims. Use + next to a player on the Players tab to bid.</p>'}
      </div>`);
  }

  function optimizeDialog(s, m) {
    const l = lineup(s);
    const plan = m.plan;
    if (!l || !plan) return dialog('Optimize lineup', '', '<p class="msg">Nothing to optimize.</p>');
    const name = (id) => shortName(s.players[id] || { name: `Player #${id}` });
    const label = (slot) => (slot === 'BN' ? 'Bench' : slot.replace('_FLEX', ' flex'));
    const rows = plan.changes.map((c) => `<li class="op-change ${c.to === 'BN' ? 'out' : 'in'}">
        <img class="headshot" src="${headshot(c.id)}" alt="" data-player="${esc(c.id)}">
        <span class="op-name"><button class="name" data-player="${esc(c.id)}">${esc(name(c.id))}</button>${positions(s.players[c.id])}</span>
        <span class="op-move">${esc(label(c.from))} → <b>${esc(label(c.to))}</b></span>
        <span class="op-proj">${f2(c.proj)}<span class="sub">proj</span></span>
      </li>`).join('');
    const fixed = plan.fixed.length ? `<p class="sub">${plan.fixed.length} player${plan.fixed.length > 1 ? 's' : ''} stay put because their match has kicked off.</p>` : '';
    const body = !plan.changes.length ? '<p class="msg">Your lineup is already the best projected one for this week.</p>' : `
      <div class="op-sum">
        <span class="label">Projected<span class="sub">starters, this week</span></span>
        <span class="op-nums">${f2(plan.before)} → <b>${f2(plan.after)}</b></span>
      </div>
      <ol class="op-changes">${rows}</ol>${fixed}`;
    return dialog('Optimize lineup', 'Highest projected points this week, with Sleeper\'s projections and this league\'s scoring', `
      <div class="dialog-body">${dialogErrors(m.errors)}${body}</div>
      <footer class="dialog-foot">
        <button class="primary" data-action="apply-lineup" ${m.saving || !plan.changes.length ? 'disabled' : ''}>${m.saving ? 'Saving…' : 'Apply'}</button>
        <button data-action="close-modal" ${m.saving ? 'disabled' : ''}>Cancel</button>
      </footer>`);
  }

  return { render };
})();
