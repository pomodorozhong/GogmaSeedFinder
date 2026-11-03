import { normalizedPlanner } from "./planner-model.js";

export const LORDS_SOUL_GROUP_INDEX = 13;
const presetSeries = new Map([[0, [19]], [1, [11, 18]], [3, [11]], [5, [5, 18]], [8, [11]]]);
export const defaultSkills = (weapon) => (presetSeries.get(weapon) ?? []).map((seriesIndex) => ({ seriesIndex, groupIndex: LORDS_SOUL_GROUP_INDEX }));

export function createWeaponProfile(target) {
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { ...target, id, label: target.label ?? "", skillCombinations: target.skillCombinations ?? defaultSkills(target.weaponType),
    keepCategories: Array(5).fill(null), keepSource: null };
}

const validIndex = (value, count) => Number.isSafeInteger(value) && value >= 0 && value < count;
export function normalizeKeepCategories(categories) {
  if (!Array.isArray(categories) || categories.length !== 5) return Array(5).fill(null);
  return categories.map((id) => validIndex(id, 4) ? id : null);
}

function restoreSkills(pairs, catalog) {
  const skills = new Map();
  // Older profiles can store indices as strings. An empty selection is not index zero.
  const index = (value) => value == null || value === "" ? NaN : Number(value);
  for (const pair of pairs) {
    const seriesIndex = index(pair?.seriesIndex);
    const groupIndex = index(pair?.groupIndex);
    if (!validIndex(seriesIndex, catalog.series) || !validIndex(groupIndex, catalog.groups)) continue;
    const key = `${seriesIndex}:${groupIndex}`;
    if (!skills.has(key)) skills.set(key, { seriesIndex, groupIndex });
  }
  return [...skills.values()];
}

export function restoreProfiles(targets, catalog) {
  if (!Array.isArray(targets)) return [];
  return targets.filter((target) => validIndex(target?.weaponType, catalog.weapons) && validIndex(target?.attributeForce, catalog.attributes))
    .slice(0, catalog.weapons * catalog.attributes)
    .map((target, index) => ({
      id: typeof target.id === "string" && target.id ? target.id : `legacy-${index}`,
      weaponType: target.weaponType, attributeForce: target.attributeForce,
      label: typeof target.label === "string" ? target.label.slice(0, 24) : "",
      skillCombinations: Array.isArray(target.skillCombinations) ? restoreSkills(target.skillCombinations, catalog) : defaultSkills(target.weaponType),
      keepCategories: normalizeKeepCategories(target.keepCategories),
      keepSource: typeof target.keepSource === "string" ? target.keepSource : null,
      planner: normalizedPlanner(target),
    }));
}
