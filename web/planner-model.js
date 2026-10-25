// Values are gains from the five Gogma reinforcement slots, not total weapon
// stats. Attack is unbloated raw; affinity is in percentage points.
export const BONUS_CATEGORY = Object.freeze({ 8: 0, 12: 0, 15: 0, 9: 1, 13: 1, 16: 1, 11: 2, 14: 2, 6: 3, 10: 3 });
export const STAT_KEYS = ["attack", "affinity", "element", "sharpness", "ammo"];
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

export function statGoalMatches(totals, minimums) {
  return Object.entries(minimums ?? {}).every(([stat, min]) => STAT_KEYS.includes(stat)
    && Number.isFinite(min) && min >= 0 && Number.isFinite(totals[stat]) && totals[stat] >= min);
}

export function skillGoalMatches(index, pairs) {
  return (pairs ?? []).some((pair) => index === pair.seriesIndex * 14 + pair.groupIndex);
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
  const values = Array.isArray(saved.elementValues) && saved.elementValues.length === 2 ? saved.elementValues.map((v) => Number.isFinite(v) && v >= 0 ? v : null) : [null, null];
  return {
    bonusEnabled: saved.bonusEnabled !== false,
    skillEnabled: saved.skillEnabled !== false,
    acceptable: { stats: stats(saved.acceptable?.stats, defaultAcceptable), skills: pairs(saved.acceptable?.skills, preset) },
    preferred: { stats: stats(saved.preferred?.stats, defaultPreferred), skills: pairs(saved.preferred?.skills, preferredSkills) },
    currentBonuses: validBonuses(saved.currentBonuses, target) ? saved.currentBonuses : null,
    currentSkill: Number.isInteger(saved.currentSkill) && saved.currentSkill >= 0 && saved.currentSkill < 294 ? saved.currentSkill : null,
    elementValues: values,
  };
}

export function hasGoal(target, stream) {
  const p = target.planner;
  return stream === "bonus" ? p.bonusEnabled : p.skillEnabled;
}

export function matchesTier(result, target, stream, mode) {
  if (!hasGoal(target, stream)) return true;
  const p = target.planner;
  const matches = (tier) => stream === "bonus"
    ? Object.keys(tier.stats).length > 0 && statGoalMatches(result, tier.stats)
    : skillGoalMatches(result, tier.skills);
  const preferredExists = stream === "bonus" ? Object.keys(p.preferred.stats).length > 0 : p.preferred.skills.length > 0;
  if (mode === "preferred") return matches(preferredExists ? p.preferred : p.acceptable);
  return matches(p.acceptable) || (preferredExists && matches(p.preferred));
}

export function resultQuality(result, target, stream) {
  if (!hasGoal(target, stream)) return "none";
  if (matchesTier(result, target, stream, "preferred")) return "preferred";
  return matchesTier(result, target, stream, "acceptable") ? "acceptable" : "none";
}

export function validatePlannerRequest(request) {
  const { origin, targets, limits } = request;
  if (!Number.isInteger(origin?.baseSeed) || origin.baseSeed < 0 || origin.baseSeed > 99_999_999) throw new Error("state");
  if (!Array.isArray(targets) || !targets.length || targets.length > 8 || new Set(targets.map((t) => t.id)).size !== targets.length) throw new Error("targets");
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
    if (p.bonusEnabled && !Object.keys(p.acceptable.stats).length && !Object.keys(p.preferred.stats).length) throw new Error("goals");
    if (p.skillEnabled && !p.acceptable.skills.length && !p.preferred.skills.length) throw new Error("goals");
    if (p.bonusEnabled && target.attributeForce >= 6 && [p.acceptable, p.preferred].some((tier) => "element" in tier.stats) && elementValues(target).some((v) => !Number.isFinite(v))) throw new Error("statusValues");
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
