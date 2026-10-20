// Runs in the page's own world. Sleeper's web app renders the waiver (W) and
// ADD buttons for NBA players but answers clicks with "not yet available", so
// this takes over those clicks once the extension has confirmed the league is
// NBA. The player id and Sleeper's own waiver status come from the button's
// React props, which only this world can read, and go to the extension as JSON.
(() => {
  const BUTTON = '.player-action-button.waiver, .player-action-button.add';
  const MAX_DEPTH = 10;

  function props(el) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    for (let fiber = key && el[key], i = 0; fiber && i < MAX_DEPTH; fiber = fiber.return, i++) {
      if (fiber.memoizedProps?.playerId) return fiber.memoizedProps;
    }
    return null;
  }

  addEventListener('click', (e) => {
    const league = document.documentElement.dataset.snpNbaLeague;
    if (!league || !location.pathname.startsWith(`/leagues/${league}/`)) return;
    const button = e.target instanceof Element && e.target.closest(BUTTON);
    const p = button && props(button);
    if (!p) return;
    // Window capture runs before React's listener on the document, so Sleeper never sees the click.
    e.preventDefault();
    e.stopImmediatePropagation();
    const status = p.waiverStatus?.status || (button.classList.contains('waiver') ? 'waiver' : 'free_agent');
    document.dispatchEvent(new CustomEvent('snp:player-action', {
      detail: JSON.stringify({ playerId: String(p.playerId), status, clearTime: p.waiverStatus?.clearTime ?? null }),
    }));
  }, true);
})();
