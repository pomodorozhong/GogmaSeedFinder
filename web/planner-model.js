// Values are gains from the five Gogma reinforcement slots, not total weapon
// stats. Attack is unbloated raw; affinity is in percentage points.
export const BONUS_CATEGORY = Object.freeze({ 8: 0, 12: 0, 15: 0, 9: 1, 13: 1, 16: 1, 11: 2, 14: 2, 6: 3, 10: 3 });
export const STAT_KEYS = ["attack", "affinity", "element", "sharpness", "ammo"];
// Search time grows about linearly with weapon count; the scheduling search is
// budgeted per route, so a large selection costs time, not unbounded work.
export const MAX_SELECTED = 100;
export const ELEMENT_VALUES = [[90, 110], [50, 80], [30, 50], [60, 90], [60, 90], [60, 90], [60, 90], [60, 90], [50, 80], [60, 80], [50, 80], [40, 60], [0, 0], [0, 0]];

export function elementValues(target) {
  // Status deltas must be entered from the actual weapon. Do not silently
  // apply elemental weapon deltas to a status weapon.
  if (target.attributeForce >= 6) return target.planner?.elementValues ?? [null, null];
  return ELEMENT_VALUES[target.weaponType];
}

export function availableStats(target) {
  const keys = ["attack", "affinity"];
  if (target.attributeForce !== 0 && target.weaponType < 12) keys.push("element");
  if (target.weaponType < 11) keys.push("sharpness");
  if (target.weaponType >= 12) keys.push("ammo");
  return keys;
}

export function bonusTotals(bonuses, target) {
  const total = { attack: 0, affinity: 0, element: 0, sharpness: 0, ammo: 0 };
  for (const id of bonuses) {
    if (!(id in BONUS_CATEGORY)) throw new Error(`Unsupported bonus ID: ${id}`);
    if ([8, 12, 15].includes(id)) total.attack += ({ 8: 6, 12: 9, 15: 12 })[id];
    else if ([9, 13, 16].includes(id)) total.affinity += ({ 9: 6, 13: 8, 16: 10 })[id];
    else if ([11, 14].includes(id)) {
      const value = elementValues(target)[id === 11 ? 0 : 1];
      total.element = value === null || total.element === null ? null : total.element + value;
    } else if (target.weaponType >= 12) total.ammo += id === 6 ? 1 : 2;
    else total.sharpness += id === 6 ? 30 : 50;
  }
  return total;
}

// Per-slot gains for one stat, lowest tier first. Status values are null until
// entered from the actual weapon.
export function statRollValues(key, target) {
  if (key === "attack") return [["II", 6], ["III", 9], ["EX", 12]];
  if (key === "affinity") return [["II", 6], ["III", 8], ["EX", 10]];
  if (key === "element") return [["II", elementValues(target)[0]], ["EX", elementValues(target)[1]]];
  return key === "ammo" ? [["I", 1], ["EX", 2]] : [["I", 30], ["EX", 50]];
}

// Highest gain five slots can roll: no bonus appears more than twice, and
// sharpness/ammo fill at most two slots. Null while a status value is unknown.
export function statMaximum(key, target) {
  const values = statRollValues(key, target).map(([, value]) => value);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const slots = key === "sharpness" || key === "ammo" ? 2 : 5;
  return values.flatMap((value) => [value, value]).sort((a, b) => b - a).slice(0, slots).reduce((sum, value) => sum + value, 0);
}

export function layoutOf(bonuses) {
  return bonuses.map((id) => BONUS_CATEGORY[id]);
}

export function validLayout(layout, target) {
  if (!Array.isArray(layout) || layout.length !== 5 || layout.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) return false;
  if ((target.weaponType === 11 && layout.includes(3)) || ((target.weaponType >= 12 || target.attributeForce === 0) && layout.includes(2))) return false;
  return layout.filter((v) => v === 2).length <= 4 && layout.filter((v) => v === 3).length <= 2;
}

export function validBonuses(bonuses, target) {
  return Array.isArray(bonuses) && bonuses.length === 5 && bonuses.every((v) => v in BONUS_CATEGORY)
    && validLayout(layoutOf(bonuses), target)
    && [...new Set(bonuses)].every((id) => bonuses.filter((v) => v === id).length <= 2);
}

// An unknown status value (null) proves neither bound, so it fails both.
export function statGoalMatches(totals, minimums, maximums = {}) {
  return Object.entries(minimums ?? {}).every(([stat, min]) => STAT_KEYS.includes(stat)
    && Number.isFinite(min) && min >= 0 && Number.isFinite(totals[stat]) && totals[stat] >= min)
    && Object.entries(maximums ?? {}).every(([stat, max]) => STAT_KEYS.includes(stat)
    && Number.isFinite(max) && max >= 0 && Number.isFinite(totals[stat]) && totals[stat] <= max);
}

