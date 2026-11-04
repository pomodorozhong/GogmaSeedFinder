import { availableStats, BONUS_CATEGORY, statMaximum, statRollValues } from "./planner-model.js";
import { categoryStat, comboOptions, esc, html, options, pairOptions, statName, tierName } from "./planner-markup.js";
import { pl } from "./planner-text.js";

export function skillPairRow({ series, groups }, pair = { seriesIndex: 11, groupIndex: 13 }) {
  return `<div class="pl-combo"><select data-pair="series" aria-label="${html("Series skill")}">${pairOptions(series, pair.seriesIndex, "Any series skill")}</select><span>＋</span><select data-pair="group" aria-label="${html("Group skill")}">${pairOptions(groups, pair.groupIndex, "Any group skill")}</select><button type="button" class="text-button" data-pl-action="remove-pair" aria-label="${html("Remove combination")}">×</button></div>`;
}

// Status maximums depend on II/EX values edited in the same form, so they are
// checked on submit instead of by the input's max.
const statusStat = (key, target) => key === "element" && target.attributeForce >= 6;
function rollHint(key, target) {
  const unit = key === "affinity" ? "%" : "";
  const max = statMaximum(key, target);
  const values = statRollValues(key, target).map(([tier, value]) => `${tier} ${value === null ? "?" : `+${value}${unit}`}`);
  return `<small class="pl-roll-values">${esc(values.join(" · "))}${max === null ? "" : ` · <strong>${html("Max")} +${max}${unit}</strong>`}</small>`;
}

function statRow(target, key) {
  const p = target.planner;
  const limit = statusStat(key, target) ? 9999 : statMaximum(key, target);
  const box = (tier, bound) => `<input type="number" min="0" max="${limit}" step="1" data-stat="${key}" data-tier="${tier}" data-bound="${bound}" value="${p[tier][bound === "min" ? "stats" : "maxStats"][key] ?? ""}" placeholder="${html(bound === "min" ? "Min" : "Max")}" aria-label="${esc(`${tierName(tier)} · ${statName(key, target)} · ${pl(bound === "min" ? "Min" : "Max")}`)}">`;
  return `<tr><th>${esc(statName(key, target))}${key === "affinity" ? " (%)" : ""}${rollHint(key, target)}</th>${["preferred", "acceptable"].map((tier) => `<td><div class="pl-range">${box(tier, "min")}<span aria-hidden="true">–</span>${box(tier, "max")}</div></td>`).join("")}</tr>`;
}

function goalHeading(stream, enabled) {
  const bonus = stream === "bonus";
  const label = html(bonus ? "Use bonus goals" : "Use skill goals");
  return `<div class="pl-section-head"><h3>${html(bonus ? "Bonus goals" : "Skill goals")}</h3><label class="pl-switch" title="${label}"><input name="${stream}Enabled" type="checkbox" aria-label="${label}"${enabled ? " checked" : ""}><span class="pl-switch-track" aria-hidden="true"></span></label></div>`;
}

function slotSelects(field, choices, values) {
  return Array.from({ length: 5 }, (_, i) =>
    `<label>${html("Slot {n}", { n: i + 1 })}<select data-current-${field}="${i}">${options(choices, values?.[i], true)}</select></label>`
  ).join("");
}

function bonusFields(target) {
  const p = target.planner;
  return `<div class="pl-editor-section">${goalHeading("bonus", p.bonusEnabled)}<p class="pl-fine">${html("Blank stats are ignored. Attack uses unbloated raw; affinity uses percentage points. These are gains from the five slots, not final weapon stats.")} ${html("Leave min or max blank for no bound on that side. Max 0 means no slot of that stat.")}</p>
    <div class="pl-goal-table-wrap"><table class="pl-goal-table"><thead><tr><th>${html("Stat")}</th><th class="pl-gold">★ ${html("Top desired")} <small>${html("min – max")}</small></th><th class="pl-teal">✓ ${html("Acceptable")} <small>${html("min – max")}</small></th></tr></thead>
    <tbody>${availableStats(target).map((key) => statRow(target, key)).join("")}</tbody></table></div></div>`;
}

