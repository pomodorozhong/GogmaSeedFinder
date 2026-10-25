import { t, localizedTargetName } from "./i18n.js";
import { pl } from "./planner-text.js";
import { availableStats, BONUS_CATEGORY, copiedPlanner, hasBonusGoal, layoutOf, MAX_SELECTED, normalizedPlanner, routePosition, routeWeaponsMatch, samePosition, statMaximum, statRollValues, validBonuses, validLayout, validatePlannerRequest } from "./planner-model.js";

const STORAGE_KEY = "gogma-weapon-planner-v1";
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (source, values) => esc(pl(source, values));
const actionName = (action) => pl(({ reset: "Reset Bonuses", keep: "Keep Bonuses", skill: "Reset Skills" })[action]);
const tierName = (tier) => pl(tier === "preferred" ? "Top desired" : "Acceptable");
const number = (value) => value === null || value === undefined ? pl("Unknown") : value.toLocaleString();
const stateCode = (state) => state.baseSeed === null ? pl("Unknown") : `GSF2-B${state.baseSeed}-G${state.bonusCounter ?? "?"}-S${state.skillCounter ?? "?"}`;
const errorText = (key) => pl(({ targets: "Select between 1 and {max} weapons.", state: "Enter a known base seed and the counters for the streams you want to plan.", limits: "Enter whole-number roll limits from 0 to 10,000.", goals: "Enable at least one goal per weapon and enter a stat minimum or skill pair.", statusValues: "Enter both status boost values before using a status minimum.", excluded: "Excluding these stats leaves too few bonuses to fill five slots.", minAboveMax: "A minimum is higher than its maximum." })[key] ?? "Unable to calculate the guide. {detail}", { detail: key, max: MAX_SELECTED });

