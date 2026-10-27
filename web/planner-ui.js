import { t, localizedTargetName } from "./i18n.js";
import { pl } from "./planner-text.js";
import { availableStats, BONUS_CATEGORY, FINISH_SORT_KEYS, goalFinishSort, sortFinishOptions, copiedPlanner, hasBonusGoal, layoutOf, MAX_SELECTED, normalizedFinishSort, normalizedPlanner, normalizedProgress, parsePlannerExport, plannerExport, routePosition, routeWeaponsMatch, samePosition, statMaximum, statRollValues, streamSteps, validBonuses, validLayout, validatePlannerRequest } from "./planner-model.js";

const STORAGE_KEY = "gogma-weapon-planner-v1";
const FOLD_ROW = 40;
const ICON_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>`;
const ICON_MORE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>`;
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (source, values) => esc(pl(source, values));
const actionName = (action) => pl(({ reset: "Reset Bonuses", keep: "Keep Bonuses", skill: "Reset Skills" })[action]);
const tierName = (tier) => pl(tier === "preferred" ? "Top desired" : "Acceptable");
const number = (value) => value === null || value === undefined ? pl("Unknown") : value.toLocaleString();
const stateCode = (state) => state.baseSeed === null ? pl("Unknown") : `GSF2-B${state.baseSeed}-G${state.bonusCounter ?? "?"}-S${state.skillCounter ?? "?"}`;
const errorText = (key) => pl(({ targets: "Select between 1 and {max} weapons.", state: "Enter a known base seed and the counters for the streams you want to plan.", limits: "Enter whole-number roll limits from 0 to 10,000.", goals: "Enable at least one goal per weapon and enter a stat minimum or skill pair.", statusValues: "Enter both status boost values before using a status minimum.", excluded: "Excluding these stats leaves too few bonuses to fill five slots.", minAboveMax: "A minimum is higher than its maximum." })[key] ?? "Unable to calculate the guide. {detail}", { detail: key, max: MAX_SELECTED });

// Rebuilds planner state from browser storage or an imported plan.
function restoredCache(stored, targets) {
  const cache = {
    selected: Array.isArray(stored?.selected) ? stored.selected.filter((v) => typeof v === "string") : targets.slice(0, MAX_SELECTED).map((target) => target.id),
    limits: { bonus: stored?.limits?.bonus ?? 250, skill: stored?.limits?.skill ?? 1000 },
    routes: stored?.routes && typeof stored.routes === "object" ? stored.routes : {},
    mode: stored?.mode === "preferred" ? "preferred" : "acceptable",
    completed: stored?.completed,
    matches: stored?.matches && typeof stored.matches === "object" ? stored.matches : {},
    signature: typeof stored?.signature === "string" ? stored.signature : "",
    weaponSort: ["newTop", "newBottom"].includes(stored?.weaponSort) ? stored.weaponSort : "",
    weaponGroups: Array.isArray(stored?.weaponGroups) ? [...new Set(stored.weaponGroups)].filter((key) => ["type", "element", "selected"].includes(key)) : [],
    // Custom finish sorts by "stream:weapon id"; others follow the weapon's goal.
    finishSort: Object.fromEntries(Object.entries(stored?.finishSort && typeof stored.finishSort === "object" ? stored.finishSort : {})
      .filter(([key, levels]) => /^(bonus|skill):/.test(key) && Array.isArray(levels)).map(([key, levels]) => [key, normalizedFinishSort(levels)])),
  };
  // Saved data is optional. Ignore an incompatible/corrupt stored route.
  for (const mode of ["acceptable", "preferred"]) {
    const route = cache.routes[mode];
    if (route && (!Array.isArray(route.steps) || !Array.isArray(route.targets) || !route.origin || !route.bonus || !route.skill || route.steps.some((step) => !step.after || !Array.isArray(step.rolls) || !step.rolls.length))) delete cache.routes[mode];
  }
  cache.completed = cache.routes[cache.mode] ? normalizedProgress(cache.routes[cache.mode], cache.completed) : { bonus: 0, skill: 0 };
  return cache;
}

