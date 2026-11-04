import { availableStats, copiedPlanner, layoutOf, normalizedPlanner, statMaximum, validBonuses, validLayout, validatePlannerRequest } from "./planner-model.js";
import { statName } from "./planner-markup.js";
import { pl } from "./planner-text.js";

const raw = (value) => value == null ? "" : String(value);
const number = (value) => value === "" ? null : Number(value);
const rawTier = (tier) => ({
  stats: Object.fromEntries(Object.entries(tier.stats).map(([key, value]) => [key, raw(value)])),
  maxStats: Object.fromEntries(Object.entries(tier.maxStats).map(([key, value]) => [key, raw(value)])),
  skills: tier.skills.map(({ seriesIndex, groupIndex }) => ({ seriesIndex: raw(seriesIndex), groupIndex: raw(groupIndex) })),
});

// Raw input belongs to the draft, including blanks and temporarily invalid
// numbers. A validated weapon is derived when browsing or saving, never stored
// as a second editable copy of the form.
export function createEditorDraft(target) {
  const weapon = structuredClone(target);
  weapon.planner = normalizedPlanner(weapon);
  const p = weapon.planner;
  return { weapon, fields: {
    label: weapon.label ?? "", bonusEnabled: p.bonusEnabled, skillEnabled: p.skillEnabled,
    acceptable: rawTier(p.acceptable), preferred: rawTier(p.preferred),
    currentBonuses: Array.from({ length: 5 }, (_, i) => raw(p.currentBonuses?.[i])),
    keepCategories: Array.from({ length: 5 }, (_, i) => raw(weapon.keepCategories?.[i])),
    currentSeries: raw(p.currentSkill === null ? null : Math.floor(p.currentSkill / 14)),
    currentGroup: raw(p.currentSkill === null ? null : p.currentSkill % 14),
    elementValues: p.elementValues.map(raw),
  } };
}

export function copyDraftGoals(draft, source) {
  const p = copiedPlanner(source, draft.weapon);
  const f = draft.fields;
  f.bonusEnabled = p.bonusEnabled; f.skillEnabled = p.skillEnabled;
  for (const tier of ["acceptable", "preferred"]) f[tier] = rawTier(p[tier]);
  if (source.weaponType === draft.weapon.weaponType && source.attributeForce === draft.weapon.attributeForce) f.elementValues = p.elementValues.map(raw);
}

function checkNumber(value, maximum) {
  if (value !== "" && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > maximum)) throw new Error(pl("Check the goal fields before continuing."));
}

export function readEditorDraft({ weapon, fields: f }, { validate = true } = {}) {
  const target = { ...weapon, label: f.label.trim(), planner: normalizedPlanner(weapon) };
  const p = target.planner;
  p.bonusEnabled = f.bonusEnabled; p.skillEnabled = f.skillEnabled;
  for (const tier of ["acceptable", "preferred"]) {
    const bounds = (key) => Object.fromEntries(availableStats(target).filter((stat) => f[tier][key][stat] != null && f[tier][key][stat] !== "").map((stat) => {
      const value = f[tier][key][stat];
      checkNumber(value, stat === "element" && target.attributeForce >= 6 ? 9999 : statMaximum(stat, target));
      return [stat, Number(value)];
    }));
    p[tier] = { stats: bounds("stats"), maxStats: bounds("maxStats"), skills: f[tier].skills.map(({ seriesIndex, groupIndex }) => ({ seriesIndex: number(seriesIndex), groupIndex: number(groupIndex) })) };
  }
  const current = f.currentBonuses.map(number);
  p.currentBonuses = current.every((value) => value === null) ? null : current;
  if (p.currentBonuses?.includes(null)) throw new Error(pl("Enter either all five current bonuses or leave all five unknown."));
  target.keepCategories = p.currentBonuses ? layoutOf(p.currentBonuses) : f.keepCategories.map(number);
  if ((p.currentBonuses && !validBonuses(p.currentBonuses, target)) || (target.keepCategories.every((value) => value !== null) && !validLayout(target.keepCategories, target))) throw new Error(pl("The current bonus layout is not valid for this weapon."));
  const series = number(f.currentSeries), group = number(f.currentGroup);
  if ((series === null) !== (group === null)) throw new Error(pl("Select both current skills or leave both unknown."));
  p.currentSkill = series === null ? null : series * 14 + group;
  if (target.attributeForce >= 6 && target.weaponType < 12) {
    f.elementValues.forEach((value) => checkNumber(value, 9999));
    p.elementValues = f.elementValues.map(number);
  }
  for (const tier of ["acceptable", "preferred"]) for (const [key, min] of Object.entries(p[tier].stats)) {
    const max = statMaximum(key, target);
    if (max !== null && min > max) throw new Error(pl("{stat} can gain at most +{max} from five slots.", { stat: statName(key, target), max: `${max}${key === "affinity" ? "%" : ""}` }));
  }
  if (validate) validatePlannerRequest({ origin: { baseSeed: 0, bonusCounter: 0, skillCounter: 0 }, targets: [target], limits: { bonus: 0, skill: 0 } });
  return target;
}

// Chip edits are transactional: reject an invalid tier without changing the
// raw draft or relying on a write/read/rollback through hidden form controls.
export function setDraftTier(draft, tier, value) {
  const before = draft.fields[tier];
  const next = { ...before, ...rawTier({ stats: value.stats ?? {}, maxStats: value.maxStats ?? {}, skills: value.skills ?? [] }) };
  if (!value.stats) { next.stats = before.stats; next.maxStats = before.maxStats; }
  if (!value.skills) next.skills = before.skills;
  const fields = { ...draft.fields, [tier]: next };
  readEditorDraft({ ...draft, fields }, { validate: false });
  draft.fields = fields;
}