export function initPlanner({ root, getState, getTargets, setTargets, saveStep, openState, metadata }) {
  const { weapons, attributes, bonuses, bonusName, series, groups, defaultSkills } = metadata;
  let stored;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { stored = null; }
  const cache = {
    selected: Array.isArray(stored?.selected) ? stored.selected.filter((v) => typeof v === "string") : getTargets().slice(0, MAX_SELECTED).map((target) => target.id),
    limits: { bonus: stored?.limits?.bonus ?? 250, skill: stored?.limits?.skill ?? 1000 },
    side: stored?.side === "right" ? "right" : "left",
    routes: stored?.routes && typeof stored.routes === "object" ? stored.routes : {},
    mode: stored?.mode === "preferred" ? "preferred" : "acceptable",
    completed: Number.isInteger(stored?.completed) && stored.completed >= 0 ? stored.completed : 0,
    matches: stored?.matches && typeof stored.matches === "object" ? stored.matches : {},
    signature: typeof stored?.signature === "string" ? stored.signature : "",
  };
  // Browser data is optional. Ignore an incompatible/corrupt stored route.
  for (const mode of ["acceptable", "preferred"]) {
    const route = cache.routes[mode];
    if (route && (!Array.isArray(route.steps) || !Array.isArray(route.targets) || !route.origin || !route.bonus || !route.skill || route.steps.some((step) => !step.after || !Array.isArray(step.rolls) || !step.rolls.length))) delete cache.routes[mode];
  }
  if (!cache.routes[cache.mode]) cache.completed = 0;
  else cache.completed = Math.min(cache.completed, cache.routes[cache.mode].steps.length);
  let inspected = cache.completed;
  let worker = null;
  let activeContext = "";
  let editing = null;
  let stale = false;
  let storageAvailable = true;
  let lastExternal = "";
  let pointerFrame = null;
  const nameOf = (target) => target.label || localizedTargetName(weapons.find(([id]) => id === target.weaponType)?.[1] ?? "", attributes.find(([id]) => id === target.attributeForce)?.[1] ?? "");
  const prepared = () => getTargets().filter((target) => cache.selected.includes(target.id)).map((target) => ({ ...target, planner: normalizedPlanner(target) }));
  const signature = () => JSON.stringify(prepared().map((target) => ({ id: target.id, label: target.label, weaponType: target.weaponType, attributeForce: target.attributeForce, planner: { optional: target.planner.optional, bonusEnabled: target.planner.bonusEnabled, skillEnabled: target.planner.skillEnabled, acceptable: target.planner.acceptable, preferred: target.planner.preferred, elementValues: target.planner.elementValues } })));
  const route = () => cache.routes[cache.mode];
  const compatible = () => Boolean(route()) && !stale && cache.signature === signature() && samePosition(getState(), routePosition(route(), cache.completed)) && routeWeaponsMatch(route(), cache.completed, getTargets());
  const statName = (key, target) => pl(key === "element" && target.attributeForce >= 6 ? "Status" : ({ attack: "Attack", affinity: "Affinity", element: "Element", sharpness: "Sharpness", ammo: "Ammo" })[key]);
  // A zero minimum is always met, so it is shown like a blank goal.
  const statsText = (stats, target) => Object.entries(stats ?? {}).filter(([key, value]) => availableStats(target).includes(key) && value !== 0).map(([key, value]) => `${statName(key, target)} ${value === null ? "?" : `+${value}${key === "affinity" ? "%" : ""}`}`).join(" · ");
  const skillText = (index) => `${t(series[Math.floor(index / 14)])} / ${t(groups[index % 14])}`;
  const pairText = (pairs) => pairs.map((p) => skillText(p.seriesIndex * 14 + p.groupIndex)).join(" · ");
  const goalFor = (target, mode, stream) => {
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
  const bonusGoalText = (target, mode) => rangeText(goalFor(target, mode, "bonus"), target);
  const goalSummary = (target, mode) => {
    const p = target.planner;
    return [p.bonusEnabled ? bonusGoalText(target, mode) || pl("Any stats") : pl("Bonus goals off"), p.skillEnabled ? pairText(goalFor(target, mode, "skill")) || pl("Any skills") : pl("Skill goals off")].join(" / ");
  };
  const options = (items, selected, unknown = false) => `${unknown ? `<option value="">${html("Unknown")}</option>` : ""}${items.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${esc(t(label))}</option>`).join("")}`;
  const comboOptions = (labels, selected, unknown = false) => options(labels.map((label, index) => [index, label]), selected, unknown);

  root.innerHTML = `
    <header class="pl-page-heading"><div><p class="step">WEAPON PLANNER</p><h2>${html("Plan your weapons, roll by roll.")}</h2><p class="pl-muted">${html("Choose your weapons and minimum stat gains. Get a complete bonus and skill route.")}</p></div><span id="pl-storage" class="pl-storage"></span></header>
    <div class="pl-state-strip"><span>${html("Saved position")}</span><code id="pl-position"></code><button class="text-button" type="button" data-pl-action="state">${html("Set current state")}</button></div>
    <section class="pl-section" aria-labelledby="pl-weapons-title"><div class="pl-section-heading"><div><h3 id="pl-weapons-title"><span class="pl-index">01</span> ${html("Your weapons")}</h3><p class="pl-muted">${html("Select up to {max} weapons. Each copy is planned separately.", { max: MAX_SELECTED })}</p></div><button class="secondary small-button" type="button" data-pl-action="add">＋ ${html("Add weapon")}</button></div>
      <form id="pl-add-form" class="pl-add-form" hidden><label>${html("Weapon name")}<input name="label" maxlength="24" placeholder="${html("Optional name")}"></label><label>${html("Weapon type")}<select name="weaponType">${options(weapons, 3)}</select></label><label>${html("Element / status")}<select name="attributeForce">${options(attributes, 1)}</select></label><label>${html("Copy goals from")}<select name="copyFrom"></select></label><button class="secondary small-button" type="submit">${html("Add weapon")}</button><button class="text-button" type="button" data-pl-action="cancel-add">${html("Cancel")}</button></form>
      <div id="pl-weapons" class="pl-weapon-grid"></div><div id="pl-editor"></div>
    </section>
    <form id="pl-limits" class="pl-limits"><div class="pl-limit-copy"><h3><span class="pl-index">02</span> ${html("Search limits")}</h3><p class="pl-muted">${html("Two independent roll windows from your saved position.")}</p></div><label>${html("Bonus rolls")}<input name="bonus" type="number" min="0" max="10000" step="1" value="${esc(cache.limits.bonus)}" required></label><label>${html("Skill rolls")}<input name="skill" type="number" min="0" max="10000" step="1" value="${esc(cache.limits.skill)}" required></label><button id="pl-build" class="primary" type="submit">${html("Build guides")}</button><button id="pl-cancel" class="secondary" type="button" data-pl-action="cancel" hidden>${html("Cancel search")}</button></form>
    <div class="pl-feedback"><p id="pl-status" class="pl-muted" role="status">${html("Ready to plan.")}</p><p id="pl-error" class="error" role="alert" hidden></p><p class="pl-fine">${html("No roll data is changed until you confirm a step as done and saved in game.")}</p></div>
    <section id="pl-results" class="pl-section" hidden><div class="pl-section-heading"><h3><span class="pl-index">03</span> ${html("Choose your route")}</h3><div class="pl-legend"><span class="pl-gold">★ ${html("Top desired")}</span><span class="pl-teal">✓ ${html("Acceptable")}</span></div></div><div id="pl-routes" class="pl-routes"></div><div id="pl-route-note"></div><div id="pl-alternatives" class="pl-alternatives" hidden></div>
      <div id="pl-detail-heading" class="pl-section-heading pl-detail-heading"><div><h3>${html("Detailed route")}</h3><p id="pl-saved-count" class="pl-muted"></p></div><label class="pl-side-label"><span class="sr-only">${html("Detailed route")}</span><select id="pl-side"><option value="left">${html("Guide on left")}</option><option value="right">${html("Guide on right")}</option></select></label></div><div id="pl-route-complete" class="pl-complete" hidden></div><div id="pl-workspace" class="pl-workspace"><aside id="pl-guide" class="pl-guide" aria-label="${html("Current step")}"></aside><div id="pl-rows" class="pl-table-area"></div></div>
    </section><p class="pl-fine pl-engine-note">${html("Planning uses the existing game RNG engine. Element deltas vary by weapon; status deltas can be entered in the weapon editor.")}</p>`;
  const q = (selector) => root.querySelector(selector);
  const setError = (message = "") => { q("#pl-error").textContent = message; q("#pl-error").hidden = !message; };
  const setStatus = (text) => { q("#pl-status").textContent = text; };
  const persist = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); storageAvailable = true; }
    catch { storageAvailable = false; }
    q("#pl-storage").textContent = pl(storageAvailable ? "Progress saved in this browser" : "Browser storage is unavailable. Keep a copy of your save-state code before leaving.");
  };
  function invalidate() {
    stopWorker();
    stale = Object.keys(cache.routes).length > 0;
    cache.signature = "";
    cache.matches = {};
    setStatus(pl("Build new guides to apply the updated goals or limits."));
    persist(); renderResults();
  }
  function renderWeapons() {
    q("#pl-weapons").innerHTML = getTargets().length ? getTargets().map((raw) => {
      const target = { ...raw, planner: normalizedPlanner(raw) };
      const checked = cache.selected.includes(target.id);
      return `<article class="pl-weapon${checked ? " is-selected" : ""}"><div class="pl-weapon-head"><label><input type="checkbox" data-pl-select="${esc(target.id)}"${checked ? " checked" : ""}><span><strong>${esc(nameOf(target))}</strong><small>${esc(localizedTargetName(weapons.find(([id]) => id === target.weaponType)[1], attributes.find(([id]) => id === target.attributeForce)[1]))}</small></span></label><button type="button" class="text-button pl-remove" data-pl-action="remove" data-id="${esc(target.id)}" aria-label="${html("Remove weapon")}: ${esc(nameOf(target))}">×</button></div><div class="pl-goal-mini pl-preferred"><span>★</span><span>${esc(goalSummary(target, "preferred"))}</span></div><div class="pl-goal-mini pl-acceptable"><span>✓</span><span>${esc(goalSummary(target, "acceptable"))}</span></div><label class="pl-optional"><input type="checkbox" data-pl-optional="${esc(target.id)}"${target.planner.optional ? " checked" : ""}>${html("Optional: leave out if it cannot fit")}</label><div class="pl-weapon-actions"><button class="text-button pl-edit" type="button" data-pl-action="edit" data-id="${esc(target.id)}">${html("Edit goals")} →</button><button class="text-button pl-edit" type="button" data-pl-action="duplicate" data-id="${esc(target.id)}" aria-label="${html("Duplicate")}: ${esc(nameOf(target))}">${html("Duplicate")}</button></div></article>`;
    }).join("") : `<div class="pl-empty">${html("Add your first weapon to start planning.")}</div>`;
  }
  function comboRow(pair = { seriesIndex: 11, groupIndex: 13 }) {
    return `<div class="pl-combo"><select data-pair="series" aria-label="${html("Series skill")}">${comboOptions(series, pair.seriesIndex)}</select><span>＋</span><select data-pair="group" aria-label="${html("Group skill")}">${comboOptions(groups, pair.groupIndex)}</select><button type="button" class="text-button" data-pl-action="remove-pair" aria-label="${html("Remove combination")}">×</button></div>`;
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
  function renderEditor(id) {
    const raw = getTargets().find((target) => target.id === id);
    if (!raw) return;
    editing = id;
    const target = { ...raw, planner: normalizedPlanner(raw) };
    const p = target.planner;
    const bonusOptions = bonuses.filter(([id]) => availableStats(target).includes(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]])).map(([id]) => [id, bonusName(target.weaponType, id)]);
    const sources = getTargets().filter((v) => v.id !== id);
    const categories = [...new Set(bonusOptions.map(([id]) => BONUS_CATEGORY[id]))].map((category) => [category, statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[category], target)]);
    q("#pl-editor").innerHTML = `<form id="pl-goal-form" class="pl-editor"><div class="pl-section-heading"><h3>${html("Edit weapon goals")} · ${esc(nameOf(target))}</h3><button class="text-button" type="button" data-pl-action="cancel-edit">${html("Cancel")}</button></div><label class="pl-name-field">${html("Weapon name")}<input name="label" value="${esc(target.label)}" maxlength="24" placeholder="${html("Optional name")}"></label>${sources.length ? `<label class="pl-name-field">${html("Copy goals from")}<select data-copy-goals><option value="">${html("Choose a weapon")}</option>${sources.map((v) => `<option value="${esc(v.id)}">${esc(nameOf(v))}</option>`).join("")}</select></label>` : ""}
      <div class="pl-editor-section"><label class="pl-toggle"><input name="bonusEnabled" type="checkbox"${p.bonusEnabled ? " checked" : ""}>${html("Use bonus goals")}</label><p class="pl-fine">${html("Blank stats are ignored. Attack uses unbloated raw; affinity uses percentage points. These are gains from the five slots, not final weapon stats.")} ${html("Leave min or max blank for no bound on that side. Max 0 means no slot of that stat.")}</p><div class="pl-goal-table-wrap"><table class="pl-goal-table"><thead><tr><th>${html("Stat")}</th><th class="pl-teal">✓ ${html("Acceptable")} <small>${html("min – max")}</small></th><th class="pl-gold">★ ${html("Top desired")} <small>${html("min – max")}</small></th></tr></thead><tbody>${availableStats(target).map((key) => {
        const limit = statusStat(key, target) ? 9999 : statMaximum(key, target);
        const box = (tier, bound) => `<input type="number" min="0" max="${limit}" step="1" data-stat="${key}" data-tier="${tier}" data-bound="${bound}" value="${p[tier][bound === "min" ? "stats" : "maxStats"][key] ?? ""}" placeholder="${html(bound === "min" ? "Min" : "Max")}" aria-label="${esc(`${tierName(tier)} · ${statName(key, target)} · ${pl(bound === "min" ? "Min" : "Max")}`)}">`;
        return `<tr><th>${esc(statName(key, target))}${key === "affinity" ? " (%)" : ""}${rollHint(key, target)}</th>${["acceptable", "preferred"].map((tier) => `<td><div class="pl-range">${box(tier, "min")}<span aria-hidden="true">–</span>${box(tier, "max")}</div></td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div></div>
      <div class="pl-editor-section"><label class="pl-toggle"><input name="skillEnabled" type="checkbox"${p.skillEnabled ? " checked" : ""}>${html("Use skill goals")}</label><p class="pl-fine">${html("A match for any pair in a column meets that goal. Top desired results also count as acceptable.")}</p><div class="pl-skill-goals">${["acceptable", "preferred"].map((mode) => `<section><h4 class="${mode === "preferred" ? "pl-gold" : "pl-teal"}">${mode === "preferred" ? "★" : "✓"} ${esc(tierName(mode))}</h4><div data-pairs="${mode}">${p[mode].skills.map(comboRow).join("")}</div><button type="button" class="text-button" data-pl-action="add-pair" data-tier="${mode}">＋ ${html("Add combination")}</button></section>`).join("")}</div></div>
      <details class="pl-current-details"><summary>${html("Current weapon (optional)")}</summary><p class="pl-fine">${html("Enter all five current bonuses to skip goals already met. An ordered category layout alone allows Keep Bonuses, but cannot prove a goal is already met.")}</p><h4>${html("Current bonuses in game order")}</h4><div class="pl-five-slots">${Array.from({ length: 5 }, (_, index) => `<label>${html("Slot {n}", { n: index + 1 })}<select data-current-bonus="${index}">${options(bonusOptions, p.currentBonuses?.[index], true)}</select></label>`).join("")}</div><h4>${html("Or known categories in game order")}</h4><div class="pl-five-slots">${Array.from({ length: 5 }, (_, index) => `<label>${html("Slot {n}", { n: index + 1 })}<select data-current-category="${index}">${options(categories, target.keepCategories?.[index], true)}</select></label>`).join("")}</div><h4>${html("Current skills")}</h4><div class="pl-current-pair"><select name="currentSeries" aria-label="${html("Series skill")}">${comboOptions(series, p.currentSkill === null ? null : Math.floor(p.currentSkill / 14), true)}</select><span>＋</span><select name="currentGroup" aria-label="${html("Group skill")}">${comboOptions(groups, p.currentSkill === null ? null : p.currentSkill % 14, true)}</select></div></details>
      ${target.attributeForce >= 6 && target.weaponType < 12 ? `<div class="pl-status-values"><h4>${html("Status boost values")}</h4><p class="pl-fine">${html("Enter the II and EX gains shown on this weapon to use a status minimum.")}</p>${[0, 1].map((index) => `<label>${index === 0 ? "II" : "EX"}<input name="element${index}" type="number" min="0" max="9999" step="1" value="${p.elementValues[index] ?? ""}"></label>`).join("")}</div>` : ""}<p id="pl-editor-error" class="error" role="alert" hidden></p><div class="pl-editor-footer"><button class="secondary" type="submit">${html("Save goals")}</button><button class="text-button" type="button" data-pl-action="cancel-edit">${html("Cancel")}</button></div></form>`;
    q("#pl-goal-form").addEventListener("submit", submitGoals);
    q("#pl-goal-form input").focus({ preventScroll: true });
    q("#pl-goal-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  // Fills the open form only; nothing is stored until the goals are saved.
  function copyGoals(sourceId) {
    const raw = getTargets().find((target) => target.id === sourceId);
    const current = getTargets().find((target) => target.id === editing);
    const form = q("#pl-goal-form");
    if (!raw || !current || !form) return;
    const p = copiedPlanner(raw, current);
    form.elements.bonusEnabled.checked = p.bonusEnabled;
    form.elements.skillEnabled.checked = p.skillEnabled;
    for (const input of form.querySelectorAll("[data-stat]")) input.value = p[input.dataset.tier][input.dataset.bound === "min" ? "stats" : "maxStats"][input.dataset.stat] ?? "";
    for (const mode of ["acceptable", "preferred"]) form.querySelector(`[data-pairs="${mode}"]`).innerHTML = p[mode].skills.map(comboRow).join("");
    if (form.elements.element0 && raw.attributeForce === current.attributeForce) [0, 1].forEach((i) => { form.elements[`element${i}`].value = p.elementValues[i] ?? ""; });
  }
  // Duplicate reuses the add form so the copy's element can differ.
  function openAddForm(source = null) {
    const form = q("#pl-add-form");
    form.elements.copyFrom.innerHTML = `<option value="">${html("None")}</option>${getTargets().map((v) => `<option value="${esc(v.id)}">${esc(nameOf(v))}</option>`).join("")}`;
    form.elements.copyFrom.value = source?.id ?? "";
    if (source) { form.elements.weaponType.value = source.weaponType; form.elements.attributeForce.value = source.attributeForce; }
    form.elements.label.value = "";
    form.hidden = false;
    (source ? form.elements.attributeForce : form.elements.label).focus();
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function uniqueLabel(baseName) {
    let label = baseName; let count = 1;
    while (getTargets().some((v) => nameOf(v) === label)) label = `${baseName} ${++count}`;
    return label;
  }
  function submitGoals(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = getTargets().find((target) => target.id === editing);
    if (!raw) return;
    const target = { ...raw, planner: normalizedPlanner(raw) };
    const p = target.planner;
    try {
      target.label = form.elements.label.value.trim();
      p.bonusEnabled = form.elements.bonusEnabled.checked;
      p.skillEnabled = form.elements.skillEnabled.checked;
      for (const mode of ["acceptable", "preferred"]) {
        const bound = (which) => Object.fromEntries([...form.querySelectorAll(`[data-tier="${mode}"][data-bound="${which}"]`)].filter((input) => input.value !== "").map((input) => [input.dataset.stat, Number(input.value)]));
        p[mode].stats = bound("min");
        p[mode].maxStats = bound("max");
        p[mode].skills = [...form.querySelectorAll(`[data-pairs="${mode}"] .pl-combo`)].map((row) => ({ seriesIndex: Number(row.querySelector('[data-pair="series"]').value), groupIndex: Number(row.querySelector('[data-pair="group"]').value) }));
      }
      const current = [...form.querySelectorAll("[data-current-bonus]")].map((input) => input.value === "" ? null : Number(input.value));
      if (current.some((v) => v !== null) && current.some((v) => v === null)) throw new Error(pl("Enter either all five current bonuses or leave all five unknown."));
      p.currentBonuses = current.every((v) => v === null) ? null : current;
      target.keepCategories = p.currentBonuses ? layoutOf(p.currentBonuses) : [...form.querySelectorAll("[data-current-category]")].map((input) => input.value === "" ? null : Number(input.value));
      if ((p.currentBonuses && !validBonuses(p.currentBonuses, target)) || (target.keepCategories.every((v) => v !== null) && !validLayout(target.keepCategories, target))) throw new Error(pl("The current bonus layout is not valid for this weapon."));
      const si = form.elements.currentSeries.value; const gi = form.elements.currentGroup.value;
      if ((si === "") !== (gi === "")) throw new Error(pl("Select both current skills or leave both unknown."));
      p.currentSkill = si === "" ? null : Number(si) * 14 + Number(gi);
      if (target.attributeForce >= 6 && target.weaponType < 12) p.elementValues = [0, 1].map((i) => form.elements[`element${i}`].value === "" ? null : Number(form.elements[`element${i}`].value));
      for (const mode of ["acceptable", "preferred"]) {
        for (const [key, min] of Object.entries(p[mode].stats)) {
          const max = statMaximum(key, target);
          if (max !== null && min > max) throw new Error(pl("{stat} can gain at most +{max} from five slots.", { stat: statName(key, target), max: `${max}${key === "affinity" ? "%" : ""}` }));
        }
      }
      // Validate goals without requiring a discovered seed in the editor.
      validatePlannerRequest({ origin: { baseSeed: 0, bonusCounter: 0, skillCounter: 0 }, targets: [target], limits: { bonus: 0, skill: 0 } });
      target.keepSource = "手入力";
      setTargets(getTargets().map((v) => v.id === editing ? target : v));
      editing = null; q("#pl-editor").replaceChildren();
      invalidate(); renderWeapons();
    } catch (error) {
      const message = ["goals", "statusValues", "excluded", "minAboveMax", "targets", "limits", "state"].includes(error.message) ? errorText(error.message) : error.message;
      q("#pl-editor-error").textContent = message; q("#pl-editor-error").hidden = false;
    }
  }
  function badge(step) {
    const quality = step.rolls.at(-1).quality;
    if (step.intent === "finish") return `<span class="pl-badge pl-${quality}">${quality === "preferred" ? "★" : "✓"} ${esc(tierName(quality))}</span>`;
    return `<span class="pl-badge pl-neutral">${html(step.intent === "acquire" ? "Layout acquired" : "Advance")}</span>`;
  }
  function chips(raw, target) {
    const short = (id) => {
      const category = BONUS_CATEGORY[id];
      const label = statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[category], target);
      const tier = [15, 16, 14, 10].includes(id) ? "EX" : [12, 13].includes(id) ? "III" : [8, 9, 11].includes(id) ? "II" : "";
      return `<span class="pl-chip pl-cat-${category}${tier === "EX" ? " is-ex" : ""}" title="${esc(t(bonusName(target.weaponType, id)))}">${esc(label)} ${tier}</span>`;
    };
    return `<div class="pl-chips">${raw.map(short).join("")}</div>`;
  }
  function resultMarkup(result, step, target) {
    if (step.stream === "skill") return `<div class="pl-skill-result"><span>${esc(t(series[Math.floor(result.raw / 14)]))}</span><span>${esc(t(groups[result.raw % 14]))}</span></div>`;
    const tiers = [target.planner.acceptable, target.planner.preferred];
    const zeroGoal = (key) => tiers.some((tier) => tier.stats[key] === 0) && !tiers.some((tier) => tier.stats[key] > 0 || key in tier.maxStats);
    const totals = Object.fromEntries(Object.entries(result.totals).filter(([key]) => !zeroGoal(key)));
    return `<strong class="pl-totals">${esc(statsText(totals, target))}</strong>${chips(result.raw, target)}`;
  }
  const droppedNames = (route) => (route.dropped ?? []).map(({ id, reason, optional }) => `${nameOf(route.targets.find((v) => v.id === id))} (${pl(({ unreachable: "no match within the roll limits", unchecked: "not checked: search limit reached" })[reason] ?? "needs the same rolls as another weapon")}${optional ? ` · ${pl("optional")}` : ""})`).join(", ");
  const shortNames = (route, reason = null) => (route.dropped ?? []).filter((v) => !reason || v.reason === reason).map(({ id }) => nameOf(route.targets.find((v) => v.id === id))).join(", ");
  function renderResults() {
    const modes = ["acceptable", "preferred"];
    const hasRoutes = modes.some((mode) => cache.routes[mode]);
    q("#pl-results").hidden = !hasRoutes;
    if (!hasRoutes) { q("#pl-rows").replaceChildren(); q("#pl-guide").replaceChildren(); return; }
    const r = route();
    // Goals, weapons or limits changed after the build (invalidate clears the
    // signature). An old route must not look like a current answer.
    const outdated = !worker && cache.signature !== signature();
    q("#pl-routes").classList.toggle("is-outdated", outdated);
    q("#pl-routes").innerHTML = modes.map((mode) => {
      const data = cache.routes[mode];
      if (!data) return `<div class="pl-route is-pending"><strong>${html(mode === "preferred" ? "Top desired route" : "Fastest acceptable")}</strong><p class="pl-muted">…</p></div>`;
      const incomplete = data.bonus.status === "incomplete" || data.skill.status === "incomplete";
      return `<button type="button" class="pl-route" data-pl-route="${mode}" aria-pressed="${cache.mode === mode}"${cache.completed > 0 && cache.mode !== mode ? " disabled" : ""}><div class="pl-route-title"><span class="pl-radio" aria-hidden="true"></span><strong>${html(mode === "preferred" ? "Top desired route" : "Fastest acceptable")}</strong></div><div class="pl-route-total"><strong>${data.total === null ? "—" : data.total}</strong><span>${html(data.complete ? "rolls" : incomplete ? "Search incomplete" : "No complete route")}</span></div><p class="pl-muted">${data.complete ? html("{bonus} bonus + {skill} skill", { bonus: data.bonus.horizon, skill: data.skill.horizon }) : html("Increase the roll limits or relax your goals.")}</p>${data.complete && data.dropped?.length ? `<p class="pl-drop-note">${html("Leaves out {n}: {names}", { n: data.dropped.length, names: shortNames(data) })}</p>` : ""}<div class="pl-route-bottom"><span>${html(data.complete ? data.proven ? "Minimum proven" : "Best found" : incomplete ? "Search incomplete" : "No complete route")}</span><span>${html("Within your roll limits")}</span></div></button>`;
    }).join("");
    q("#pl-side").value = cache.side;
    q("#pl-workspace").classList.toggle("guide-right", cache.side === "right");
    if (!r) return;
    const ok = compatible();
    let note = "";
    if (outdated) {
      q("#pl-route-note").textContent = pl("Your goals, weapons or limits changed after this route was built. Build new guides to see an updated route.");
      q("#pl-route-note").className = "pl-route-note is-warning";
      for (const id of ["#pl-alternatives", "#pl-workspace", "#pl-detail-heading", "#pl-route-complete"]) q(id).hidden = true;
      return;
    }
    if (!ok) note = pl("Position or weapons changed. Build new guides before saving more steps.");
    else if (cache.completed > 0 && cache.completed < r.steps.length) note = pl("This route is in progress. Build new guides from your saved position to change routes.");
    else if (!r.proven && r.complete) note = pl("The search reached its complexity budget. A shorter route may exist within these roll limits.");
    if (!r.complete) {
      const streamErrors = [["bonus", "Bonus goals not completed"], ["skill", "Skill goals not completed"]].filter(([stream]) => r[stream].status !== "complete").map(([stream, label]) => `${pl(label)}: ${r[stream].missing.length ? r[stream].missing.map((id) => nameOf(r.targets.find((v) => v.id === id))).join(", ") : pl(r[stream].status === "incomplete" ? "Search incomplete" : "Conflicting roll positions")}`);
      note = streamErrors.join(" · ");
      if (!r.proven) note += ` ${pl("The search reached its complexity budget. A shorter route may exist within these roll limits.")}`;
    }
    if (r.complete && r.dropped?.length) note = [pl("Left out of this route: {names}", { names: droppedNames(r) }), note].filter(Boolean).join(" · ");
    q("#pl-route-note").textContent = note;
    const choices = r.complete && r.alternatives?.length && cache.completed === 0 && ok ? [r, ...r.alternatives] : [];
    q("#pl-alternatives").hidden = !choices.length;
    q("#pl-alternatives").innerHTML = choices.length ? `<p>${html("Some weapons need the same rolls. Choose which route to follow:")}</p>${choices.map((choice, index) => `<button type="button" class="pl-alternative" data-pl-alt="${index}" aria-pressed="${index === 0}"><span class="pl-radio" aria-hidden="true"></span><span><strong>${html("{rolls} rolls", { rolls: choice.total })}</strong> · ${esc(shortNames(choice, "conflict") ? pl("leaves out {names}", { names: shortNames(choice, "conflict") }) : pl("finishes every weapon"))}</span></button>`).join("")}` : "";
    q("#pl-route-note").className = note ? `pl-route-note${!ok || !r.complete || r.dropped?.length ? " is-warning" : ""}` : "";
    q("#pl-workspace").hidden = !r.complete || r.steps.length === 0;
    q("#pl-detail-heading").hidden = !r.complete || r.steps.length === 0;
    q("#pl-saved-count").textContent = pl("{done} of {total} steps saved", { done: cache.completed, total: r.steps.length });
    const done = r.complete && (r.steps.length === 0 || cache.completed === r.steps.length);
    q("#pl-route-complete").hidden = !done;
    q("#pl-route-complete").textContent = done ? `✓ ${r.dropped?.length ? pl("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : pl(r.steps.length ? "Route complete. All chosen goals are met." : "Your current weapons already meet this route’s goals.")}` : "";
    if (!r.complete || !r.steps.length) return;
    inspected = Math.max(0, Math.min(inspected, r.steps.length - 1));
    const row = (step, index) => {
      const target = r.targets.find((v) => v.id === step.targetId);
      const saved = index < cache.completed;
      const current = index === cache.completed;
      const prefix = step.stream === "bonus" ? "G" : "S";
      return `<tr data-pl-step="${index}" tabindex="0" class="${inspected === index ? "is-inspected " : ""}${current ? "is-current " : ""}${saved ? "is-saved" : ""}" aria-label="${esc(`${pl("Step {n} of {total}", { n: index + 1, total: r.steps.length })}: ${nameOf(target)}, ${actionName(step.action)}`)}"><td class="pl-saved-cell">${saved ? `<span class="pl-saved-check" aria-label="${html("Saved")}">✓</span>` : current ? `<input type="checkbox" data-pl-done="${index}" aria-label="${html("Done & saved")}"${!ok || worker ? " disabled" : ""}>` : ""}</td><td><strong class="pl-roll-range">${prefix}${step.start}${step.end !== step.start ? `–${step.end}` : ""}</strong><small>× ${step.rolls.length}</small></td><td><strong class="pl-table-weapon">${esc(nameOf(target))}</strong><span class="pl-table-action">${esc(actionName(step.action))}</span>${badge(step)}</td><td>${resultMarkup(step.rolls.at(-1), step, target)}</td></tr>`;
    };
    // Bonus (G) and skill (S) steps use separate counters, so each gets its
    // own table. Step indices stay global because saving follows route order.
    const indexed = r.steps.map((step, index) => [step, index]);
    q("#pl-rows").innerHTML = [["bonus", "Bonus steps", "Bonus gains"], ["skill", "Skill steps", "Skills"]].map(([stream, title, result]) => {
      const rows = indexed.filter(([step]) => step.stream === stream);
      return rows.length ? `<section class="pl-stream-table"><h4 class="pl-stream-title">${html(title)} <span>${stream === "bonus" ? "G" : "S"}</span></h4><div class="pl-table-scroll"><table class="pl-route-table"><thead><tr><th>${html("Saved")}</th><th>${html("Rolls")}</th><th>${html("Weapon & action")}</th><th>${html(result)}</th></tr></thead><tbody>${rows.map(([step, index]) => row(step, index)).join("")}</tbody></table></div></section>` : "";
    }).join("");
    renderGuide(); schedulePointer();
  }
  function renderGuide() {
    const r = route();
    const step = r?.steps[inspected];
    if (!step) return;
    const current = inspected === cache.completed;
    const saved = inspected < cache.completed;
    const target = r.targets.find((v) => v.id === step.targetId);
    const matched = Math.max(0, Math.min(step.rolls.length, Number(cache.matches[inspected]) || 0));
    const prefix = step.stream === "bonus" ? "G" : "S";
    const description = step.intent === "acquire" ? "Acquire this ordered layout for a later Keep Bonuses step." : step.intent === "finish" ? step.stream === "bonus" ? "Reach the stat minimums shown for this weapon." : "Reach one of this weapon’s chosen skill pairs." : "Advance the shared counter on this weapon to reach the next useful result.";
    const goalMode = step.intent === "finish" && step.rolls.at(-1).quality === "preferred" ? "preferred" : r.mode;
    q("#pl-guide").innerHTML = `<span class="pl-guide-pointer" aria-hidden="true"></span><div class="pl-guide-content"><div class="pl-guide-kicker"><span>${html(saved ? "Saved" : current ? "Current step" : "Preview")}</span><span>${html("Step {n} of {total}", { n: inspected + 1, total: r.steps.length })}</span></div><div class="pl-guide-heading"><div><h3>${esc(nameOf(target))}</h3><p class="pl-menu-action">${esc(actionName(step.action))}</p></div><span class="pl-repeat">× <strong>${step.rolls.length}</strong></span></div><div class="pl-guide-meta"><span>${html("Repeat {n} times", { n: step.rolls.length })}</span><strong>${prefix}${step.start}${step.end === step.start ? "" : `–${step.end}`}</strong></div><p class="pl-guide-purpose">${html(description)}</p><p class="pl-guide-goal">${esc(step.intent === "acquire" ? step.rolls.at(-1).raw.map((id) => statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]], target)).join(" → ") : step.stream === "bonus" ? bonusGoalText(target, goalMode) : pairText(goalFor(target, goalMode, "skill")))}</p><p class="pl-fine pl-accept-note">${html("Accept each result in this block. Use the exact weapon and menu action shown.")}</p>
      <div class="pl-reference-heading"><h4>${html("Expected rolls")}</h4><span>${prefix}${step.start}${step.start === step.end ? "" : `–${step.end}`}</span></div><p class="pl-fine pl-reference-note">${html("Match your in-game result to find your place. Every draw in this block is shown.")}</p><div class="pl-reference-labels"><span>${html("Draw")}</span><span>${html("Expected result")}</span></div><div class="pl-expected-list">${step.rolls.map((roll, index) => {
        const tag = current && compatible() ? "button" : "div";
        return `<${tag}${tag === "button" ? ` type="button" data-pl-match="${index + 1}" aria-label="${html("Match draw {n}", { n: index + 1 })}" aria-pressed="${matched === index + 1}"` : ""} class="pl-expected-roll${index < matched && current ? " is-passed" : ""}${index + 1 === matched && current ? " is-matched" : ""}"><span class="pl-draw-number"><strong>${index + 1}</strong><small>${prefix}${roll.offset}</small></span><span class="pl-draw-result">${resultMarkup(roll, step, target)}${step.intent !== "advance" && index === step.rolls.length - 1 ? badge(step) : ""}</span>${current && matched === index + 1 ? '<span class="pl-match-check">✓</span>' : ""}</${tag}>`;
      }).join("")}</div>
      <footer class="pl-guide-footer">${current ? `<div><strong>${html("{matched}/{total} matched · {remaining} remaining", { matched, total: step.rolls.length, remaining: step.rolls.length - matched })}</strong><button type="button" class="primary" data-pl-action="done"${!compatible() || worker ? " disabled" : ""}>${html("Done & saved")} →</button></div><p class="pl-fine">${html("Finish this block and save in game, then confirm here.")}</p><p class="pl-fine">${html("Matching a result only marks your place; it does not save a step or advance the counters.")}</p>` : cache.completed < r.steps.length ? `<button type="button" class="secondary" data-pl-action="current">← ${html("Back to current step")}</button>` : `<span class="pl-teal">✓ ${r.dropped?.length ? html("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : html("Route complete. All chosen goals are met.")}</span>`}</footer><details class="pl-state-details"><summary>${html("Saved state details")}</summary><p>${html("Before")} <code>${esc(stateCode(step.before))}</code></p><p>${html("After")} <code>${esc(stateCode(step.after))}</code></p></details></div>`;
    schedulePointer();
  }
  function schedulePointer() {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = null;
      const row = q(`[data-pl-step="${inspected}"]`);
      const guide = q("#pl-guide");
      root.style.setProperty("--pl-sticky-top", `${(document.querySelector(".app-tabs")?.getBoundingClientRect().height ?? 80) + 12}px`);
      if (!row || !guide || q("#pl-workspace").hidden) return;
      const rr = row.getBoundingClientRect(); const gr = guide.getBoundingClientRect();
      guide.style.setProperty("--pl-pointer-y", `${Math.max(18, Math.min(gr.height - 18, rr.top + rr.height / 2 - gr.top))}px`);
    });
  }
  function stopWorker() {
    if (worker) worker.terminate();
    worker = null;
    activeContext = "";
    q("#pl-build").disabled = false; q("#pl-cancel").hidden = true;
  }
  function build(event) {
    event.preventDefault(); setError();
    if (editing) { q("#pl-goal-form").requestSubmit(); if (editing) return; }
    cache.limits = { bonus: Number(q('#pl-limits [name="bonus"]').value), skill: Number(q('#pl-limits [name="skill"]').value) };
    const request = { origin: getState(), targets: prepared(), limits: { ...cache.limits } };
    try { validatePlannerRequest(request); } catch (error) { setError(errorText(error.message)); return; }
    stopWorker();
    cache.routes = {}; cache.completed = 0; cache.matches = {}; cache.mode = "acceptable"; inspected = 0; stale = false; cache.signature = signature();
    persist(); renderResults();
    worker = new Worker(new URL("./planner-worker.js", import.meta.url), { type: "module" });
    activeContext = JSON.stringify([getState(), prepared()]);
    const searchWorker = worker;
    q("#pl-build").disabled = true; q("#pl-cancel").hidden = false;
    setStatus(pl("Calculating real roll predictions for weapon {n} of {total}…", { n: 1, total: request.targets.length }));
    worker.onmessage = ({ data }) => {
      if (worker !== searchWorker) return;
      if (data.type === "progress") {
        if (data.phase === "predictions") setStatus(pl("Calculating real roll predictions for weapon {n} of {total}…", { n: data.target, total: data.total }));
        else if (data.phase === "layouts") setStatus(pl("Checking ordered layouts for weapon {n}: {count}/{total}…", { n: data.target, count: data.layouts, total: data.total }));
        else if (data.phase === "optimize") setStatus(pl("Finding the shortest {mode} route…", { mode: tierName(data.mode) }));
        else if (data.phase === "route") { cache.routes[data.mode] = data.route; persist(); renderResults(); }
      } else if (data.type === "done") {
        cache.routes = data.routes; stopWorker(); persist(); renderResults(); setStatus(pl("Guides ready. Choose a route below."));
      } else if (data.type === "error") {
        stopWorker(); setError(errorText(data.message)); renderResults();
      }
    };
    worker.onerror = (error) => { if (worker !== searchWorker) return; stopWorker(); setError(pl("Unable to calculate the guide. {detail}", { detail: error.message })); renderResults(); };
    worker.postMessage({ request });
  }
  function markDone() {
    const r = route();
    if (worker || !r?.complete || !compatible() || cache.completed >= r.steps.length) return;
    const step = r.steps[cache.completed];
    // saveStep verifies the old counters again and is the only planner action
    // permitted to mutate the app's shared save state.
    try {
      saveStep(step, r.targets.find((v) => v.id === step.targetId));
      cache.completed += 1; inspected = Math.min(cache.completed, r.steps.length - 1);
      persist(); renderWeapons(); renderResults();
      setStatus(pl("Progress saved in this browser"));
    } catch (error) { setError(error.message); renderResults(); }
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pl-action]");
    const action = button?.dataset.plAction;
    if (action === "state") openState();
    else if (action === "add") openAddForm();
    else if (action === "cancel-add") q("#pl-add-form").hidden = true;
    else if (action === "edit") renderEditor(button.dataset.id);
    else if (action === "cancel-edit") { editing = null; q("#pl-editor").replaceChildren(); }
    else if (action === "duplicate") {
      const source = getTargets().find((target) => target.id === button.dataset.id);
      if (source) openAddForm(source);
    } else if (action === "remove") {
      const id = button.dataset.id; cache.selected = cache.selected.filter((v) => v !== id);
      setTargets(getTargets().filter((target) => target.id !== id));
      if (editing === id) { editing = null; q("#pl-editor").replaceChildren(); }
      invalidate(); renderWeapons();
    } else if (action === "add-pair") q(`[data-pairs="${button.dataset.tier}"]`).insertAdjacentHTML("beforeend", comboRow());
    else if (action === "remove-pair") button.closest(".pl-combo").remove();
    else if (action === "cancel") { stopWorker(); persist(); renderResults(); setStatus(pl("Search cancelled. Any completed route remains available.")); }
    else if (action === "done") markDone();
    else if (action === "current") { inspected = cache.completed; renderResults(); q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    const alternative = event.target.closest("[data-pl-alt]");
    const r = route();
    if (alternative && r?.alternatives && cache.completed === 0 && Number(alternative.dataset.plAlt) > 0) {
      const index = Number(alternative.dataset.plAlt) - 1;
      const { alternatives, ...current } = r;
      cache.routes[cache.mode] = { ...alternatives[index], alternatives: [current, ...alternatives.filter((_, i) => i !== index)] };
      cache.matches = {}; inspected = 0; persist(); renderResults();
    }
    const routeButton = event.target.closest("[data-pl-route]");
    if (routeButton && !routeButton.disabled && (cache.completed === 0 || cache.mode === routeButton.dataset.plRoute)) { cache.mode = routeButton.dataset.plRoute; cache.matches = {}; inspected = 0; persist(); renderResults(); }
    const match = event.target.closest("[data-pl-match]");
    if (match && inspected === cache.completed && compatible()) { const scrollTop = q(".pl-expected-list").scrollTop; cache.matches[inspected] = Number(match.dataset.plMatch); persist(); renderGuide(); q(".pl-expected-list").scrollTop = scrollTop; q(`[data-pl-match="${match.dataset.plMatch}"]`)?.focus({ preventScroll: true }); }
    const row = event.target.closest("[data-pl-step]");
    if (row && !event.target.closest("input")) { inspected = Number(row.dataset.plStep); renderResults(); }
  });
  root.addEventListener("keydown", (event) => {
    if (event.target.matches("[data-pl-step]") && ["Enter", " "].includes(event.key)) { event.preventDefault(); inspected = Number(event.target.dataset.plStep); renderResults(); }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-pl-select]")) {
      if (input.checked && cache.selected.length >= MAX_SELECTED) { input.checked = false; setError(errorText("targets")); return; }
      cache.selected = input.checked ? [...cache.selected, input.dataset.plSelect] : cache.selected.filter((id) => id !== input.dataset.plSelect);
      invalidate(); renderWeapons();
    } else if (input.matches("[data-pl-optional]")) {
      setTargets(getTargets().map((v) => v.id === input.dataset.plOptional ? { ...v, planner: { ...normalizedPlanner(v), optional: input.checked } } : v));
      invalidate(); renderWeapons();
    } else if (input.matches("[data-copy-goals]")) { copyGoals(input.value); input.value = ""; }
    else if (input.matches("[data-pl-done]")) markDone();
    else if (input.id === "pl-side") { cache.side = input.value; persist(); renderResults(); }
    else if (input.closest("#pl-limits")) { cache.limits[input.name] = Number(input.value); invalidate(); }
  });
  q("#pl-add-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const weaponType = Number(form.elements.weaponType.value); const attributeForce = Number(form.elements.attributeForce.value);
    const target = { id: crypto.randomUUID(), label: form.elements.label.value.trim(), weaponType, attributeForce, skillCombinations: defaultSkills(weaponType), keepCategories: [null, null, null, null, null], keepSource: null };
    if (!target.label) target.label = uniqueLabel(nameOf(target));
    const source = getTargets().find((v) => v.id === form.elements.copyFrom.value);
    target.planner = source ? copiedPlanner(source, target) : normalizedPlanner(target);
    if (cache.selected.length < MAX_SELECTED) cache.selected.push(target.id);
    setTargets([...getTargets(), target]); invalidate(); renderWeapons();
    q("#pl-add-form").hidden = true; form.elements.label.value = "";
    renderEditor(target.id);
  });
  q("#pl-limits").addEventListener("submit", build);
  function sync() {
    const external = JSON.stringify([getState(), getTargets()]);
    if (external === lastExternal) { schedulePointer(); return; }
    lastExternal = external;
    if (worker && activeContext !== JSON.stringify([getState(), prepared()])) {
      stopWorker();
      setStatus(pl("Position or weapons changed. Build new guides before saving more steps."));
    }
    cache.selected = cache.selected.filter((id) => getTargets().some((v) => v.id === id));
    q("#pl-position").textContent = stateCode(getState());
    renderWeapons(); renderResults(); schedulePointer();
  }
  const observer = new ResizeObserver(schedulePointer);
  observer.observe(q("#pl-workspace")); observer.observe(q("#pl-guide")); observer.observe(q("#pl-rows"));
  window.addEventListener("resize", schedulePointer);
  window.addEventListener("gogma-state-change", sync);
  document.fonts?.ready.then(schedulePointer);
  sync(); persist();
  return { sync };
}