export function initPlanner({ root, getState, getTargets, setTargets, saveStep, openState, importState, metadata }) {
  const { weapons, attributes, bonuses, bonusName, series, groups, defaultSkills } = metadata;
  let stored;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { stored = null; }
  let cache = restoredCache(stored, getTargets());
  // Each stream has its own current step: the first unsaved step in its table.
  const totalDone = () => cache.completed.bonus + cache.completed.skill;
  const currentIndex = (r, stream) => {
    const steps = streamSteps(r, stream);
    return cache.completed[stream] < steps.length ? r.steps.indexOf(steps[cache.completed[stream]]) : -1;
  };
  const isCurrent = (r, index) => currentIndex(r, r.steps[index].stream) === index;
  const isSaved = (r, index) => streamSteps(r, r.steps[index].stream).indexOf(r.steps[index]) < cache.completed[r.steps[index].stream];
  const nextCurrent = (r, stream = "bonus") => {
    const index = [stream, stream === "bonus" ? "skill" : "bonus"].map((v) => currentIndex(r, v)).find((v) => v >= 0);
    return index ?? Math.max(0, r.steps.length - 1);
  };
  let inspected = cache.routes[cache.mode] ? nextCurrent(cache.routes[cache.mode]) : 0;
  let worker = null;
  let activeContext = "";
  let editing = null;
  let stale = false;
  let storageAvailable = true;
  let lastExternal = "";
  let pointerFrame = null;
  // Other finishes for one weapon, tied to the route object they were found for.
  let finishList = null;
  let sortMenuOpen = false;
  let groupMenuOpen = false;
  // Goal chips in the finishes modal: a tier's "+ Goal" menu, the stat being
  // edited (not stored until applied), and the finish list to reopen once a
  // goal change has rebuilt the route.
  let goalMenu = null;
  let weaponMenu = null;
  let goalEdit = null;
  let goalError = "";
  let reopenFinishes = null;
  const nameOf = (target) => target.label || localizedTargetName(weapons.find(([id]) => id === target.weaponType)?.[1] ?? "", attributes.find(([id]) => id === target.attributeForce)?.[1] ?? "");
  const prepared = () => getTargets().filter((target) => cache.selected.includes(target.id)).map((target) => ({ ...target, planner: normalizedPlanner(target) }));
  const signature = () => JSON.stringify(prepared().map((target) => ({ id: target.id, label: target.label, weaponType: target.weaponType, attributeForce: target.attributeForce, planner: { optional: target.planner.optional, bonusEnabled: target.planner.bonusEnabled, skillEnabled: target.planner.skillEnabled, acceptable: target.planner.acceptable, preferred: target.planner.preferred, elementValues: target.planner.elementValues } })));
  const route = () => cache.routes[cache.mode];
  const compatible = () => Boolean(route()) && !stale && cache.signature === signature() && samePosition(getState(), routePosition(route(), cache.completed)) && routeWeaponsMatch(route(), cache.completed, getTargets());
  const statName = (key, target) => pl(key === "element" && target.attributeForce >= 6 ? "Status" : ({ attack: "Attack", affinity: "Affinity", element: "Element", sharpness: "Sharpness", ammo: "Ammo" })[key]);
  // A zero minimum is always met, so it is shown like a blank goal.
  const statsText = (stats, target) => Object.entries(stats ?? {}).filter(([key, value]) => availableStats(target).includes(key) && value !== 0).map(([key, value]) => `${statName(key, target)} ${value === null ? "?" : `+${value}${key === "affinity" ? "%" : ""}`}`).join(" · ");
  const skillText = (index) => `${t(series[Math.floor(index / 14)])} / ${t(groups[index % 14])}`;
  const pairText = (pairs) => pairs.map((p) => `${p.seriesIndex === null ? pl("Any series skill") : t(series[p.seriesIndex])} / ${p.groupIndex === null ? pl("Any group skill") : t(groups[p.groupIndex])}`).join(" · ");
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
  const goalRows = (target, mode, icon, label) => {
    const p = target.planner;
    const lines = [p.bonusEnabled ? bonusGoalText(target, mode) || pl("Any stats") : "", p.skillEnabled ? pairText(goalFor(target, mode, "skill")) || pl("Any skills") : ""].filter(Boolean);
    const [first = pl("Off"), ...rest] = lines;
    return `<dt class="pl-${mode}">${icon} ${html(label)}</dt><dd class="pl-${mode}">${esc(first)}${rest.map((line) => `<small>${esc(line)}</small>`).join("")}</dd>`;
  };
  const options = (items, selected, unknown = false) => `${unknown ? `<option value="">${html("Unknown")}</option>` : ""}${items.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${esc(t(label))}</option>`).join("")}`;
  const comboOptions = (labels, selected, unknown = false) => options(labels.map((label, index) => [index, label]), selected, unknown);

  root.innerHTML = `
    <section class="panel"><div class="section-heading"><div><p class="step">WEAPON PLANNER</p><h2>${html("Plan your weapons, roll by roll.")}</h2><p class="pl-muted">${html("Choose your weapons and minimum stat gains. Get a complete bonus and skill route.")}</p></div><span id="pl-storage" class="status-pill"></span></div>
    <div class="pl-state-strip"><span>${html("Saved position")}</span><code id="pl-position"></code><button class="text-button" type="button" data-pl-action="state">${html("Set current state")}</button><span class="pl-transfer"><button class="text-button" type="button" data-pl-action="export">${html("Export plan")}</button><button class="text-button" type="button" data-pl-action="import">${html("Import plan")}</button><input id="pl-import-file" type="file" accept=".json,application/json" hidden></span></div></section>
    <section class="panel" aria-labelledby="pl-weapons-title"><div class="section-heading"><div><p class="step">${html("Step {n}", { n: "01" })}</p><h2 id="pl-weapons-title">${html("Your weapons")}</h2><p class="pl-muted">${html("Select up to {max} weapons. Each copy is planned separately.", { max: MAX_SELECTED })} ${html("Mark a weapon Optional to leave it out of a route when it cannot fit.")}</p></div><button class="secondary small-button" type="button" data-pl-action="add">＋ ${html("Add weapon")}</button></div>
      <form id="pl-add-form" class="pl-add-form" hidden><label>${html("Weapon name")}<input name="label" maxlength="24" placeholder="${html("Optional name")}"></label><label>${html("Weapon type")}<select name="weaponType">${options(weapons, 3)}</select></label><label>${html("Element / status")}<select name="attributeForce">${options(attributes, 1)}</select></label><label>${html("Copy goals from")}<select name="copyFrom"></select></label><button class="secondary small-button" type="submit">${html("Add weapon")}</button><button class="text-button" type="button" data-pl-action="cancel-add">${html("Cancel")}</button></form>
      <div class="pl-weapon-bars"><div id="pl-group" class="pl-sort pl-group-bar"></div><div id="pl-weapon-sort" class="pl-sort pl-group-bar"></div></div><div id="pl-weapons" class="pl-weapon-grid"></div><dialog id="pl-editor" class="pl-modal pl-modal-wide" aria-label="${html("Edit weapon goals")}"></dialog>
    </section>
    <form id="pl-limits" class="panel pl-limits"><div class="section-heading"><div><p class="step">${html("Step {n}", { n: "02" })}</p><h2>${html("Search limits")}</h2><p class="pl-muted">${html("Two independent roll windows from your saved position.")}</p></div></div><div class="pl-limit-fields"><label>${html("Bonus rolls")}<input name="bonus" type="number" min="0" max="10000" step="1" value="${esc(cache.limits.bonus)}" required></label><label>${html("Skill rolls")}<input name="skill" type="number" min="0" max="10000" step="1" value="${esc(cache.limits.skill)}" required></label><button id="pl-build" class="primary" type="submit">${html("Build guides")}</button><button id="pl-cancel" class="secondary" type="button" data-pl-action="cancel" hidden>${html("Cancel search")}</button></div>
    <div class="pl-feedback"><p id="pl-status" class="pl-muted" role="status">${html("Ready to plan.")}</p><p id="pl-error" class="error" role="alert" hidden></p><p class="pl-fine">${html("No roll data is changed until you confirm a step as done and saved in game.")}</p></div></form>
    <section id="pl-results" class="panel" hidden><div class="section-heading"><div><p class="step">${html("Step {n}", { n: "03" })}</p><h2>${html("Choose your route")}</h2></div></div><div id="pl-routes" class="pl-routes"></div><div id="pl-route-note"></div><div id="pl-alternatives" class="pl-alternatives" hidden></div>
    </section>
    <section id="pl-detail" class="panel pl-detail-panel" hidden>
      <div id="pl-detail-heading" class="section-heading"><div><p class="step">${html("Step {n}", { n: "04" })}</p><h2>${html("Detailed route")}</h2><p id="pl-saved-count" class="pl-muted"></p></div></div><div id="pl-route-complete" class="pl-complete" hidden></div><div id="pl-workspace" class="pl-workspace"><aside id="pl-guide" class="pl-guide" aria-label="${html("Current step")}"></aside><div id="pl-rows" class="pl-table-area"></div></div>
    </section><p class="pl-fine pl-engine-note">${html("Planning uses the existing game RNG engine. Element deltas vary by weapon; status deltas can be entered in the weapon editor.")}</p><dialog id="pl-finishes-modal" class="pl-modal" aria-labelledby="pl-finishes-title"></dialog>`;
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
  const weaponCard = (raw) => {
      const target = { ...raw, planner: normalizedPlanner(raw) };
      const checked = cache.selected.includes(target.id);
      const typeName = localizedTargetName(weapons.find(([id]) => id === target.weaponType)[1], attributes.find(([id]) => id === target.attributeForce)[1]);
      const label = esc(nameOf(target));
      const open = weaponMenu === target.id;
      const optional = target.planner.optional;
      const item = (action, text, extra = "") => `<button type="button" role="menuitem" data-pl-action="${action}" data-id="${esc(target.id)}"${extra}>${text}</button>`;
      return `<article class="pl-weapon${checked ? " is-selected" : ""}"><div class="pl-weapon-head"><label><input type="checkbox" data-pl-select="${esc(target.id)}"${checked ? " checked" : ""}><span><strong>${label}</strong>${optional ? `<em class="pl-optional-tag">${html("Optional")}</em>` : ""}${nameOf(target) === typeName ? "" : `<small>${esc(typeName)}</small>`}</span></label><div class="pl-weapon-tools"><button type="button" class="pl-tool" data-pl-action="edit" data-id="${esc(target.id)}" aria-label="${html("Edit goals")}: ${label}" title="${html("Edit goals")}">${ICON_EDIT}</button><div class="pl-menu"><button type="button" class="pl-tool" data-pl-action="weapon-menu" data-id="${esc(target.id)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${html("More actions")}: ${label}" title="${html("More actions")}">${ICON_MORE}</button>${open ? `<div class="pl-menu-list" role="menu">${item("optional", `<span class="pl-menu-check">${optional ? "✓" : ""}</span>${html("Optional: leave out if it cannot fit")}`, ` role="menuitemcheckbox" aria-checked="${optional}"`)}<hr>${item("duplicate", `${ICON_COPY}${html("Duplicate")}`)}${item("remove", `<span class="pl-menu-check">×</span>${html("Remove weapon")}`)}</div>` : ""}</div></div></div><dl class="pl-weapon-goals">${goalRows(target, "preferred", "★", "Top")}${goalRows(target, "acceptable", "✓", "OK")}</dl></article>`;
    };
  // Weapons can be grouped by chips above the grid; each level nests inside
  // the one before it, and a group lists weapons in their saved order.
  const GROUP_KEYS = ["type", "element", "selected"];
  const groupName = (key) => pl(key === "type" ? "Weapon type" : key === "element" ? "Element / status" : "Selection");
  function groupLabel(key, target) {
    if (key === "type") return t(weapons.find(([id]) => id === target.weaponType)?.[1] ?? "");
    if (key === "element") return t(attributes.find(([id]) => id === target.attributeForce)?.[1] ?? "");
    return pl(cache.selected.includes(target.id) ? "Selected" : "Not selected");
  }
  function groupedMarkup(list, levels) {
    if (!levels.length) return `<div class="pl-weapon-grid">${list.map(weaponCard).join("")}</div>`;
    const groups = new Map();
    for (const target of list) {
      const label = groupLabel(levels[0], target);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(target);
    }
    return [...groups].map(([label, members]) => `<section class="pl-group"><h4 class="pl-group-heading">${esc(label)} <small>${members.length}</small></h4>${groupedMarkup(members, levels.slice(1))}</section>`).join("");
  }
  function renderGroupBar() {
    const levels = cache.weaponGroups;
    const unused = GROUP_KEYS.filter((key) => !levels.includes(key));
    const chip = (key, index) => `<span class="pl-sort-chip"><span class="pl-group-name">${esc(groupName(key))}</span><button type="button" class="pl-sort-remove" data-pl-action="group-remove" data-index="${index}" aria-label="${html("Remove grouping {name}", { name: groupName(key) })}">×</button></span>`;
    const menu = groupMenuOpen && unused.length ? `<div class="pl-sort-menu" role="menu">${unused.map((key) => `<button type="button" role="menuitem" data-pl-action="group-pick" data-key="${key}">${esc(groupName(key))}</button>`).join("")}</div>` : "";
    q("#pl-group").innerHTML = `<span class="pl-sort-label">${html("Group")}</span><div class="pl-sort-row">${levels.map(chip).join("")}${unused.length ? `<button type="button" class="pl-sort-add" data-pl-action="group-menu" aria-haspopup="menu" aria-expanded="${groupMenuOpen}">＋ ${html("Group")}</button>` : ""}</div>${menu}`;
  }
  // Weapons are saved oldest first, so "new on bottom" is the saved order.
  const weaponSortName = (key) => pl(key === "newTop" ? "New on top" : "New on bottom");
  // One chip, like the finishes sort: click to flip, × to remove.
  function renderWeaponSortBar() {
    const key = cache.weaponSort;
    const chip = `<span class="pl-sort-chip"><button type="button" data-pl-action="wsort-flip" title="${esc(weaponSortName(key))}" aria-label="${html("Sort: Added, {direction}. Click to reverse.", { direction: weaponSortName(key) })}">${html("Added")} ${key === "newTop" ? "↓" : "↑"}</button><button type="button" class="pl-sort-remove" data-pl-action="wsort-remove" aria-label="${html("Remove sort")}">×</button></span>`;
    q("#pl-weapon-sort").innerHTML = `<span class="pl-sort-label">${html("Sort")}</span><div class="pl-sort-row">${key ? chip : `<button type="button" class="pl-sort-add" data-pl-action="wsort-add">＋ ${html("Sort")}</button>`}</div>`;
  }
  function renderWeapons() {
    const list = cache.weaponSort === "newTop" ? getTargets().slice().reverse() : getTargets();
    const grouped = list.length > 0 && cache.weaponGroups.length > 0;
    q("#pl-weapons").classList.toggle("pl-weapon-grid", !grouped);
    q("#pl-weapons").innerHTML = !list.length ? `<div class="pl-empty">${html("Add your first weapon to start planning.")}</div>` : grouped ? groupedMarkup(list, cache.weaponGroups) : list.map(weaponCard).join("");
    renderGroupBar(); renderWeaponSortBar();
  }
  // "Any" (empty value) lets one half of a pair match every skill.
  const pairOptions = (labels, selected, anyLabel) => `<option value=""${selected === null ? " selected" : ""}>${html(anyLabel)}</option>${comboOptions(labels, selected)}`;
  function comboRow(pair = { seriesIndex: 11, groupIndex: 13 }) {
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
  function renderEditor(id) {
    const raw = getTargets().find((target) => target.id === id);
    if (!raw) return;
    editing = id;
    const target = { ...raw, planner: normalizedPlanner(raw) };
    const p = target.planner;
    const bonusOptions = bonuses.filter(([id]) => availableStats(target).includes(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]])).map(([id]) => [id, bonusName(target.weaponType, id)]);
    const sources = getTargets().filter((v) => v.id !== id);
    const categories = [...new Set(bonusOptions.map(([id]) => BONUS_CATEGORY[id]))].map((category) => [category, statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[category], target)]);
    q("#pl-editor").innerHTML = `<form id="pl-goal-form" class="pl-editor"><div class="pl-close-wrap"><button type="button" class="pl-close" data-pl-action="cancel-edit" aria-label="${html("Cancel")}" title="${html("Cancel")}">×</button></div><div class="section-heading"><div><p class="step">${html("Weapon planner")}</p><h2>${html("Edit weapon goals")}</h2><p class="pl-muted">${esc(nameOf(target))}</p></div></div><label class="pl-name-field">${html("Weapon name")}<input name="label" value="${esc(target.label)}" maxlength="24" placeholder="${html("Optional name")}"></label>${sources.length ? `<label class="pl-name-field">${html("Copy goals from")}<select data-copy-goals><option value="">${html("Choose a weapon")}</option>${sources.map((v) => `<option value="${esc(v.id)}">${esc(nameOf(v))}</option>`).join("")}</select></label>` : ""}
      <div class="pl-editor-section"><label class="pl-toggle"><input name="bonusEnabled" type="checkbox"${p.bonusEnabled ? " checked" : ""}>${html("Use bonus goals")}</label><p class="pl-fine">${html("Blank stats are ignored. Attack uses unbloated raw; affinity uses percentage points. These are gains from the five slots, not final weapon stats.")} ${html("Leave min or max blank for no bound on that side. Max 0 means no slot of that stat.")}</p><div class="pl-goal-table-wrap"><table class="pl-goal-table"><thead><tr><th>${html("Stat")}</th><th class="pl-gold">★ ${html("Top desired")} <small>${html("min – max")}</small></th><th class="pl-teal">✓ ${html("Acceptable")} <small>${html("min – max")}</small></th></tr></thead><tbody>${availableStats(target).map((key) => {
        const limit = statusStat(key, target) ? 9999 : statMaximum(key, target);
        const box = (tier, bound) => `<input type="number" min="0" max="${limit}" step="1" data-stat="${key}" data-tier="${tier}" data-bound="${bound}" value="${p[tier][bound === "min" ? "stats" : "maxStats"][key] ?? ""}" placeholder="${html(bound === "min" ? "Min" : "Max")}" aria-label="${esc(`${tierName(tier)} · ${statName(key, target)} · ${pl(bound === "min" ? "Min" : "Max")}`)}">`;
        return `<tr><th>${esc(statName(key, target))}${key === "affinity" ? " (%)" : ""}${rollHint(key, target)}</th>${["preferred", "acceptable"].map((tier) => `<td><div class="pl-range">${box(tier, "min")}<span aria-hidden="true">–</span>${box(tier, "max")}</div></td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div></div>
      <div class="pl-editor-section"><label class="pl-toggle"><input name="skillEnabled" type="checkbox"${p.skillEnabled ? " checked" : ""}>${html("Use skill goals")}</label><p class="pl-fine">${html("A match for any pair in a column meets that goal. Top desired results also count as acceptable.")} ${html("Each reroll gives one series skill and one group skill; a pair matches only when both match. Choose Any to accept a skill on its own.")}</p><div class="pl-skill-goals">${["preferred", "acceptable"].map((mode) => `<section><h4 class="${mode === "preferred" ? "pl-gold" : "pl-teal"}">${mode === "preferred" ? "★" : "✓"} ${esc(tierName(mode))}</h4><div data-pairs="${mode}">${p[mode].skills.map(comboRow).join("")}</div><button type="button" class="text-button" data-pl-action="add-pair" data-tier="${mode}">＋ ${html("Add combination")}</button></section>`).join("")}</div></div>
      <details class="pl-current-details"><summary>${html("Current weapon (optional)")}</summary><p class="pl-fine">${html("Enter your current bonuses to check goals already met. Known categories also allow Keep Bonuses and can prove goals met by every possible tier combination.")}</p><h4>${html("Current bonuses in game order")}</h4><div class="pl-five-slots">${Array.from({ length: 5 }, (_, index) => `<label>${html("Slot {n}", { n: index + 1 })}<select data-current-bonus="${index}">${options(bonusOptions, p.currentBonuses?.[index], true)}</select></label>`).join("")}</div><h4>${html("Or known categories in game order")}</h4><div class="pl-five-slots">${Array.from({ length: 5 }, (_, index) => `<label>${html("Slot {n}", { n: index + 1 })}<select data-current-category="${index}">${options(categories, target.keepCategories?.[index], true)}</select></label>`).join("")}</div><h4>${html("Current skills")}</h4><div class="pl-current-pair"><select name="currentSeries" aria-label="${html("Series skill")}">${comboOptions(series, p.currentSkill === null ? null : Math.floor(p.currentSkill / 14), true)}</select><span>＋</span><select name="currentGroup" aria-label="${html("Group skill")}">${comboOptions(groups, p.currentSkill === null ? null : p.currentSkill % 14, true)}</select></div></details>
      ${target.attributeForce >= 6 && target.weaponType < 12 ? `<div class="pl-status-values"><h4>${html("Status boost values")}</h4><p class="pl-fine">${html("Enter the II and EX gains shown on this weapon to use a status minimum.")}</p>${[0, 1].map((index) => `<label>${index === 0 ? "II" : "EX"}<input name="element${index}" type="number" min="0" max="9999" step="1" value="${p.elementValues[index] ?? ""}"></label>`).join("")}</div>` : ""}<p id="pl-editor-error" class="error" role="alert" hidden></p><div class="pl-editor-footer"><button class="secondary" type="submit">${html("Save goals")}</button><button class="text-button" type="button" data-pl-action="cancel-edit">${html("Cancel")}</button></div></form>`;
    q("#pl-goal-form").addEventListener("submit", submitGoals);
    if (!q("#pl-editor").open) q("#pl-editor").showModal();
    q("#pl-goal-form input").focus({ preventScroll: true });
  }
  function closeEditor() {
    const dialog = q("#pl-editor");
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
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
    if (form.elements.element0 && raw.weaponType === current.weaponType && raw.attributeForce === current.attributeForce) [0, 1].forEach((i) => { form.elements[`element${i}`].value = p.elementValues[i] ?? ""; });
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
        p[mode].skills = [...form.querySelectorAll(`[data-pairs="${mode}"] .pl-combo`)].map((row) => Object.fromEntries(["series", "group"].map((half) => [`${half}Index`, row.querySelector(`[data-pair="${half}"]`).value === "" ? null : Number(row.querySelector(`[data-pair="${half}"]`).value)])));
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
      editing = null; closeEditor();
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
  // Upgrading a weapon to Gogma uses exactly one roll of the shared skill
  // counter. If every weapon in the route is upgraded this session, upgrades
  // take S1 through S<weapons>, so a skill target there needs a warning.
  function upgradeWarning(r, steps) {
    const weapons = r.targets.length - (r.dropped?.length ?? 0);
    if (!steps.some((step) => step.stream === "skill" && step.intent === "finish" && step.end <= weapons)) return "";
    const text = weapons === 1 ? pl("The skill target is the very next skill roll (S1). Upgrading a weapon to Gogma also uses a skill roll, so do this step before upgrading any weapon, or the upgrade takes the target.")
      : pl("A skill target is within S1–S{n}. Each weapon upgraded to Gogma uses one skill roll, so upgrading this route's {n} weapons can take it. Do skill targets in that range before upgrading.", { n: weapons });
    return `<p class="pl-route-note is-warning">${esc(text)}</p>`;
  }
  function renderResults() { renderRoutes(); renderFinishModal(); }
  // What each route mode searches for, shown under its total.
  const routeRules = (mode) => `<span class="pl-route-rules">${(mode === "preferred"
    ? ["Every weapon must reach its top desired goal. A weapon with no top desired goal uses its acceptable goal.", "It searches the same two streams, so it usually needs more rerolls than the fastest route.", "Optional weapons that cannot fit are left out and named with the reason."]
    : ["Every weapon only needs to reach its acceptable goal.", "Bonus and skill rolls are separate streams, so the route is the shortest bonus window plus the shortest skill window.", "Rolls that happen anyway upgrade weapons toward top desired at no extra cost, in list order."]).map((rule) => `<span>${html(rule)}</span>`).join("")}</span>`;
  function renderRoutes() {
    const modes = ["acceptable", "preferred"];
    const hasRoutes = modes.some((mode) => cache.routes[mode]);
    q("#pl-results").hidden = !hasRoutes; q("#pl-detail").hidden = !hasRoutes;
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
      return `<button type="button" class="pl-route" data-pl-route="${mode}" aria-pressed="${cache.mode === mode}"${totalDone() > 0 && cache.mode !== mode ? " disabled" : ""}><div class="pl-route-title"><span class="pl-radio" aria-hidden="true"></span><strong>${html(mode === "preferred" ? "Top desired route" : "Fastest acceptable")}</strong></div><div class="pl-route-total"><strong>${data.total === null ? "—" : data.total}</strong><span>${html(data.complete ? "rolls" : incomplete ? "Search incomplete" : "No complete route")}</span></div><p class="pl-muted">${data.complete ? html("{bonus} bonus + {skill} skill", { bonus: data.bonus.horizon, skill: data.skill.horizon }) : html("Increase the roll limits or relax your goals.")}</p>${data.complete && data.dropped?.length ? `<p class="pl-drop-note">${html("Leaves out {n}: {names}", { n: data.dropped.length, names: shortNames(data) })}</p>` : ""}${routeRules(mode)}<div class="pl-route-bottom"><span>${html(data.complete ? data.proven ? "Minimum proven" : "Best found" : incomplete ? "Search incomplete" : "No complete route")}</span><span>${html("Within your roll limits")}</span></div></button>`;
    }).join("");
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
    else if (totalDone() > 0 && totalDone() < r.steps.length) note = pl("This route is in progress. Build new guides from your saved position to change routes.");
    else if (!r.proven && r.complete) note = pl("The search reached its complexity budget. A shorter route may exist within these roll limits.");
    if (!r.complete) {
      const streamErrors = [["bonus", "Bonus goals not completed"], ["skill", "Skill goals not completed"]].filter(([stream]) => r[stream].status !== "complete").map(([stream, label]) => `${pl(label)}: ${r[stream].missing.length ? r[stream].missing.map((id) => nameOf(r.targets.find((v) => v.id === id))).join(", ") : pl(r[stream].status === "incomplete" ? "Search incomplete" : "Conflicting roll positions")}`);
      note = streamErrors.join(" · ");
      if (!r.proven) note += ` ${pl("The search reached its complexity budget. A shorter route may exist within these roll limits.")}`;
    }
    if (r.complete && r.dropped?.length) note = [pl("Left out of this route: {names}", { names: droppedNames(r) }), note].filter(Boolean).join(" · ");
    if (r.alternativesComplete === false && totalDone() === 0) note = [note, pl("More alternative routes may exist within these roll limits.")].filter(Boolean).join(" · ");
    q("#pl-route-note").textContent = note;
    const choices = r.complete && r.alternatives?.length && totalDone() === 0 && ok ? [r, ...r.alternatives] : [];
    q("#pl-alternatives").hidden = !choices.length;
    q("#pl-alternatives").innerHTML = choices.length ? `<p>${html("Some weapons need the same rolls. Choose which route to follow:")}</p>${choices.map((choice, index) => `<button type="button" class="pl-alternative" data-pl-alt="${index}" aria-pressed="${index === 0}"><span class="pl-radio" aria-hidden="true"></span><span><strong>${html("{rolls} rolls", { rolls: choice.total })}</strong> · ${esc(shortNames(choice, "conflict") ? pl("leaves out {names}", { names: shortNames(choice, "conflict") }) : pl("finishes every weapon"))}</span></button>`).join("")}` : "";
    q("#pl-route-note").className = note ? `pl-route-note${!ok || !r.complete || r.dropped?.length ? " is-warning" : ""}` : "";
    q("#pl-workspace").hidden = !r.complete || r.steps.length === 0;
    q("#pl-detail-heading").hidden = !r.complete || r.steps.length === 0;
    q("#pl-saved-count").textContent = pl("{done} of {total} steps saved", { done: totalDone(), total: r.steps.length });
    const done = r.complete && (r.steps.length === 0 || totalDone() === r.steps.length);
    q("#pl-route-complete").hidden = !done;
    q("#pl-route-complete").textContent = done ? `✓ ${r.dropped?.length ? pl("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : pl(r.steps.length ? "Route complete. All chosen goals are met." : "Your current weapons already meet this route’s goals.")}` : "";
    if (!r.complete || !r.steps.length) return;
    inspected = Math.max(0, Math.min(inspected, r.steps.length - 1));
    const row = (step, index) => {
      const target = r.targets.find((v) => v.id === step.targetId);
      const saved = isSaved(r, index);
      const current = isCurrent(r, index);
      const prefix = step.stream === "bonus" ? "G" : "S";
      return `<tr data-pl-step="${index}" tabindex="0" class="${inspected === index ? "is-inspected " : ""}${current ? "is-current " : ""}${saved ? "is-saved" : ""}" aria-label="${esc(`${pl("Step {n} of {total}", { n: index + 1, total: r.steps.length })}: ${nameOf(target)}, ${actionName(step.action)}`)}"><td class="pl-saved-cell">${saved ? `<span class="pl-saved-check" aria-label="${html("Saved")}">✓</span>` : current ? `<input type="checkbox" data-pl-done="${index}" aria-label="${html("Done & saved")}"${!ok || worker ? " disabled" : ""}>` : ""}</td><td><strong class="pl-roll-range">${prefix}${step.start}${step.end !== step.start ? `–${step.end}` : ""}</strong><small>× ${step.rolls.length}</small></td><td><strong class="pl-table-weapon">${esc(nameOf(target))}</strong><span class="pl-table-action">${esc(actionName(step.action))}</span>${badge(step)}</td><td>${resultMarkup(step.rolls.at(-1), step, target)}</td></tr>`;
    };
    // Bonus (G) and skill (S) steps use separate counters, so each gets its own
    // table and its own progress; either can be saved first.
    const indexed = r.steps.map((step, index) => [step, index]);
    q("#pl-rows").innerHTML = [["bonus", "Bonus steps", "Bonus gains"], ["skill", "Skill steps", "Skills"]].map(([stream, title, result]) => {
      const rows = indexed.filter(([step]) => step.stream === stream);
      const warning = stream === "skill" ? upgradeWarning(r, rows.map(([step]) => step)) : "";
      return rows.length ? `<section class="pl-stream-table"><h4 class="pl-stream-title">${html(title)} <span>${stream === "bonus" ? "G" : "S"} · ${html("{done} of {total} steps saved", { done: cache.completed[stream], total: rows.length })}</span></h4>${warning}<div class="pl-table-scroll"><table class="pl-route-table"><thead><tr><th>${html("Saved")}</th><th>${html("Rolls")}</th><th>${html("Weapon & action")}</th><th>${html(result)}</th></tr></thead><tbody>${rows.map(([step, index]) => row(step, index)).join("")}</tbody></table></div></section>` : "";
    }).join("");
    alignTables(); renderGuide(); schedulePointer();
  }
  // Each table sizes its columns to its content; every column then takes the
  // widest width either table needs so the two read as one grid.
  let aligned = false;
  function alignTables() {
    const heads = [...root.querySelectorAll(".pl-route-table")].map((table) => [...table.querySelectorAll("thead th")]);
    for (const row of heads) for (const th of row) th.style.width = "";
    aligned = false;
    if (heads.length < 2 || !heads.every((row) => row[0].getBoundingClientRect().width > 0)) return;
    aligned = true;
    const widths = heads[0].map((_, column) => Math.max(...heads.map((row) => row[column]?.getBoundingClientRect().width ?? 0)));
    for (const row of heads) row.forEach((th, column) => { th.style.width = `${Math.ceil(widths[column])}px`; });
  }
  // The other stream's counter depends on how far that stream has been saved.
  const stepState = (r, step, side) => ({ ...routePosition(r, cache.completed), [`${step.stream}Counter`]: step[side][`${step.stream}Counter`] });
  function renderGuide() {
    const r = route();
    const step = r?.steps[inspected];
    if (!step) return;
    const current = isCurrent(r, inspected);
    const saved = isSaved(r, inspected);
    const target = r.targets.find((v) => v.id === step.targetId);
    const matched = Math.max(0, Math.min(step.rolls.length, Number(cache.matches[inspected]) || 0));
    const prefix = step.stream === "bonus" ? "G" : "S";
    const description = step.intent === "acquire" ? "Acquire this ordered layout for a later Keep Bonuses step." : step.intent === "finish" ? step.stream === "bonus" ? "Reach the stat minimums shown for this weapon." : "Reach one of this weapon’s chosen skill pairs." : "Advance the shared counter on this weapon to reach the next useful result.";
    const goalMode = step.intent === "finish" && step.rolls.at(-1).quality === "preferred" ? "preferred" : r.mode;
    q("#pl-guide").innerHTML = `<button type="button" class="pl-guide-pointer" data-pl-action="show-row" aria-hidden="true" tabindex="-1"></button><div class="pl-guide-content"><div class="pl-guide-kicker"><span>${html(saved ? "Saved" : current ? "Current step" : "Preview")}</span><span>${html("Step {n} of {total}", { n: inspected + 1, total: r.steps.length })}</span></div><div class="pl-guide-heading"><div><h3>${esc(nameOf(target))}</h3><p class="pl-menu-action">${esc(actionName(step.action))}</p></div><span class="pl-repeat">× <strong>${step.rolls.length}</strong></span></div><div class="pl-guide-meta"><span>${html("Repeat {n} times", { n: step.rolls.length })}</span><strong>${prefix}${step.start}${step.end === step.start ? "" : `–${step.end}`}</strong></div><p class="pl-guide-purpose">${html(description)}</p>${step.stream === "skill" ? upgradeWarning(r, [step]) : ""}<p class="pl-guide-goal">${esc(step.intent === "acquire" ? step.rolls.at(-1).raw.map((id) => statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]], target)).join(" → ") : step.stream === "bonus" ? bonusGoalText(target, goalMode) : pairText(goalFor(target, goalMode, "skill")))}</p>${finishMarkup(r, step, target)}<p class="pl-fine pl-accept-note">${html("Accept each result in this block. Use the exact weapon and menu action shown.")}</p>
      <div class="pl-reference-heading"><h4>${html("Expected rolls")}</h4><span>${prefix}${step.start}${step.start === step.end ? "" : `–${step.end}`}</span></div><p class="pl-fine pl-reference-note">${html("Match your in-game result to find your place. Every draw in this block is shown.")}</p><div class="pl-reference-labels"><span>${html("Draw")}</span><span>${html("Expected result")}</span></div><div class="pl-expected-list">${step.rolls.map((roll, index) => {
        const tag = current && compatible() ? "button" : "div";
        return `<${tag}${tag === "button" ? ` type="button" data-pl-match="${index + 1}" aria-label="${html("Match draw {n}", { n: index + 1 })}" aria-pressed="${matched === index + 1}"` : ""} class="pl-expected-roll${index < matched && current ? " is-passed" : ""}${index + 1 === matched && current ? " is-matched" : ""}"><span class="pl-draw-number"><strong>${index + 1}</strong><small>${prefix}${roll.offset}</small></span><span class="pl-draw-result">${resultMarkup(roll, step, target)}${step.intent !== "advance" && index === step.rolls.length - 1 ? badge(step) : ""}</span>${current && matched === index + 1 ? '<span class="pl-match-check">✓</span>' : ""}</${tag}>`;
      }).join("")}</div>
      <footer class="pl-guide-footer">${current ? `<div><strong>${html("{matched}/{total} matched · {remaining} remaining", { matched, total: step.rolls.length, remaining: step.rolls.length - matched })}</strong><button type="button" class="primary" data-pl-action="done"${!compatible() || worker ? " disabled" : ""}>${html("Done & saved")} →</button></div><p class="pl-fine">${html("Finish this block and save in game, then confirm here.")}</p><p class="pl-fine">${html("Matching a result only marks your place; it does not save a step or advance the counters.")}</p>` : totalDone() < r.steps.length ? `<button type="button" class="secondary" data-pl-action="current">← ${html("Back to current step")}</button>` : `<span class="pl-teal">✓ ${r.dropped?.length ? html("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : html("Route complete. All chosen goals are met.")}</span>`}</footer><details class="pl-state-details"><summary>${html("Saved state details")}</summary><p>${html("Before")} <code>${esc(stateCode(stepState(r, step, "before")))}</code></p><p>${html("After")} <code>${esc(stateCode(stepState(r, step, "after")))}</code></p></details></div>`;
    schedulePointer();
  }
  // A weapon's finish can be swapped for any other that keeps the stream's
  // roll count, until a step in that stream is saved.
  const canChooseFinish = (r, step) => step.intent === "finish" && r.complete && !worker && compatible() && cache.completed[step.stream] === 0;
  function finishMarkup(r, step, target) {
    return canChooseFinish(r, step) ? `<button type="button" class="text-button pl-finish-toggle" data-pl-action="finishes">${html("Other finishes")}</button>` : "";
  }
  // The list opens in a modal over the page, with the weapon's stat goals as
  // chips above the sort chips. Changing a goal rebuilds the route.
  function finishModalMarkup() {
    const list = finishList;
    const r = route();
    const target = r?.targets.find((v) => v.id === list.targetId) ?? getTargets().find((v) => v.id === list.targetId);
    const head = (close) => `<div class="section-heading"><div><p class="step">${html("Weapon planner")}</p><h2 id="pl-finishes-title">${html("Other finishes")}</h2><p class="pl-muted">${esc(nameOf(target))}</p></div>${close}</div>`;
    if (list.loading) return `${head(`<button type="button" class="secondary small-button" data-pl-action="${list.recalculating ? "cancel" : "close-finishes"}">${html(list.recalculating ? "Cancel" : "Close")}</button>`)}<p class="pl-fine">${list.recalculating ? html("Recalculating the route for the new goal…") : html("Checking other finishes for {name}…", { name: nameOf(target) })}</p>`;
    const step = r.steps.find((v) => v.targetId === list.targetId && v.stream === list.stream && v.intent === "finish");
    const prefix = step.stream === "bonus" ? "G" : "S";
    const keys = sortKeys(step.stream, target);
    const levels = finishSortFor(step.stream, target).filter((level) => keys.includes(level.key));
    const sortName = (key) => key === "top" ? pl("Top desired") : key === "direct" ? pl("No Reset needed") : statName(key, target);
    // One row of sort chips; "+ Sort" opens a menu of the unused fields.
    const unused = keys.filter((key) => !levels.some((level) => level.key === key));
    const chip = (level, index) => {
      const direction = pl(level.dir === "desc" ? "High first" : "Low first");
      return `<span class="pl-sort-chip"><button type="button" data-pl-action="sort-flip" data-index="${index}" title="${esc(direction)}" aria-label="${html("Sort level {n}: {name}, {direction}. Click to reverse.", { n: index + 1, name: sortName(level.key), direction })}">${esc(sortName(level.key))} ${level.dir === "desc" ? "↓" : "↑"}</button><button type="button" class="pl-sort-remove" data-pl-action="sort-remove" data-index="${index}" aria-label="${html("Remove sort level {n}", { n: index + 1 })}">×</button></span>`;
    };
    const menu = sortMenuOpen && unused.length ? `<div class="pl-sort-menu" role="menu">${unused.map((key) => `<button type="button" role="menuitem" data-pl-action="sort-pick" data-key="${key}">${esc(sortName(key))}</button>`).join("")}</div>` : "";
    const sorter = `<div class="pl-sort"><span class="pl-sort-label">${html("Sort")}</span><div class="pl-sort-row">${levels.map(chip).join("")}${unused.length ? `<button type="button" class="pl-sort-add" data-pl-action="sort-menu" aria-haspopup="menu" aria-expanded="${sortMenuOpen}">＋ ${html("Sort")}</button>` : ""}</div>${menu}</div>`;
    const items = sortFinishOptions(list.options, levels).map(({ option, index }) => {
      const where = option.finish === 0 ? `<strong>${esc(pl("Already met (no rolls)"))}</strong>` : `<strong class="pl-finish-roll">${prefix}${option.finish}</strong><span class="pl-finish-how">${esc(actionName(option.action))}${option.acquire ? ` · ${esc(pl("Reset at {at} first", { at: `${prefix}${option.acquire}` }))}` : ""}</span>`;
      const result = option.raw === null ? "" : resultMarkup(option, step, target);
      // Amber: fits, but other weapons move. Red: does not fit the route,
      // so choosing it recalculates the whole stream.
      const names = (ids) => ids.map((id) => nameOf(r.targets.find((v) => v.id === id))).join(", ");
      const state = !option.fits ? " is-collision" : option.moves.length ? " is-moves" : "";
      const note = !option.fits ? `<span class="pl-collision-note">⛔ ${esc(option.collides.length ? pl("Collides with {names}. Choosing it recalculates the whole route.", { names: names(option.collides) }) : pl("Does not fit the current route. Choosing it recalculates the whole route."))}</span>`
        : option.moves.length ? `<span class="pl-collision-note">⚠ ${html("Collides with {names}; they move to other finishes.", { names: names(option.moves) })}</span>` : "";
      return `<button type="button" class="pl-finish-option${option.current ? " is-current" : ""}${state}" data-pl-pin="${index}"${option.current || !canChooseFinish(r, step) ? " disabled" : ""}><span class="pl-finish-where">${option.top ? `<span class="pl-gold">★</span>` : ""}${where}${option.current ? ` <span class="pl-badge pl-neutral">${html("Current")}</span>` : ""}</span><span class="pl-finish-result">${result}</span>${note}</button>`;
    }).join("");
    const others = list.options.filter((option) => option.fits && !option.current).length;
    const collisions = list.options.filter((option) => !option.fits).length;
    const summary = [others ? pl("{n} other finishes keep the route at {rolls} rolls.", { n: others, rolls: r[step.stream].horizon }) : pl("No other finish fits without extra rolls."), collisions ? pl("{n} more collide with the current route and need a full recalculation.", { n: collisions }) : ""].filter(Boolean).join(" ");
    // Two header rows stick above the list once their sections scroll away; a round close button floats top right.
    const hasGoal = step.stream === "bonus" && totalDone() === 0;
    const closeButton = `<div class="pl-close-wrap"><button type="button" class="pl-close" data-pl-action="close-finishes" aria-label="${html("Close")}" title="${html("Close")}">×</button></div>`;
    const foldRow = (section, title) => `<div class="pl-finish-fold" data-fold="${section}"><div class="pl-finish-fold-bar"><button type="button" class="pl-fold-toggle" data-pl-action="finish-goto" data-section="${section}">${html(title)}</button></div></div>`;
    const folds = `${hasGoal ? foldRow("goal", "Goal") : ""}${foldRow("finish", "Choose a finish")}`;
    return `${closeButton}${folds}${head("")}${goalMarkup(r, step, target)}<div class="pl-finish-section"><h3>${html("Choose a finish")}</h3><p class="pl-fine">${esc(summary)}${list.unchecked ? ` ${esc(pl("{n} finishes were not checked: search limit reached.", { n: list.unchecked }))}` : ""}</p></div><div class="pl-finish-bar" style="--rows: ${hasGoal ? 2 : 1}">${sorter}</div><div class="pl-finish-list">${items}</div>`;
  }
  // Goal chips: one row per tier. A chip shows a stat's min/max; clicking it
  // opens its bounds, and "+ Goal" adds a stat. Bonus goals only, and only
  // before any step is saved, since a goal change rebuilds the route.
  const goalRange = (key, tier) => {
    const min = tier.stats[key]; const max = tier.maxStats[key]; const unit = key === "affinity" ? "%" : "";
    return min !== undefined && max !== undefined ? `${min}–${max}${unit}` : max !== undefined ? `≤ ${max}${unit}` : `≥ ${min}${unit}`;
  };
  function goalMarkup(r, step, target) {
    if (step.stream !== "bonus") return "";
    if (totalDone() > 0) return `<p class="pl-fine">${html("Goals can't change after a step is saved. Build new guides from your saved position instead.")}</p>`;
    const planner = normalizedPlanner(getTargets().find((v) => v.id === target.id) ?? target);
    const rows = ["preferred", "acceptable"].map((name) => {
      const tier = planner[name];
      const keys = availableStats(target);
      const set = keys.filter((key) => key in tier.stats || key in tier.maxStats);
      const unused = keys.filter((key) => !set.includes(key));
      const chip = (key) => goalEdit?.tier === name && goalEdit.key === key ? bounds(key) : `<span class="pl-sort-chip"><button type="button" data-pl-action="goal-edit" data-tier="${name}" data-key="${key}" aria-label="${html("Goal {name}: {range}. Click to edit.", { name: statName(key, target), range: goalRange(key, tier) })}">${esc(statName(key, target))} ${esc(goalRange(key, tier))}</button><button type="button" class="pl-sort-remove" data-pl-action="goal-remove" data-tier="${name}" data-key="${key}" aria-label="${html("Remove goal {name}", { name: statName(key, target) })}">×</button></span>`;
      const open = goalMenu === name && unused.length;
      const menu = open ? `<div class="pl-sort-menu" role="menu">${unused.map((key) => `<button type="button" role="menuitem" data-pl-action="goal-add" data-tier="${name}" data-key="${key}">${esc(statName(key, target))}</button>`).join("")}</div>` : "";
      // Editing a stat swaps its chip for one holding the min/max boxes; a
      // stat being added gets that chip at the end of the row.
      const bounds = (key) => `<form class="pl-sort-chip pl-goal-bounds" data-pl-goal-form data-tier="${name}" data-key="${key}"><span>${esc(statName(key, target))}</span><input name="min" type="number" min="0" step="1" value="${tier.stats[key] ?? ""}" placeholder="${html("Min")}" aria-label="${html("Min")}"><span aria-hidden="true">–</span><input name="max" type="number" min="0" step="1" value="${tier.maxStats[key] ?? ""}" placeholder="${html("Max")}" aria-label="${html("Max")}"><button type="submit" class="pl-goal-apply" aria-label="${html("Apply")}" title="${html("Apply")}">✓</button><button type="button" class="pl-sort-remove" data-pl-action="goal-cancel" aria-label="${html("Cancel")}" title="${html("Cancel")}">×</button></form>`;
      const adding = goalEdit?.tier === name && !set.includes(goalEdit.key) ? bounds(goalEdit.key) : "";
      const label = name === "preferred" ? `<span class="pl-gold">★ ${html("Top desired")}</span>` : `<span class="pl-teal">✓ ${html("Acceptable")}</span>`;
      return `<div class="pl-sort is-${name}"><span class="pl-goal-tier">${label}</span><div class="pl-sort-row">${set.map(chip).join("")}${adding}${unused.length && !adding ? `<button type="button" class="pl-sort-add" data-pl-action="goal-menu" data-tier="${name}" aria-haspopup="menu" aria-expanded="${Boolean(open)}">＋ ${html("Goal")}</button>` : ""}</div>${menu}</div>`;
    }).join("");
    return `<div class="pl-goal-edit"><h3>${html("Goal")}</h3>${rows}<p class="pl-fine">${html("Changing a goal recalculates the whole route.")}</p>${goalError ? `<p class="error" role="alert">${esc(goalError)}</p>` : ""}</div>`;
  }
  // Stores one stat's bounds (null removes it), then rebuilds the route and
  // comes back to this weapon's finishes.
  function changeGoal(tierName, key, min, max) {
    const raw = getTargets().find((v) => v.id === finishList?.targetId);
    if (!raw || totalDone() > 0 || worker) return;
    const target = { ...raw, planner: normalizedPlanner(raw) };
    const tier = target.planner[tierName];
    delete tier.stats[key]; delete tier.maxStats[key];
    if (min !== null) tier.stats[key] = min;
    if (max !== null) tier.maxStats[key] = max;
    try {
      if (min !== null) { const limit = statusStat(key, target) ? 9999 : statMaximum(key, target); if (limit !== null && min > limit) throw new Error(pl("{stat} can gain at most +{max} from five slots.", { stat: statName(key, target), max: `${limit}${key === "affinity" ? "%" : ""}` })); }
      validatePlannerRequest({ origin: { baseSeed: 0, bonusCounter: 0, skillCounter: 0 }, targets: [target], limits: { bonus: 0, skill: 0 } });
    } catch (error) {
      goalError = ["goals", "statusValues", "excluded", "minAboveMax", "targets", "limits", "state"].includes(error.message) ? errorText(error.message) : error.message;
      renderFinishModal(); return;
    }
    goalError = ""; goalEdit = null; goalMenu = null;
    setTargets(getTargets().map((v) => v.id === target.id ? target : v));
    reopenFinishes = { stream: finishList.stream, targetId: target.id };
    finishList = { loading: true, recalculating: true, stream: finishList.stream, targetId: target.id };
    renderWeapons(); invalidate();
    q("#pl-limits").requestSubmit();
  }
  // After a goal rebuild, lists the new route's finishes for the same weapon.
  function reopenAfterBuild() {
    const wanted = reopenFinishes; reopenFinishes = null;
    const r = route();
    const index = r?.steps.findIndex((step) => step.targetId === wanted.targetId && step.stream === wanted.stream && step.intent === "finish") ?? -1;
    inspected = index;
    if (index >= 0 && canChooseFinish(r, r.steps[index])) showFinishes();
    else { finishList = null; renderResults(); }
  }
  function renderFinishModal() {
    const dialog = q("#pl-finishes-modal");
    if (finishList?.route && finishList.route !== route()) finishList = null;
    if (!finishList) { if (dialog.open) dialog.close(); dialog.replaceChildren(); goalMenu = null; goalEdit = null; goalError = ""; return; }
    const scroll = dialog.scrollTop;
    dialog.innerHTML = finishModalMarkup();
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = scroll; updateFinishFold();
    placeSortMenu();
  }
  const finishSortFor = (stream, target) => cache.finishSort[`${stream}:${target.id}`] ?? goalFinishSort(target, stream);
  const sortKeys = (stream, target) => stream === "bonus" ? FINISH_SORT_KEYS.filter((key) => !["top", "direct"].includes(key) ? availableStats(target).includes(key) : true) : ["top"];
  // Re-renders the guide without losing the list's scroll position.
  function updateFinishSort(change, toEnd = false) {
    const r = route(); const step = r?.steps[inspected];
    if (!step || !finishList) return;
    const target = r.targets.find((v) => v.id === step.targetId);
    const keys = sortKeys(step.stream, target);
    const before = JSON.stringify(finishSortFor(step.stream, target).filter((level) => keys.includes(level.key)));
    const levels = JSON.parse(before);
    change(levels, keys);
    // A sort matching the goal's default is not stored, so the weapon keeps
    // following its goal.
    const key = `${step.stream}:${target.id}`;
    if (JSON.stringify(levels) === JSON.stringify(goalFinishSort(target, step.stream))) delete cache.finishSort[key];
    else if (JSON.stringify(levels) !== before) cache.finishSort[key] = levels;
    const scrollTop = q("#pl-finishes-modal").scrollTop;
    const scrollLeft = q(".pl-sort-row")?.scrollLeft ?? 0;
    persist(); renderGuide(); renderFinishModal();
    q("#pl-finishes-modal").scrollTop = scrollTop; updateFinishFold();
    const row = q(".pl-sort-row"); if (row) row.scrollLeft = toEnd ? row.scrollWidth : scrollLeft;
    placeSortMenu();
  }
  // Once the Sort row sticks, the goal and heading above it have scrolled
  // away; a one-line header takes their place and scrolls back on click.
  function updateFinishFold() {
    const dialog = q("#pl-finishes-modal"); const base = dialog.getBoundingClientRect().top + 1;
    const goal = q(".pl-goal-edit h3"); const finish = q(".pl-finish-section h3");
    const passed = (heading, rowsAbove) => Boolean(heading) && dialog.scrollTop > 0 && heading.getBoundingClientRect().top - base <= rowsAbove * FOLD_ROW + 4;
    dialog.classList.toggle("is-goal-folded", passed(goal, 0));
    dialog.classList.toggle("is-finish-folded", passed(finish, goal ? 1 : 0));
  }
  // The menu opens under "+ Sort", kept inside the panel.
  function placeSortMenu() {
    const menu = q(".pl-sort-menu"); const add = q(".pl-sort-add"); const sort = q(".pl-sort");
    if (!menu || !add || !sort) return;
    const left = add.getBoundingClientRect().left - sort.getBoundingClientRect().left;
    menu.style.left = `${Math.max(0, Math.min(left, sort.clientWidth - menu.offsetWidth))}px`;
  }
  function helperWorker(message, onResult) {
    stopWorker();
    worker = new Worker(new URL("./planner-worker.js", import.meta.url), { type: "module" });
    const helper = worker;
    q("#pl-cancel").hidden = false;
    worker.onmessage = ({ data }) => {
      if (worker !== helper) return;
      stopWorker();
      if (data.type === "error") { finishList = null; setError(pl("Unable to calculate the guide. {detail}", { detail: data.message })); renderResults(); }
      else onResult(data);
    };
    worker.onerror = (error) => { if (worker !== helper) return; stopWorker(); finishList = null; setError(pl("Unable to calculate the guide. {detail}", { detail: error.message })); renderResults(); };
    worker.postMessage(message);
  }
  function showFinishes() {
    const r = route(); const step = r?.steps[inspected];
    if (!step || !canChooseFinish(r, step)) return;
    setError();
    helperWorker({ kind: "finishes", route: r, stream: step.stream, targetId: step.targetId }, (data) => {
      finishList = { route: r, stream: step.stream, targetId: step.targetId, options: data.options, unchecked: data.unchecked };
      renderResults();
    });
    finishList = { route: r, stream: step.stream, targetId: step.targetId, loading: true };
    renderResults();
  }
  function pinFinish(index) {
    const r = route(); const list = finishList; const option = list?.options?.[index];
    if (!option || option.current || list.route !== r || worker || !compatible() || cache.completed[list.stream] !== 0) return;
    const names = (ids) => ids.map((id) => nameOf(r.targets.find((v) => v.id === id))).join(", ");
    const streamName = pl(list.stream === "bonus" ? "Bonus rolls" : "Skill rolls");
    if (!option.fits && !window.confirm(pl("This finish collides with the current route. The whole {stream} route will be recalculated around it: it may take more rolls, other weapons may finish differently or lose top-desired results, and earlier chosen finishes that no longer fit will be released. Continue?", { stream: streamName }))) return;
    if (option.fits && option.moves.length && !window.confirm(pl("This finish collides with {names}. They will move to other finishes that still meet their goals, and the route keeps {rolls} rolls. Continue?", { names: names(option.moves), rolls: r.total }))) return;
    const done = (data) => {
      cache.routes[cache.mode] = data.route; cache.matches = {}; finishList = null;
      const finish = data.route.steps.findIndex((step) => step.targetId === list.targetId && step.stream === list.stream && step.intent === "finish");
      inspected = finish >= 0 ? finish : nextCurrent(data.route, list.stream);
      persist(); renderResults();
    };
    if (option.fits) helperWorker({ kind: "pin", route: r, stream: list.stream, targetId: list.targetId, option }, (data) => { done(data); setStatus(pl("Finish changed. The route still takes {n} rolls.", { n: data.route.total })); });
    else {
      helperWorker({ kind: "recalc", route: r, stream: list.stream, targetId: list.targetId, option }, (data) => {
        done(data);
        const released = data.route.released ?? [];
        setStatus([pl("Route recalculated around the chosen finish: {n} rolls (was {was}).", { n: data.route.total, was: r.total }), released.length ? pl("Released earlier choices: {names}", { names: names(released) }) : ""].filter(Boolean).join(" "));
      });
      setStatus(pl("Recalculating the {stream} route…", { stream: streamName }));
    }
    renderResults();
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
      // The guide sticks while the table scrolls, so the arrow follows the row.
      // When the row is out of reach the arrow clamps to the guide's top or
      // bottom edge as an up/down button that scrolls back to it.
      const y = rr.top + rr.height / 2 - gr.top;
      const edge = y < 18 ? "up" : y > gr.height - 18 ? "down" : "";
      guide.style.setProperty("--pl-pointer-y", `${Math.max(18, Math.min(gr.height - 18, y))}px`);
      const pointer = guide.querySelector(".pl-guide-pointer");
      if (!pointer) return;
      pointer.classList.toggle("is-edge", Boolean(edge));
      pointer.textContent = edge === "up" ? "▲" : edge === "down" ? "▼" : "";
      pointer.tabIndex = edge ? 0 : -1;
      if (edge) { pointer.removeAttribute("aria-hidden"); pointer.setAttribute("aria-label", pl("Show the current step in the table")); pointer.title = pl("Show the current step in the table"); }
      else { pointer.setAttribute("aria-hidden", "true"); pointer.removeAttribute("aria-label"); pointer.removeAttribute("title"); }
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
    try { validatePlannerRequest(request); } catch (error) { setError(errorText(error.message)); if (reopenFinishes) { reopenFinishes = null; finishList = null; renderResults(); } return; }
    stopWorker();
    cache.routes = {}; cache.completed = { bonus: 0, skill: 0 }; cache.matches = {}; cache.mode = "acceptable"; inspected = 0; stale = false; cache.signature = signature();
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
        if (reopenFinishes) reopenAfterBuild();
      } else if (data.type === "error") {
        stopWorker(); reopenFinishes = null; finishList = null; setError(errorText(data.message)); renderResults();
      }
    };
    worker.onerror = (error) => { if (worker !== searchWorker) return; stopWorker(); reopenFinishes = null; finishList = null; setError(pl("Unable to calculate the guide. {detail}", { detail: error.message })); renderResults(); };
    worker.postMessage({ request });
  }
  function exportPlan() {
    const state = getState();
    const blob = new Blob([JSON.stringify(plannerExport(state, getTargets(), cache))], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `gogma-planner-B${state.baseSeed ?? "unknown"}-G${state.bonusCounter ?? "unknown"}-S${state.skillCounter ?? "unknown"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    setStatus(pl("Plan exported. Import the file on another computer to continue."));
  }
  // Replaces this browser's weapons, saved position and planner progress.
  // importState validates the position and weapons before changing anything.
  async function importPlan(file) {
    setError();
    let data;
    try { data = parsePlannerExport(await file.text()); }
    catch { setError(pl("This file is not a valid planner export.")); return; }
    if (!window.confirm(pl("Replace this browser's weapons, saved position and planner progress with the imported plan?"))) return;
    stopWorker();
    try { importState({ state: data.state, targets: data.targets }); }
    catch (error) { setError(error.message); return; }
    cache = restoredCache(data.planner, getTargets());
    cache.selected = cache.selected.filter((id) => getTargets().some((v) => v.id === id));
    stale = false; editing = null; closeEditor();
    q("#pl-limits").elements.bonus.value = cache.limits.bonus;
    q("#pl-limits").elements.skill.value = cache.limits.skill;
    inspected = route() ? nextCurrent(route()) : 0;
    persist(); renderWeapons(); renderResults(); schedulePointer();
    setStatus(pl("Plan imported."));
  }
  function markDone(index = inspected) {
    const r = route();
    if (worker || !r?.complete || !compatible() || !r.steps[index] || !isCurrent(r, index)) return;
    const step = r.steps[index];
    // saveStep verifies the old counters again and is the only planner action
    // permitted to mutate the app's shared save state.
    try {
      saveStep(step, r.targets.find((v) => v.id === step.targetId));
      cache.completed = { ...cache.completed, [step.stream]: cache.completed[step.stream] + 1 };
      inspected = nextCurrent(r, step.stream);
      persist(); renderWeapons(); renderResults();
      setStatus(pl("Progress saved in this browser"));
    } catch (error) { setError(error.message); renderResults(); }
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pl-action]");
    const action = button?.dataset.plAction;
    if (weaponMenu && !event.target.closest(".pl-menu")) { weaponMenu = null; renderWeapons(); }
    if (action === "state") openState();
    else if (action === "export") exportPlan();
    else if (action === "finishes") showFinishes();
    else if (action === "close-finishes") { if (finishList?.loading) stopWorker(); finishList = null; renderResults(); }
    else if (action === "goal-menu") { goalMenu = goalMenu === button.dataset.tier ? null : button.dataset.tier; goalEdit = null; renderFinishModal(); q(".pl-sort-menu button")?.focus(); }
    else if (action === "goal-add" || action === "goal-edit") { goalEdit = { tier: button.dataset.tier, key: button.dataset.key }; goalMenu = null; goalError = ""; renderFinishModal(); q("[data-pl-goal-form] input")?.focus(); }
    else if (action === "goal-remove") changeGoal(button.dataset.tier, button.dataset.key, null, null);
    else if (action === "wsort-add") { cache.weaponSort = "newTop"; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-chip button")?.focus(); }
    else if (action === "wsort-flip") { cache.weaponSort = cache.weaponSort === "newTop" ? "newBottom" : "newTop"; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-chip button")?.focus(); }
    else if (action === "wsort-remove") { cache.weaponSort = ""; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-add")?.focus(); }
    else if (action === "show-row") q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (action === "group-menu") { groupMenuOpen = !groupMenuOpen; renderGroupBar(); q("#pl-group .pl-sort-menu button")?.focus(); }
    else if (action === "group-pick") { groupMenuOpen = false; cache.weaponGroups = [...cache.weaponGroups, button.dataset.key]; persist(); renderWeapons(); q("#pl-group .pl-sort-add")?.focus(); }
    else if (action === "group-remove") { cache.weaponGroups = cache.weaponGroups.filter((_, index) => index !== Number(button.dataset.index)); persist(); renderWeapons(); }
    else if (groupMenuOpen && !event.target.closest("#pl-group .pl-sort-menu")) { groupMenuOpen = false; renderGroupBar(); }
    else if (action === "goal-cancel") { goalEdit = null; goalError = ""; renderFinishModal(); }
    else if (action === "sort-menu") { sortMenuOpen = !sortMenuOpen; updateFinishSort(() => {}); q(".pl-sort-menu button")?.focus(); }
    else if (action === "sort-pick") {
      sortMenuOpen = false;
      updateFinishSort((levels, keys) => {
        const key = button.dataset.key;
        if (!keys.includes(key)) return;
        levels.push({ key, dir: "desc" });
      }, true);
      q(".pl-sort-add")?.focus();
    }
    else if (action === "sort-flip") updateFinishSort((levels) => { const level = levels[Number(button.dataset.index)]; level.dir = level.dir === "desc" ? "asc" : "desc"; });
    else if (action === "sort-remove") updateFinishSort((levels) => levels.splice(Number(button.dataset.index), 1));
    else if (sortMenuOpen && !event.target.closest(".pl-sort-menu")) { sortMenuOpen = false; updateFinishSort(() => {}); }
    else if (goalMenu && !event.target.closest(".pl-sort-menu")) { goalMenu = null; renderFinishModal(); }
    else if (action === "import") q("#pl-import-file").click();
    else if (action === "add") openAddForm();
    else if (action === "finish-goto") {
      const dialog = q("#pl-finishes-modal"); const section = button.dataset.section === "goal" ? null : q(".pl-finish-section");
      const above = q(".pl-goal-edit h3") ? FOLD_ROW : 0;
      dialog.scrollTo({ top: section ? dialog.scrollTop + section.getBoundingClientRect().top - dialog.getBoundingClientRect().top - above - 14 : 0, behavior: "smooth" });
    }
    else if (action === "cancel-add") q("#pl-add-form").hidden = true;
    else if (action === "weapon-menu") { weaponMenu = weaponMenu === button.dataset.id ? null : button.dataset.id; renderWeapons(); q(".pl-menu-list button")?.focus(); }
    else if (action === "optional") {
      const id = button.dataset.id; weaponMenu = null;
      setTargets(getTargets().map((v) => v.id === id ? { ...v, planner: { ...normalizedPlanner(v), optional: !normalizedPlanner(v).optional } } : v));
      invalidate(); renderWeapons();
    } else if (action === "edit") { weaponMenu = null; renderEditor(button.dataset.id); }
    else if (action === "cancel-edit") { editing = null; closeEditor(); }
    else if (action === "duplicate") {
      weaponMenu = null; renderWeapons();
      const source = getTargets().find((target) => target.id === button.dataset.id);
      if (source) openAddForm(source);
    } else if (action === "remove") {
      const id = button.dataset.id; weaponMenu = null; cache.selected = cache.selected.filter((v) => v !== id);
      setTargets(getTargets().filter((target) => target.id !== id));
      if (editing === id) { editing = null; closeEditor(); }
      invalidate(); renderWeapons();
    } else if (action === "add-pair") q(`[data-pairs="${button.dataset.tier}"]`).insertAdjacentHTML("beforeend", comboRow());
    else if (action === "remove-pair") button.closest(".pl-combo").remove();
    else if (action === "cancel") { stopWorker(); reopenFinishes = null; if (finishList?.loading) finishList = null; persist(); renderResults(); setStatus(pl("Search cancelled. Any completed route remains available.")); }
    else if (action === "done") markDone();
    else if (action === "current") { inspected = nextCurrent(route(), route().steps[inspected]?.stream); renderResults(); q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    const pin = event.target.closest("[data-pl-pin]");
    if (pin && !pin.disabled) pinFinish(Number(pin.dataset.plPin));
    const alternative = event.target.closest("[data-pl-alt]");
    const r = route();
    if (alternative && r?.alternatives && totalDone() === 0 && Number(alternative.dataset.plAlt) > 0) {
      const index = Number(alternative.dataset.plAlt) - 1;
      const { alternatives, ...current } = r;
      cache.routes[cache.mode] = { ...alternatives[index], alternatives: [current, ...alternatives.filter((_, i) => i !== index)] };
      cache.matches = {}; inspected = 0; persist(); renderResults();
    }
    const routeButton = event.target.closest("[data-pl-route]");
    if (routeButton && !routeButton.disabled && (totalDone() === 0 || cache.mode === routeButton.dataset.plRoute)) { cache.mode = routeButton.dataset.plRoute; cache.matches = {}; inspected = 0; persist(); renderResults(); }
    const match = event.target.closest("[data-pl-match]");
    if (match && isCurrent(route(), inspected) && compatible()) { const scrollTop = q(".pl-expected-list").scrollTop; cache.matches[inspected] = Number(match.dataset.plMatch); persist(); renderGuide(); q(".pl-expected-list").scrollTop = scrollTop; q(`[data-pl-match="${match.dataset.plMatch}"]`)?.focus({ preventScroll: true }); }
    const row = event.target.closest("[data-pl-step]");
    if (row && !event.target.closest("input")) { inspected = Number(row.dataset.plStep); renderResults(); }
  });
  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-pl-goal-form]");
    if (!form) return;
    event.preventDefault();
    const bound = (name) => form.elements[name].value === "" ? null : Number(form.elements[name].value);
    changeGoal(form.dataset.tier, form.dataset.key, bound("min"), bound("max"));
  });
  // Escape cancels the goal editor; nothing is stored until it is saved.
  q("#pl-editor").addEventListener("close", () => { if (!q("#pl-editor").open) { editing = null; q("#pl-editor").replaceChildren(); } });
  const finishesDialog = q("#pl-finishes-modal");
  // Escape or a backdrop click closes the modal like Close does; an open menu
  // takes the first Escape.
  finishesDialog.addEventListener("scroll", updateFinishFold, { passive: true });
  finishesDialog.addEventListener("cancel", (event) => { if (goalMenu || sortMenuOpen) event.preventDefault(); });
  finishesDialog.addEventListener("close", () => { if (!finishesDialog.open && finishList && !finishList.recalculating) { if (finishList.loading) stopWorker(); finishList = null; renderResults(); } });
  // A press outside the dialog's box dismisses it, like Close.
  const outside = (dialog, event) => { const box = dialog.getBoundingClientRect(); return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom; };
  finishesDialog.addEventListener("mousedown", (event) => { if (outside(finishesDialog, event)) finishesDialog.close(); });
  q("#pl-editor").addEventListener("mousedown", (event) => { if (outside(q("#pl-editor"), event)) q("#pl-editor").close(); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && weaponMenu) { const id = weaponMenu; weaponMenu = null; renderWeapons(); q(`[data-pl-action="weapon-menu"][data-id="${id}"]`)?.focus(); return; }
    if (event.key === "Escape" && groupMenuOpen) { groupMenuOpen = false; renderGroupBar(); q("#pl-group .pl-sort-add")?.focus(); return; }
    if (event.key === "Escape" && goalMenu) { event.preventDefault(); goalMenu = null; renderFinishModal(); return; }
    if (event.key === "Escape" && sortMenuOpen) { sortMenuOpen = false; updateFinishSort(() => {}); q(".pl-sort-add")?.focus(); return; }
    if (event.target.matches("[data-pl-step]") && ["Enter", " "].includes(event.key)) { event.preventDefault(); inspected = Number(event.target.dataset.plStep); renderResults(); }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-pl-select]")) {
      if (input.checked && cache.selected.length >= MAX_SELECTED) { input.checked = false; setError(errorText("targets")); return; }
      cache.selected = input.checked ? [...cache.selected, input.dataset.plSelect] : cache.selected.filter((id) => id !== input.dataset.plSelect);
      invalidate(); renderWeapons();
    } else if (input.matches("[data-copy-goals]")) { copyGoals(input.value); input.value = ""; }
    else if (input.matches("[data-pl-done]")) markDone(Number(input.dataset.plDone));
    else if (input.matches("#pl-import-file")) { const [file] = input.files; input.value = ""; if (file) void importPlan(file); }
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
  // Tables measured while the tab was hidden are aligned once they show.
  const observer = new ResizeObserver(() => { if (!aligned) alignTables(); schedulePointer(); });
  observer.observe(q("#pl-workspace")); observer.observe(q("#pl-guide")); observer.observe(q("#pl-rows"));
  window.addEventListener("resize", schedulePointer);
  window.addEventListener("scroll", schedulePointer, { passive: true });
  window.addEventListener("gogma-state-change", sync);
  document.fonts?.ready.then(schedulePointer);
  sync(); persist();
  return { sync };
}
