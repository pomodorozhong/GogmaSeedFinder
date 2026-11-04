import { localizedTargetName, t } from "./i18n.js";
import { availableStats, BONUS_CATEGORY, hasBonusGoal } from "./planner-model.js";
import { pl } from "./planner-text.js";

export const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const html = (source, values) => esc(pl(source, values));
export const tierName = (tier) => pl(tier === "preferred" ? "Top desired" : "Acceptable");
export const statName = (key, target) => pl(key === "element" && target.attributeForce >= 6 ? "Status" : ({ attack: "Attack", affinity: "Affinity", element: "Element", sharpness: "Sharpness", ammo: "Ammo" })[key]);

export const categoryStat = (category, target) => ["attack", "affinity", "element", target.weaponType >= 12 ? "ammo" : "sharpness"][category];

export const options = (items, selected, unknown = false) => `${unknown ? `<option value="">${html("Unknown")}</option>` : ""}${items.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${esc(t(label))}</option>`).join("")}`;
export const comboOptions = (labels, selected, unknown = false) => options(labels.map((label, index) => [index, label]), selected, unknown);
export const pairOptions = (labels, selected, anyLabel) => `<option value=""${selected === null ? " selected" : ""}>${html(anyLabel)}</option>${comboOptions(labels, selected)}`;

const actions = { reset: "Reset Bonuses", keep: "Keep Bonuses", skill: "Reset Skills" };
export const actionName = (action) => pl(actions[action]);

export function weaponName(target, { weapons, attributes }) {
  if (target.label) return target.label;
  const label = (options, value) => options.find(([id]) => id === value)?.[1] ?? "";
  return localizedTargetName(label(weapons, target.weaponType), label(attributes, target.attributeForce));
}

export function skillPairsText(pairs, { series, groups }) {
  return pairs.map(({ seriesIndex, groupIndex }) => {
    const first = seriesIndex === null ? pl("Any series skill") : t(series[seriesIndex]);
    const second = groupIndex === null ? pl("Any group skill") : t(groups[groupIndex]);
    return `${first} / ${second}`;
  }).join(" · ");
}

export function skillText(index, { series, groups }) {
  return `${t(series[Math.floor(index / 14)])} / ${t(groups[index % 14])}`;
}

export function statsText(stats, target) {
  const available = availableStats(target);
  return Object.entries(stats ?? {}).filter(([key, value]) => available.includes(key) && value !== 0)
    .map(([key, value]) => `${statName(key, target)} ${value === null ? "?" : `+${value}${key === "affinity" ? "%" : ""}`}`)
    .join(" · ");
}

const bonusTiers = new Map([[15, "EX"], [16, "EX"], [14, "EX"], [10, "EX"], [12, "III"], [13, "III"], [8, "II"], [9, "II"], [11, "II"]]);

export function resultMarkup(result, stream, target, { series, groups, bonusName }) {
  if (stream === "skill") {
    return `<div class="pl-skill-result"><span>${esc(t(series[Math.floor(result.raw / 14)]))}</span><span>${esc(t(groups[result.raw % 14]))}</span></div>`;
  }
  const tiers = [target.planner.acceptable, target.planner.preferred];
  const zeroGoal = (key) => tiers.some((tier) => tier.stats[key] === 0) && !tiers.some((tier) => tier.stats[key] > 0 || key in tier.maxStats);
  const totals = Object.fromEntries(Object.entries(result.totals).filter(([key]) => !zeroGoal(key)));
  const chips = result.raw.map((id) => {
    const category = BONUS_CATEGORY[id];
    const label = statName(categoryStat(category, target), target);
    const tier = bonusTiers.get(id) ?? "";
    return `<span class="pl-chip pl-cat-${category}${tier === "EX" ? " is-ex" : ""}" title="${esc(t(bonusName(target.weaponType, id)))}">${esc(label)} ${tier}</span>`;
  }).join("");
  return `<strong class="pl-totals">${esc(statsText(totals, target))}</strong><div class="pl-chips">${chips}</div>`;
}

export const goalFor = (target, mode, stream) => {
  const p = target.planner;
  const other = p[mode === "preferred" ? "acceptable" : "preferred"];
  if (stream === "bonus") return hasBonusGoal(p[mode]) ? p[mode] : other;
  return p[mode].skills.length ? p[mode].skills : other.skills;
};
// "Attack +30", "Attack ≤ +40", "Attack +30–40", or "No Attack" for max 0.
// A minimum of 0 is always met, so it reads like no bound.
const rangeText = (tier, target) => availableStats(target).map((key) => {
  const unit = key === "affinity" ? "%" : "";
  const name = statName(key, target);
  const min = tier.stats[key] || null;
  const max = tier.maxStats[key];
  if (max === 0) return pl("No {stat}", { stat: name });
  if (max === undefined) return min === null ? "" : `${name} +${min}${unit}`;
  return min === null ? `${name} ≤ +${max}${unit}` : `${name} +${min}–${max}${unit}`;
}).filter(Boolean).join(" · ");
export const bonusGoalText = (target, mode) => rangeText(goalFor(target, mode, "bonus"), target);

export const stateCode = (state) => state.baseSeed === null ? pl("Unknown") : `GSF2-B${state.baseSeed}-G${state.bonusCounter ?? "?"}-S${state.skillCounter ?? "?"}`;
