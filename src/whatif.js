// What-if scoring: a control in the page's top-right corner for trying other
// scoring settings on the Team and Matchup tabs and the player card. Collapsed,
// it switches between the league's scoring and the what-if values; open, it
// edits the values. Nothing is saved to the league. Pure: state -> HTML.
(globalThis.SNP ||= {}).whatif = (() => {
  const { esc, whatIfOn } = globalThis.SNP.ui;
  const { settingsList } = globalThis.SNP.scoring;

  // Settings values print without float noise (0.1 + 0.2 shows as 0.3).
  const fmt = (n) => String(Math.round(Number(n) * 1e4) / 1e4);

  const ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>
    </svg>`;

  function render(s) {
    const w = s.whatIf;
    const count = Object.keys(w.overrides).length;
    const on = whatIfOn(s);
    return `<div class="wi${on ? ' on' : ''}">
      <div class="wi-dock">
        <button class="wi-edit" data-wi="toggle-open" aria-expanded="${w.open}" title="Try different scoring">${ICON}Scoring</button>
        <div class="wi-switch" role="radiogroup" aria-label="Scoring to show">
          <button role="radio" aria-checked="${!on}" data-wi="league">League</button>
          <button role="radio" aria-checked="${on}" data-wi="whatif" ${count ? '' : 'disabled title="Change a value first"'}>What-if${count ? `<span class="count">${count}</span>` : ''}</button>
        </div>
      </div>
      ${w.open ? editor(s) : ''}
    </div>`;
  }

  function editor(s) {
    const w = s.whatIf;
    const league = s.league?.scoring_settings || {};
    const all = settingsList(league);
    // Grouped by the league's own values, so a row never jumps while it's being edited.
    const scored = all.filter(([key]) => league[key]);
    const rest = all.filter(([key]) => !league[key]);
    // Changed values always show; the rest of the league's unscored stats on request.
    const forced = rest.some(([key]) => key in w.overrides);
    const showRest = w.showAll || forced;
    const more = forced && !w.showAll ? 'Not scored in your league'
      : `${w.showAll ? 'Hide' : 'Show'} ${rest.length} more not scored in your league`;
    const count = Object.keys(w.overrides).length;
    return `<section class="wi-pop" role="dialog" aria-label="What-if scoring">
      <header class="wi-head">
        <div>
          <h2>What-if scoring</h2>
          <p>Try other values on your Team, Matchup and player cards. Your league's scoring doesn't change.</p>
        </div>
        <button class="icon close" data-wi="close" aria-label="Close">✕</button>
      </header>
      <div class="wi-list" data-wi-scroll>
        ${scored.map(([key, label]) => row(s, key, label)).join('')}
        ${rest.length ? `<button class="wi-more" data-wi="show-all" aria-expanded="${showRest}" ${forced && !w.showAll ? 'disabled' : ''}>${more}</button>` : ''}
        ${showRest ? rest.map(([key, label]) => row(s, key, label)).join('') : ''}
      </div>
      <footer class="wi-foot">
        <button data-wi="reset" ${count ? '' : 'disabled'}>Reset to league</button>
        <button class="primary" data-wi="close">Done</button>
      </footer>
    </section>`;
  }

  // The input comes before the reset button so it keeps its place (and focus) when the button appears.
  function row(s, key, label) {
    const w = s.whatIf;
    const league = s.league?.scoring_settings?.[key] ?? 0;
    const changed = key in w.overrides;
    const value = w.drafts[key] ?? fmt(changed ? w.overrides[key] : league);
    return `<div class="wi-row${changed ? ' changed' : ''}">
      <label for="wi-${esc(key)}">${esc(label)}</label>
      <input id="wi-${esc(key)}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-wi-key="${esc(key)}" value="${esc(value)}">
      ${changed ? `<button class="wi-was" data-wi-reset="${esc(key)}" title="Back to the league's value">League ${esc(fmt(league))} ↺</button>` : ''}
    </div>`;
  }

  // A typed value, or null while it isn't a number yet ("", "-", ".").
  function parse(text) {
    const t = String(text).trim();
    return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
  }

  return { render, parse };
})();