function skillFields(p, metadata) {
  return `<div class="pl-editor-section">${goalHeading("skill", p.skillEnabled)}<p class="pl-fine">${html("A match for any pair in a column meets that goal. Top desired results also count as acceptable.")} ${html("Each reroll gives one series skill and one group skill; a pair matches only when both match. Choose Any to accept a skill on its own.")}</p>
    <div class="pl-skill-goals">${["preferred", "acceptable"].map((mode) => `<section><h4 class="${mode === "preferred" ? "pl-gold" : "pl-teal"}">${mode === "preferred" ? "★" : "✓"} ${esc(tierName(mode))}</h4><div data-pairs="${mode}">${p[mode].skills.map((pair) => skillPairRow(metadata, pair)).join("")}</div><button type="button" class="text-button" data-pl-action="add-pair" data-tier="${mode}">＋ ${html("Add combination")}</button></section>`).join("")}</div></div>`;
}

function currentFields(target, metadata) {
  const { bonuses, bonusName, series, groups } = metadata;
  const p = target.planner;
  const stats = availableStats(target);
  const bonusOptions = bonuses.filter(([id]) => stats.includes(categoryStat(BONUS_CATEGORY[id], target)))
    .map(([id]) => [id, bonusName(target.weaponType, id)]);
  const categories = [...new Set(bonusOptions.map(([id]) => BONUS_CATEGORY[id]))]
    .map((category) => [category, statName(categoryStat(category, target), target)]);
  return `<details class="pl-current-details"><summary>${html("Current weapon (optional)")}</summary><p class="pl-fine">${html("Enter your current bonuses to check goals already met. Known categories also allow Keep Bonuses and can prove goals met by every possible tier combination.")}</p>
    <h4>${html("Current bonuses in game order")}</h4><div class="pl-five-slots">${slotSelects("bonus", bonusOptions, p.currentBonuses)}</div>
    <h4>${html("Or known categories in game order")}</h4><div class="pl-five-slots">${slotSelects("category", categories, target.keepCategories)}</div>
    <h4>${html("Current skills")}</h4><div class="pl-current-pair"><select name="currentSeries" aria-label="${html("Series skill")}">${comboOptions(series, p.currentSkill === null ? null : Math.floor(p.currentSkill / 14), true)}</select><span>＋</span><select name="currentGroup" aria-label="${html("Group skill")}">${comboOptions(groups, p.currentSkill === null ? null : p.currentSkill % 14, true)}</select></div></details>`;
}

export function goalFormMarkup(target, { isNew, sources, nameOf, metadata }) {
  const { weapons, attributes } = metadata;
  const p = target.planner;
  const title = pl(isNew ? "Add weapon" : "Edit weapon");
  return `<form id="pl-goal-form" class="pl-editor" novalidate><div class="section-heading"><div><p class="step">${html("Weapon planner")}</p><h2>${esc(title)}</h2><p class="pl-muted">${esc(nameOf(target))}</p></div><button type="button" class="pl-close" data-pl-action="cancel-edit" aria-label="${html("Close")}">×</button></div>
    <div class="pl-editor-tabs" role="tablist" aria-label="${html("Weapon settings")}"><button type="button" role="tab" id="pl-tab-goals" aria-controls="pl-goals-panel" aria-selected="true" data-pl-action="editor-tab" data-tab="goals">${html("Goals")}</button><button type="button" role="tab" id="pl-tab-finishes" aria-controls="pl-finishes-panel" aria-selected="false" tabindex="-1" data-pl-action="editor-tab" data-tab="finishes">${html("Finishes")}</button></div>
    <section id="pl-goals-panel" role="tabpanel" aria-labelledby="pl-tab-goals">
      <div class="pl-editor-section pl-editor-first"><div class="pl-weapon-fields">${isNew ? `<label>${html("Weapon type")}<select name="weaponType" data-pl-new-type>${options(weapons, target.weaponType)}</select></label><label>${html("Element / status")}<select name="attributeForce" data-pl-new-type>${options(attributes, target.attributeForce)}</select></label>` : ""}<label class="pl-name-field">${html("Weapon name")}<input name="label" value="${esc(target.label)}" maxlength="24" placeholder="${html("Optional name")}"></label></div></div>

      <div class="pl-goals-card"><div class="pl-goals-head"><h3>${html("Goals")}</h3>${sources.length ? `<div class="pl-copy-wrap"><button type="button" class="pl-copy-chip" data-pl-action="copy-menu" aria-haspopup="menu" aria-expanded="false">${html("Copy goals from")}…</button><div class="pl-copy-menu" role="menu" hidden><span class="pl-copy-title">${html("Copy goals from")}</span>${sources.map((v) => `<button type="button" role="menuitem" data-pl-action="copy-from" data-id="${esc(v.id)}">${esc(nameOf(v))}</button>`).join("")}</div></div>` : ""}</div>${bonusFields(target)}
      ${skillFields(p, metadata)}
      ${currentFields(target, metadata)}
      ${target.attributeForce >= 6 && target.weaponType < 12 ? `<div class="pl-status-values"><h4>${html("Status boost values")}</h4><p class="pl-fine">${html("Enter the II and EX gains shown on this weapon to use a status minimum.")}</p>${[0, 1].map((index) => `<label>${index === 0 ? "II" : "EX"}<input name="element${index}" type="number" min="0" max="9999" step="1" value="${p.elementValues[index] ?? ""}"></label>`).join("")}</div>` : ""}</div></section>
    <section id="pl-finishes-panel" role="tabpanel" aria-labelledby="pl-tab-finishes" hidden></section>
    <p id="pl-editor-error" class="error" role="alert" hidden></p>
    <div class="pl-editor-footer"><button class="text-button" type="button" data-pl-action="cancel-edit">${html("Cancel")}</button><button class="primary" type="submit">${html(isNew ? "Add weapon" : "Save weapon")}</button></div></form>`;
}