export const hasBonusGoal = (tier) => Object.keys(tier.stats).length > 0 || Object.keys(tier.maxStats ?? {}).length > 0;

export function skillGoalMatches(index, pairs) {
  return (pairs ?? []).some((pair) => index === pair.seriesIndex * 14 + pair.groupIndex);
}

// Slots each category can fill: no bonus ID repeats more than twice, and
// sharpness/ammo fill at most two slots.
const CATEGORY_SLOTS = { attack: 5, affinity: 5, element: 4, sharpness: 2, ammo: 2 };

export function canFillSlots(target, excluded) {
  return availableStats(target).filter((key) => !excluded.includes(key)).reduce((sum, key) => sum + CATEGORY_SLOTS[key], 0) >= 5;
}

export function normalizedPlanner(target) {
  const saved = target.planner ?? {};
  const stats = (value, fallback) => {
    const source = value && typeof value === "object" ? value : fallback;
    return Object.fromEntries(Object.entries(source).filter(([key, min]) => availableStats(target).includes(key) && Number.isFinite(min) && min >= 0));
  };
  const pairs = (value, fallback) => (Array.isArray(value) ? value : fallback).filter((pair) => Number.isInteger(pair?.seriesIndex) && pair.seriesIndex >= 0 && pair.seriesIndex < 21 && Number.isInteger(pair?.groupIndex) && pair.groupIndex >= 0 && pair.groupIndex < 14).map(({ seriesIndex, groupIndex }) => ({ seriesIndex, groupIndex }));
  const preset = target.skillCombinations?.length ? target.skillCombinations : [{ seriesIndex: 11, groupIndex: 13 }];
  const defaultAcceptable = target.weaponType === 11 ? { affinity: 30 } : target.weaponType === 8 ? { attack: 18, affinity: 14 } : { attack: 36 };
  const defaultPreferred = target.weaponType === 11 ? { affinity: 36 } : target.weaponType === 8 ? { attack: 24, affinity: 18 } : { attack: 42 };
  const preferredSkills = target.weaponType === 11 && !target.skillCombinations?.length ? [{ seriesIndex: 18, groupIndex: 13 }] : [preset[0]];
  // Each tier holds minimums (stats) and maximums (maxStats); a missing key
  // is no bound. Older saves listed "excluded" stats: those become max 0.
  const legacyExcluded = Array.isArray(saved.excluded) ? saved.excluded : [];
  const tier = (value, fallbackStats, fallbackSkills) => {
    const mins = stats(value?.stats, fallbackStats);
    const maxs = stats(value?.maxStats, {});
    for (const key of legacyExcluded) if (availableStats(target).includes(key)) { delete mins[key]; maxs[key] = 0; }
    return { stats: mins, maxStats: maxs, skills: pairs(value?.skills, fallbackSkills) };
  };
  const values = Array.isArray(saved.elementValues) && saved.elementValues.length === 2 ? saved.elementValues.map((v) => Number.isFinite(v) && v >= 0 ? v : null) : [null, null];
  return {
    bonusEnabled: saved.bonusEnabled !== false,
    optional: saved.optional === true,
    skillEnabled: saved.skillEnabled !== false,
    acceptable: tier(saved.acceptable, defaultAcceptable, preset),
    preferred: tier(saved.preferred, defaultPreferred, preferredSkills),
    currentBonuses: validBonuses(saved.currentBonuses, target) ? saved.currentBonuses : null,
    currentSkill: Number.isInteger(saved.currentSkill) && saved.currentSkill >= 0 && saved.currentSkill < 294 ? saved.currentSkill : null,
    elementValues: values,
  };
}

// Copies goals onto another weapon; its current bonuses, skills, and Keep
// layout stay its own. Elemental gains depend only on weapon type, but status
// gains are entered per weapon, so element goals carry over only when the
// gains are known to match. Stats the weapon cannot roll are dropped.
export function copiedPlanner(source, target) {
  const goals = structuredClone(normalizedPlanner(source));
  const sameAttribute = source.attributeForce === target.attributeForce;
  const sameGains = source.weaponType === target.weaponType && (sameAttribute || (source.attributeForce < 6 && target.attributeForce < 6));
  // Max 0 excludes the category whatever its gains, so it always carries over.
  if (!sameGains) for (const tier of [goals.acceptable, goals.preferred]) { delete tier.stats.element; if (tier.maxStats.element > 0) delete tier.maxStats.element; }
  const own = normalizedPlanner(target);
  return normalizedPlanner({ ...target, planner: { ...goals, currentBonuses: own.currentBonuses, currentSkill: own.currentSkill, elementValues: sameAttribute ? goals.elementValues : own.elementValues } });
}

export function hasGoal(target, stream) {
  const p = target.planner;
  return stream === "bonus" ? p.bonusEnabled : p.skillEnabled;
}

