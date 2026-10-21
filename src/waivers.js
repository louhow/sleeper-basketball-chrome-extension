// Waiver dialogs: the add/bid form Sleeper's web app shows for NFL players, and
// the owner's pending claims (edit a bid or cancel). Pure: state -> HTML.
(globalThis.SNP ||= {}).waivers = (() => {
  const { playerDays, lockInDefault, rosterRoom, faabLeft, sortClaims, FAAB } = globalThis.SNP.model;
  const { esc, f2, headshot, positions, injuryTag, slotBadge, lineup, nextGame, dialog, dialogErrors, owns } = globalThis.SNP.ui;

  function render(s) {
    const m = s.modal;
    if (!m) return '';
    return m.kind === 'claims' ? claimsDialog(s, m) : bidDialog(s, m);
  }

  const myRoster = (s) => s.rosters?.find((r) => owns(s, r)) ?? null;

  // The current week's games for a player, for projections and "next game".
  function daysOf(s, id) {
    const week = s.weeks?.[s.currentWeek];
    return week ? playerDays(week, s.players[id]?.team, id) : [];
  }

  const gamesLeft = (days) => days.filter((d) => d.game && d.game.status === 'pre_game').length;

  // A player whose game today has started can't be dropped for a free agent.
  function playedToday(s, days) {
    const today = days.find((d) => d.date === s.today);
    return Boolean(today?.game && (today.game.status !== 'pre_game' || (today.game.start != null && today.game.start <= s.now)));
  }

  function playerRow(s, slot, id, { button = false, selected = false, disabled = false } = {}) {
    const p = s.players[id] || { name: `Player #${id}`, positions: [] };
    const days = daysOf(s, id);
    const inner = `
      ${slotBadge(slot)}
      <img class="headshot" src="${headshot(id)}" alt="">
      <span class="dp-info">
        <span class="dp-name"><b>${esc(p.name)}</b> ${positions(p)} <span class="team">- ${esc(p.team || 'FA')}</span>${injuryTag(p)}</span>
        <span class="sub">${esc(nextGame(days))}</span>
      </span>
      <span class="dp-pts">${f2(lockInDefault(days))}</span>
      <span class="dp-gms">${days.length ? gamesLeft(days) : '–'}</span>`;
    if (!button) return `<div class="dp-row adding">${inner}</div>`;
    return `<button class="dp-row${selected ? ' selected' : ''}" data-drop="${esc(id)}" aria-pressed="${selected}" ${disabled ? 'disabled title="Already played today"' : ''}>${inner}</button>`;
  }

  function bidDialog(s, m) {
    const roster = myRoster(s);
    const p = s.players?.[m.playerId] || { name: `Player #${m.playerId}` };
    const settings = s.league?.settings || {};
    const waiver = m.status === 'waiver';
    const faab = settings.waiver_type === FAAB;
    const [title, description] = !waiver ? ['Add Player', `Add ${p.name} to your roster`]
      : faab ? ['Make Waiver Bid', `Bid for ${p.name}`]
      : ['Make Waiver Claim', `${p.name} will be added to your roster once waiver clears`];
    if (!s.ready) return dialog(title, description, '<p class="msg">Loading…</p>');
    if (!roster) return dialog(title, description, `<p class="msg">Log in to Sleeper with a team in this league to ${waiver ? 'bid' : 'add players'}.</p>`);

    const room = rosterRoom(s.league, roster);
    const banner = room <= 0
      ? `Your roster is full, please select ${room < 0 ? `${1 - room} players` : 'a player'} to drop`
      : `You have ${room} empty ${room > 1 ? 'slots' : 'slot'} on your roster. You can ${waiver ? 'waiver' : 'add'} this player without dropping any players.`;
    const left = faabLeft(s.league, roster);
    const min = settings.waiver_bid_min || 0;
    const bidForm = waiver && faab ? `<label class="bid-form">
        <span class="label">Bid amount <span class="sub">($${left} remaining)${min ? ` ($${min} min)` : ''}</span></span>
        <span class="bid-input">$ <input type="number" inputmode="numeric" min="${min}" max="${left}" step="1" data-bid value="${esc(m.bid)}" placeholder="Bid" autofocus></span>
      </label>` : '';

    // Drop candidates: starters, bench, then taxi. IR players are hidden, as in Sleeper's dialog.
    const l = lineup(s, roster.roster_id);
    const drops = new Set(m.drops);
    const row = (slot, id) => playerRow(s, slot, id, {
      button: true,
      selected: drops.has(id),
      disabled: !waiver && !drops.has(id) && playedToday(s, daysOf(s, id)),
    });
    const list = [
      ...l.starters.map((id, i) => (id && id !== '0' ? row(l.slots[i] ?? 'UTIL', id) : '')),
      ...l.bench.map((id) => row('BN', id)),
      ...l.taxi.map((id) => row('TX', id)),
    ].join('');

    return dialog(title, description, `
      <div class="dialog-body">
        ${dialogErrors(m.errors)}
        ${playerRow(s, 'BN', m.playerId)}
        <p class="banner">${esc(banner)}</p>
        ${bidForm}
        <div class="dp-head"><span>Pos</span><span>Player</span><span class="dp-pts">Proj</span><span class="dp-gms" title="Games left this week">Gms</span></div>
        ${list}
      </div>
      <footer class="dialog-foot">
        <button class="primary" data-action="submit-claim" ${m.saving ? 'disabled' : ''}>${m.saving ? 'Saving…' : esc(title)}</button>
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
        <span class="cp-name"><b>${esc(p.name)}</b> <span class="team">${esc(p.position || '')} - ${esc(p.team || 'FA')}</span></span>
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
          : '<p class="msg">No pending claims. Tap W next to a player on the Players tab to bid.</p>'}
      </div>`);
  }

  return { render, myRoster };
})();
