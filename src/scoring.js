// Turns a Sleeper stat line (projected or actual) into fantasy points using a
// league's scoring_settings. Every weight and bonus threshold comes from the
// settings object.
(globalThis.SNP ||= {}).scoring = (() => {
  // Threshold bonuses are encoded in the key, e.g. bonus_pt_40p = "40+ pts", bonus_reb_20p = "20+ reb".
  const BONUS_KEY = /^bonus_([a-z]+)_(\d+)p$/;

  // Bonus keys abbreviate some stats ("pt" for "pts"), so accept either spelling.
  const statValue = (stats, name) => stats[name] ?? stats[`${name}s`] ?? 0;

  function scoreStats(settings, stats) {
    let total = 0;
    for (const [key, weight] of Object.entries(settings)) {
      if (!weight) continue;
      const bonus = key.match(BONUS_KEY);
      if (bonus) {
        if (statValue(stats, bonus[1]) >= Number(bonus[2])) total += weight;
      } else if (stats[key] != null) {
        total += weight * stats[key];
      }
    }
    return total;
  }

  // NBA scoring settings in the order and wording of Sleeper's league settings.
  // Seconds played (sp) is left out, as Sleeper hides it there too.
  const NBA_SETTINGS = [
    ['pts', 'Points Scored'], ['ast', 'Assists'], ['reb', 'Rebounds'], ['to', 'Turnovers'], ['stl', 'Steals'], ['blk', 'Blocks'],
    ['dd', 'Double-Double'], ['td', 'Triple-Double'], ['tf', 'Technical Foul'], ['ff', 'Flagrant Foul'], ['pf', 'Personal Foul'],
    ['plus_minus', 'Plus/Minus'], ['fgm', 'Field Goals Made'], ['fga', 'Field Goals Attempted'], ['fgmi', 'Field Goals Missed'],
    ['ftm', 'Free Throws Made'], ['ftmi', 'Free Throws Missed'], ['fta', 'Free Throws Attempted'], ['tpm', '3-point Shots Made'],
    ['tpa', '3-point Shots Attempted'], ['tpmi', '3-point Shots Missed'], ['oreb', 'Offensive Rebound'], ['dreb', 'Defensive Rebound'],
    ['bonus_pt_40p', '40+ Points Bonus'], ['bonus_pt_50p', '50+ Points Bonus'], ['bonus_ast_15p', '15+ Assists Bonus'],
    ['bonus_reb_20p', '20+ Rebounds Bonus'],
  ];
  const HIDDEN = new Set(['sp']);

  // Every setting worth showing for a league: Sleeper's list, then any extra keys the league has.
  function settingsList(league) {
    const known = new Set(NBA_SETTINGS.map(([key]) => key));
    const extra = Object.keys(league || {}).filter((key) => !known.has(key) && !HIDDEN.has(key)).sort();
    return [...NBA_SETTINGS, ...extra.map((key) => [key, key])];
  }

  // A league's settings with what-if values on top.
  const withOverrides = (league, overrides) => ({ ...league, ...overrides });

  // Keeps only the values that differ from the league's, so "changes" means real changes.
  function changedOnly(league, overrides) {
    return Object.fromEntries(Object.entries(overrides).filter(([key, value]) => Number.isFinite(value) && value !== (league[key] ?? 0)));
  }

  return { scoreStats, settingsList, withOverrides, changedOnly };
})();