// The tiers a result may satisfy for a route mode. An empty top-desired tier
// falls back to acceptable; top-desired results also count as acceptable.
function tiersFor(target, stream, mode) {
  const p = target.planner;
  const preferredExists = stream === "bonus" ? hasBonusGoal(p.preferred) : p.preferred.skills.length > 0;
  if (mode === "preferred") return [preferredExists ? p.preferred : p.acceptable];
  return preferredExists ? [p.acceptable, p.preferred] : [p.acceptable];
}

export function matchesTier(result, target, stream, mode) {
  if (!hasGoal(target, stream)) return true;
  return tiersFor(target, stream, mode).some((tier) => stream === "bonus"
    ? hasBonusGoal(tier) && statGoalMatches(result, tier.stats, tier.maxStats)
    : skillGoalMatches(result, tier.skills));
}

// Whether some result whose totals lie between low and high could meet the
// mode's goal. Keep fixes the categories but not the tiers, and each slot's
// tier is independent, so each stat can reach anywhere in its own range.
export function rangeCanMatch(low, high, target, mode) {
  if (!hasGoal(target, "bonus")) return true;
  return tiersFor(target, "bonus", mode).some((tier) => hasBonusGoal(tier) && statGoalMatches(high, tier.stats) && statGoalMatches(low, {}, tier.maxStats));
}

export function resultQuality(result, target, stream) {
  if (!hasGoal(target, stream)) return "none";
  if (matchesTier(result, target, stream, "preferred")) return "preferred";
  return matchesTier(result, target, stream, "acceptable") ? "acceptable" : "none";
}

export function validatePlannerRequest(request) {
  const { origin, targets, limits } = request;
  if (!Number.isInteger(origin?.baseSeed) || origin.baseSeed < 0 || origin.baseSeed > 99_999_999) throw new Error("state");
  if (!Array.isArray(targets) || !targets.length || targets.length > MAX_SELECTED || new Set(targets.map((t) => t.id)).size !== targets.length) throw new Error("targets");
  for (const stream of ["bonus", "skill"]) {
    if (!Number.isInteger(limits?.[stream]) || limits[stream] < 0 || limits[stream] > 10_000) throw new Error("limits");
    if (targets.some((target) => hasGoal(target, stream))) {
      const counter = origin[`${stream}Counter`];
      if (!Number.isInteger(counter) || counter < 0 || counter + limits[stream] > 0xffffffff) throw new Error("state");
    }
  }
  for (const target of targets) {
    if (!Number.isInteger(target.weaponType) || target.weaponType < 0 || target.weaponType > 13 || !Number.isInteger(target.attributeForce) || target.attributeForce < 0 || target.attributeForce > 9) throw new Error("targets");
    const p = target.planner;
    if (!p.bonusEnabled && !p.skillEnabled) throw new Error("goals");
    if (p.bonusEnabled && !hasBonusGoal(p.acceptable) && !hasBonusGoal(p.preferred)) throw new Error("goals");
    if (p.bonusEnabled && [p.acceptable, p.preferred].some((tier) => Object.entries(tier.maxStats).some(([key, max]) => tier.stats[key] > max))) throw new Error("minAboveMax");
    if (p.bonusEnabled && [p.acceptable, p.preferred].some((tier) => hasBonusGoal(tier) && !canFillSlots(target, Object.keys(tier.maxStats).filter((key) => tier.maxStats[key] === 0)))) throw new Error("excluded");
    if (p.skillEnabled && !p.acceptable.skills.length && !p.preferred.skills.length) throw new Error("goals");
    if (p.bonusEnabled && target.attributeForce >= 6 && [p.acceptable, p.preferred].some((tier) => "element" in tier.stats || tier.maxStats.element > 0) && elementValues(target).some((v) => !Number.isFinite(v))) throw new Error("statusValues");
  }
}

export function samePosition(a, b) {
  return ["baseSeed", "bonusCounter", "skillCounter"].every((key) => a[key] === b[key]);
}

export function routePosition(route, completed) {
  return completed > 0 ? route.steps[completed - 1].after : route.origin;
}

export function routeWeaponsMatch(route, completed, registered) {
  return route.targets.every((target) => {
    const actual = registered.find((v) => v.id === target.id);
    if (!actual || actual.weaponType !== target.weaponType || actual.attributeForce !== target.attributeForce) return false;
    const expected = {
      bonuses: target.planner.currentBonuses,
      skill: target.planner.currentSkill,
      layout: target.keepCategories,
    };
    for (const step of route.steps.slice(0, completed)) {
      if (step.targetId !== target.id) continue;
      const raw = step.rolls.at(-1).raw;
      if (step.stream === "bonus") { expected.bonuses = raw; expected.layout = layoutOf(raw); }
      else expected.skill = raw;
    }
    const p = normalizedPlanner(actual);
    return JSON.stringify([expected.bonuses, expected.skill, expected.layout]) === JSON.stringify([p.currentBonuses, p.currentSkill, actual.keepCategories]);
  });
}