// DOM adapters capture input and project draft values. A partial number keeps
// the raw draft invalid until the user finishes editing it.
const inputValue = (input) => input.validity.badInput ? "-" : input.value;

function captureTier(form, tier) {
  const bounds = (bound) => Object.fromEntries([...form.querySelectorAll(`[data-tier="${tier}"][data-bound="${bound}"]`)]
    .map((input) => [input.dataset.stat, inputValue(input)]));
  const skills = [...form.querySelectorAll(`[data-pairs="${tier}"] .pl-combo`)].map((row) => ({
    seriesIndex: row.querySelector('[data-pair="series"]').value,
    groupIndex: row.querySelector('[data-pair="group"]').value,
  }));
  return { stats: bounds("min"), maxStats: bounds("max"), skills };
}

export function captureGoalFields(form) {
  return {
    label: form.elements.label.value, bonusEnabled: form.elements.bonusEnabled.checked, skillEnabled: form.elements.skillEnabled.checked,
    acceptable: captureTier(form, "acceptable"), preferred: captureTier(form, "preferred"),
    currentBonuses: [...form.querySelectorAll("[data-current-bonus]")].map(inputValue),
    keepCategories: [...form.querySelectorAll("[data-current-category]")].map(inputValue),
    currentSeries: form.elements.currentSeries.value, currentGroup: form.elements.currentGroup.value,
    elementValues: [form.elements.element0, form.elements.element1].map((input) => input ? inputValue(input) : ""),
  };
}

export function writeGoalFields(form, fields, metadata) {
  const writeValue = (input, value) => { if (value !== "-") input.value = value; };
  form.elements.label.value = fields.label;
  form.elements.bonusEnabled.checked = fields.bonusEnabled;
  form.elements.skillEnabled.checked = fields.skillEnabled;
  for (const tier of ["acceptable", "preferred"]) {
    const values = fields[tier];
    form.querySelector(`[data-pairs="${tier}"]`).innerHTML = values.skills.map((pair) => skillPairRow(metadata, {
      seriesIndex: pair.seriesIndex === "" ? null : Number(pair.seriesIndex),
      groupIndex: pair.groupIndex === "" ? null : Number(pair.groupIndex),
    })).join("");
    for (const input of form.querySelectorAll(`[data-tier="${tier}"][data-stat]`)) writeValue(input, (input.dataset.bound === "min" ? values.stats : values.maxStats)[input.dataset.stat] ?? "");
  }
  for (const [selector, values] of [["[data-current-bonus]", fields.currentBonuses], ["[data-current-category]", fields.keepCategories]]) [...form.querySelectorAll(selector)].forEach((input, i) => { input.value = values[i]; });
  form.elements.currentSeries.value = fields.currentSeries;
  form.elements.currentGroup.value = fields.currentGroup;
  fields.elementValues.forEach((value, i) => { if (form.elements[`element${i}`]) writeValue(form.elements[`element${i}`], value); });
}
