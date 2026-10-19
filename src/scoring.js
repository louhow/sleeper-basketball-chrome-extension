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

  return { scoreStats };
})();
