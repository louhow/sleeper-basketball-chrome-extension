// Runs in the page's own world. For NBA leagues, Sleeper's web app renders the
// waiver (W) and ADD buttons but answers clicks with "not yet available", and
// opens its own NBA player card from the Players and Trend tabs. This takes
// over those clicks once the extension has confirmed the league is NBA. The
// player id (and Sleeper's own waiver status) come from React props, which
// only this world can read, and go to the extension as JSON in a DOM event.
// It also keeps the Matchup tab when switching to an NBA league from the sidebar,
// and for NFL leagues reads (and saves) the Team tab's lineup for Optimize lineup.
(() => {
  const ACTION = '.player-action-button.waiver, .player-action-button.add';
  // Player name and headshot on the Players tab, and a row on the Trend tab.
  const PLAYER = '.player-meta-container, .trending-list-item .player-details';
  // A league in the left sidebar.
  const NAV_LEAGUE = 'a.nav-league-item-wrapper';
  const MAX_DEPTH = 12;

  // The nearest fiber (walking up from the element) whose props pass `match`.
  function fiber(el, match) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    for (let f = key && el[key], i = 0; f && i < MAX_DEPTH; f = f.return, i++) {
      if (f.memoizedProps && match(f.memoizedProps)) return f;
    }
    return null;
  }

  const props = (el, match) => fiber(el, match)?.memoizedProps ?? null;

  function send(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
  }

  addEventListener('click', (e) => {
    const league = document.documentElement.dataset.snpNbaLeague;
    if (!league || !location.pathname.startsWith(`/leagues/${league}/`) || !(e.target instanceof Element)) return;
    const action = e.target.closest(ACTION);
    const card = !action && e.target.closest(PLAYER);
    const p = action ? props(action, (x) => x.playerId)
      : card ? props(card, (x) => x.playerId || x.player?.player_id)
      : null;
    if (!p) return;
    // Window capture runs before React's listener on the document, so Sleeper never sees the click.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action) {
      const status = p.waiverStatus?.status || (action.classList.contains('waiver') ? 'waiver' : 'free_agent');
      send('snp:player-action', { playerId: String(p.playerId), status, clearTime: p.waiverStatus?.clearTime ?? null });
    } else {
      send('snp:player-card', { playerId: String(p.playerId || p.player.player_id) });
    }
  }, true);

  // Sleeper's sidebar sends every league to /leagues/<id>, which lands on its
  // League tab. From a Matchup tab, an NBA league opens on its Matchup tab
  // instead, through Sleeper's own router so its state stays in step.
  addEventListener('click', (e) => {
    if (!/^\/leagues\/\d+\/matchup(\/|$)/.test(location.pathname) || !(e.target instanceof Element)) return;
    const link = e.target.closest(NAV_LEAGUE);
    const item = link && props(link, (x) => x.league && x.selectLeague);
    const nav = item && props(link, (x) => x.router?.push);
    if (item?.league.sport !== 'nba' || !nav) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = item.league.league_id;
    item.selectLeague(id);
    item.closeNavbar?.();
    nav.router.push(`/leagues/${id}/matchup`);
  }, true);

  // NFL Team tab. Sleeper's own Team component holds the lineup as shown
  // (state.starters: slot + player), the roster, players, which teams have
  // kicked off, and the save actions its web app uses.
  const TEAM = '.team-roster';
  const teamFiber = () => {
    const el = document.querySelector(TEAM);
    return el && fiber(el, (x) => x.updateMatchupLeg && x.playersMap && x.league);
  };
  // Sleeper's _updateRoster saves to the roster before the season and to the week's matchup leg during it.
  const inSeason = (league) => !['pre_draft', 'drafting', 'complete'].includes(league.status);

  // The lineup as the extension needs it, or null when this isn't an NFL Team tab.
  // Without `full`, only whether it can be edited (checked on every page change, so kept cheap).
  function nflLineup(leagueId, full) {
    const f = teamFiber();
    const p = f?.memoizedProps;
    if (!p || p.sport !== 'nfl' || String(p.leagueId) !== leagueId) return null;
    const editable = Boolean((p.isTeamOwner || p.isTeamCoOwner) && !p.disableEdit);
    if (!full) return { editable };
    const shown = f.stateNode?.state?.starters || [];
    const roster = p.roster || {};
    const starters = shown.map((s) => s.playerId || '0');
    const away = new Set([...starters, ...(roster.reserve || []), ...(roster.taxi || [])]);
    const bench = (roster.players || []).filter((id) => !away.has(id));
    const players = {};
    const played = {};
    for (const id of [...starters, ...bench]) {
      const pl = p.playersMap[id];
      if (!pl) continue;
      players[id] = {
        name: pl.position === 'DEF' ? `${pl.first_name || ''} ${pl.last_name || ''}`.trim() || id : `${pl.first_name} ${pl.last_name}`,
        position: pl.position,
        positions: pl.fantasy_positions || [pl.position],
        team: pl.team,
        injury: pl.injury_status || null,
      };
      if (p.hasTeamPlayedMap?.[pl.team]) played[id] = true;
    }
    // Each roster row renders Sleeper's projection with the raw projected stats and league scoring.
    const projections = {};
    let scoring = null;
    for (const el of document.querySelectorAll(`${TEAM} .team-roster-item .projections`)) {
      const x = props(el, (y) => 'proj' in y && y.playerId);
      if (!x) continue;
      projections[x.playerId] = { stats: x.proj?.stats || {}, opponent: x.proj?.opponent ?? null };
      scoring ||= x.scoringSettings;
    }
    return {
      leagueId,
      rosterId: p.roster?.roster_id ?? p.rosterId,
      round: p.round,
      editable,
      slots: shown.map((s) => s.slotPosition),
      starters,
      bench,
      players,
      played,
      projections,
      scoring,
    };
  }

  // Answered synchronously, so the extension has the lineup as soon as dispatchEvent returns.
  document.addEventListener('snp:nfl-lineup-request', (e) => {
    const { leagueId, full } = JSON.parse(e.detail);
    send('snp:nfl-lineup', nflLineup(leagueId, full));
  });

  // Saves a lineup through Sleeper's own actions, so its screen updates as if you'd made the swaps.
  document.addEventListener('snp:nfl-lineup-save', async (e) => {
    const { leagueId, rosterId, round, starters } = JSON.parse(e.detail);
    try {
      const p = teamFiber()?.memoizedProps;
      const rid = p && (p.roster?.roster_id ?? p.rosterId);
      if (!p || String(p.leagueId) !== leagueId || rid !== rosterId || p.round !== round) {
        throw new Error('The Team tab changed; open Optimize again');
      }
      const res = inSeason(p.league)
        ? await p.updateMatchupLeg(leagueId, rid, round, round, starters)
        : await p.rosterUpdateStarters(leagueId, rid, starters);
      const error = res?.errors?.[0];
      if (error) throw new Error(typeof error === 'string' ? error : error.message || 'Sleeper refused the lineup');
      send('snp:nfl-lineup-saved', { ok: true });
    } catch (err) {
      send('snp:nfl-lineup-saved', { ok: false, error: String(err.message || err) });
    }
  });
})();
