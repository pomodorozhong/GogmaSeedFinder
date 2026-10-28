import { t, localizedTargetName } from "./i18n.js";
import { pl } from "./planner-text.js";
import { availableStats, BONUS_CATEGORY, bonusTotals, FINISH_SORT_KEYS, filtersToTier, finishOptionMatches, goalFinishSort, rowFilters, sortFinishOptions, tierFinishFilters, copiedPlanner, hasBonusGoal, hasGoal, layoutOf, matchesTier, MAX_SELECTED, migrateSavedFinishes, normalizedFinishSort, normalizedPlanner, normalizedProgress, parsePlannerExport, plannerExport, routePosition, routeWeaponsMatch, samePosition, savedFinishChoice, savedFinishFromOption, savedFinishId, statMaximum, statRollValues, streamSteps, validBonuses, validLayout, validatePlannerRequest } from "./planner-model.js";

const STORAGE_KEY = "gogma-weapon-planner-v1";
const ICON_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>`;
const ICON_BOOKMARK = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 2.5h8v11l-4-3-4 3z"/></svg>`;
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
  // A weapon being added lives here until its goals are saved; Cancel drops it.
  let draft = null;
  // The weapon whose goals the draft started from, so changing the draft's type or element keeps them.
  let draftSourceId = null;
  let editorTarget = null;
  let editorTab = "goals";
  let finishViews = {};
  let filterMenuOpen = false;
  let filterEditing = null;
  const findTarget = (id) => editorTarget?.id === id ? editorTarget : getTargets().find((target) => target.id === id) ?? (draft?.id === id ? draft : null);
  let stale = false;
  let storageAvailable = true;
  let lastExternal = "";
  let pointerFrame = null;
  // Finish candidates for one weapon, tied to the searched saved position.
  let finishList = null;
  let sortMenuOpen = false;
  let groupMenuOpen = false;
  let weaponMenu = null;
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
      <div class="pl-weapon-bars"><div id="pl-group" class="pl-sort pl-group-bar"></div><div id="pl-weapon-sort" class="pl-sort pl-group-bar"></div></div><div id="pl-weapons" class="pl-weapon-grid"></div><dialog id="pl-editor" class="pl-modal pl-modal-wide" aria-label="${html("Edit weapon goals")}"></dialog>
    </section>
    <form id="pl-limits" class="panel pl-limits"><div class="section-heading"><div><p class="step">${html("Step {n}", { n: "02" })}</p><h2>${html("Search limits")}</h2><p class="pl-muted">${html("Two independent roll windows from your saved position.")}</p></div></div><div class="pl-limit-fields"><label>${html("Bonus rolls")}<input name="bonus" type="number" min="0" max="10000" step="1" value="${esc(cache.limits.bonus)}" required></label><label>${html("Skill rolls")}<input name="skill" type="number" min="0" max="10000" step="1" value="${esc(cache.limits.skill)}" required></label><button id="pl-build" class="primary" type="submit">${html("Build guides")}</button><button id="pl-cancel" class="secondary" type="button" data-pl-action="cancel" hidden>${html("Cancel search")}</button></div>
    <div class="pl-feedback"><p id="pl-status" class="pl-muted" role="status">${html("Ready to plan.")}</p><p id="pl-error" class="error" role="alert" hidden></p><p class="pl-fine">${html("No roll data is changed until you confirm a step as done and saved in game.")}</p></div></form>
    <section id="pl-results" class="panel" hidden><div class="section-heading"><div><p class="step">${html("Step {n}", { n: "03" })}</p><h2>${html("Choose your route")}</h2></div></div><div id="pl-routes" class="pl-routes"></div><div id="pl-route-note"></div><div id="pl-alternatives" class="pl-alternatives" hidden></div>
    </section>
    <section id="pl-detail" class="panel pl-detail-panel" hidden>
      <div id="pl-detail-heading" class="section-heading"><div><p class="step">${html("Step {n}", { n: "04" })}</p><h2>${html("Detailed route")}</h2><p id="pl-saved-count" class="pl-muted"></p></div></div><div id="pl-route-complete" class="pl-complete" hidden></div><div id="pl-workspace" class="pl-workspace"><aside id="pl-guide" class="pl-guide" aria-label="${html("Current step")}"></aside><div id="pl-rows" class="pl-table-area"></div></div>
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
    setStatus(pl("Build guides to apply your changes. Saved picks are kept."));
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
      return `<article class="pl-weapon${checked ? " is-selected" : ""}"><div class="pl-weapon-head"><label><input type="checkbox" data-pl-select="${esc(target.id)}"${checked ? " checked" : ""}><span><strong>${label}</strong>${optional ? `<em class="pl-optional-tag">${html("Optional")}</em>` : ""}${nameOf(target) === typeName ? "" : `<small>${esc(typeName)}</small>`}</span></label><div class="pl-weapon-tools"><button type="button" class="pl-tool" data-pl-action="edit" data-id="${esc(target.id)}" aria-label="${html("Edit goals")}: ${label}" title="${html("Edit goals")}">${ICON_EDIT}</button><div class="pl-menu"><button type="button" class="pl-tool" data-pl-action="weapon-menu" data-id="${esc(target.id)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${html("More actions")}: ${label}" title="${html("More actions")}">${ICON_MORE}</button>${open ? `<div class="pl-menu-list" role="menu">${item("optional", `<span class="pl-menu-check">${optional ? "✓" : ""}</span>${html("Optional: leave out if it cannot fit")}`, ` role="menuitemcheckbox" aria-checked="${optional}"`)}<hr>${item("duplicate", `${ICON_COPY}${html("Duplicate")}`)}${item("remove", `<span class="pl-menu-check">×</span>${html("Remove weapon")}`)}</div>` : ""}</div></div></div><dl class="pl-weapon-goals">${goalRows(target, "preferred", "★", "Top")}${goalRows(target, "acceptable", "✓", "OK")}</dl>${savedPicksMarkup(target)}</article>`;
    };
  // The route's finish for this weapon and stream, keyed like savedFinishChoice.
  function usedFinish(targetId, stream) {
    const selected = compatible() ? route()?.[stream].choices.find((choice) => choice.id === targetId) : null;
    return selected ? { key: `${selected.action}:${selected.finish}:${selected.layout?.join("") ?? ""}`, acquire: selected.acquire ?? null } : null;
  }
  // One saved pick, judged against the given (possibly draft) goals and the
  // route's roll limit; a pick that cannot be used stays listed with its reason.
  function savedPickRow(target, stream, pick, removeAttrs) {
    const prefix = stream === "bonus" ? "G" : "S";
    const choice = savedFinishChoice(target, stream, pick, getState());
    const result = stream === "bonus" ? bonusTotals(pick.raw, { ...pick, planner: target.planner }) : pick.raw;
    const fitsGoal = matchesTier(result, target, stream, "acceptable");
    const inRoute = usedFinish(target.id, stream);
    const used = choice.key !== null && choice.key === inRoute?.key;
    const warning = !hasGoal(target, stream) ? pl("Goal is off") : choice.status === "seed" ? pl("Different seed") : choice.status === "weapon" ? pl("Different weapon type or element") : choice.status === "passed" ? pl("Roll already passed") : choice.status === "position" ? pl("Set current state") : !fitsGoal ? pl("Does not meet the updated goal") : choice.finish > cache.limits[stream] ? pl("Outside the roll limit") : "";
    const where = choice.status === "achieved" ? pl("Already met (no rolls)") : `${prefix}${choice.finish > 0 ? choice.finish : pick.finish}`;
    const reset = used && inRoute.acquire ? ` <span>· ${esc(pl("Reset at {at} first", { at: `${prefix}${inRoute.acquire}` }))}</span>` : "";
    return `<li class="pl-saved-pick${warning ? " is-warning" : ""}"><div><strong>${esc(where)}</strong> <span>${esc(actionName(pick.action))}</span>${reset}${used ? `<span class="pl-pick-used">${html("Used in current route")}</span>` : ""}<p>${esc(stream === "bonus" ? statsText(result, target) : skillText(result))}</p>${warning ? `<small>${esc(warning)}</small>` : ""}</div><button type="button" class="text-button" ${removeAttrs} data-pick="${esc(savedFinishId(pick))}" aria-label="${html("Remove saved pick {at}", { at: where })}">×</button></li>`;
  }
  function savedPicksMarkup(target) {
    const sections = ["bonus", "skill"].filter((stream) => hasGoal(target, stream) || target.planner.savedFinishes?.[stream]?.length).map((stream) => {
      const picks = target.planner.savedFinishes?.[stream] ?? [];
      const title = pl(stream === "bonus" ? "Bonus rolls" : "Skill rolls");
      const rows = picks.map((pick) => savedPickRow(target, stream, pick, `data-pl-action="remove-pick" data-id="${esc(target.id)}" data-stream="${stream}"`)).join("");
      return `<div class="pl-pick-group"><div class="pl-pick-heading"><strong>${esc(title)}</strong><button type="button" class="text-button" data-pl-action="browse-finishes" data-id="${esc(target.id)}" data-stream="${stream}"${!hasGoal(target, stream) ? " disabled" : ""}>${html("Browse finishes")}</button></div>${picks.length ? `<details${picks.length <= 3 ? " open" : ""}><summary>${html("{n} saved picks", { n: picks.length })}</summary><ul class="pl-saved-picks">${rows}</ul></details>` : `<p class="pl-fine">${html("Automatic — no saved picks")}</p>`}</div>`;
    });
    return `<div class="pl-weapon-picks"><h4>${html("Saved picks")}</h4>${sections.join("")}</div>`;
  }
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
  function renderEditor(id, { tab = "goals", stream = "bonus" } = {}) {
    const raw = findTarget(id);
    if (!raw) return;
    if (editorTarget?.id !== id) {
      editorTarget = draft?.id === id ? draft : structuredClone(raw);
      editorTarget.planner = normalizedPlanner(editorTarget);
      finishViews = {}; finishList = null;
    }
    editing = id;
    const isNew = draft?.id === id;
    const title = pl(isNew ? "Add weapon" : "Edit weapon");
    const target = { ...raw, planner: normalizedPlanner(raw) };
    const p = target.planner;
    const bonusOptions = bonuses.filter(([id]) => availableStats(target).includes(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]])).map(([id]) => [id, bonusName(target.weaponType, id)]);
    const sources = getTargets().filter((v) => v.id !== id);
    const categories = [...new Set(bonusOptions.map(([id]) => BONUS_CATEGORY[id]))].map((category) => [category, statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[category], target)]);
    q("#pl-editor").innerHTML = `<form id="pl-goal-form" class="pl-editor" novalidate><div class="section-heading"><div><p class="step">${html("Weapon planner")}</p><h2>${esc(title)}</h2><p class="pl-muted">${esc(nameOf(target))}</p></div><button type="button" class="pl-close" data-pl-action="cancel-edit" aria-label="${html("Close")}">×</button></div>      <div class="pl-editor-tabs" role="tablist" aria-label="${html("Weapon settings")}"><button type="button" role="tab" id="pl-tab-goals" aria-controls="pl-goals-panel" aria-selected="true" data-pl-action="editor-tab" data-tab="goals">${html("Goals")}</button><button type="button" role="tab" id="pl-tab-finishes" aria-controls="pl-finishes-panel" aria-selected="false" tabindex="-1" data-pl-action="editor-tab" data-tab="finishes">${html("Finishes")}</button></div><section id="pl-goals-panel" role="tabpanel" aria-labelledby="pl-tab-goals">
<div class="pl-editor-section pl-editor-first"><div class="pl-weapon-fields">${isNew ? `<label>${html("Weapon type")}<select name="weaponType" data-pl-new-type>${options(weapons, target.weaponType)}</select></label><label>${html("Element / status")}<select name="attributeForce" data-pl-new-type>${options(attributes, target.attributeForce)}</select></label>` : ""}<label class="pl-name-field">${html("Weapon name")}<input name="label" value="${esc(target.label)}" maxlength="24" placeholder="${html("Optional name")}"></label></div></div>

      <div class="pl-goals-card"><div class="pl-goals-head"><h3>${html("Goals")}</h3>${sources.length ? `<div class="pl-copy-wrap"><button type="button" class="pl-copy-chip" data-pl-action="copy-menu" aria-haspopup="menu" aria-expanded="false">${html("Copy goals from")}…</button><div class="pl-copy-menu" role="menu" hidden><span class="pl-copy-title">${html("Copy goals from")}</span>${sources.map((v) => `<button type="button" role="menuitem" data-pl-action="copy-from" data-id="${esc(v.id)}">${esc(nameOf(v))}</button>`).join("")}</div></div>` : ""}</div><div class="pl-editor-section"><div class="pl-section-head"><h3>${html("Bonus goals")}</h3><label class="pl-switch" title="${html("Use bonus goals")}"><input name="bonusEnabled" type="checkbox" aria-label="${html("Use bonus goals")}"${p.bonusEnabled ? " checked" : ""}><span class="pl-switch-track" aria-hidden="true"></span></label></div><p class="pl-fine">${html("Blank stats are ignored. Attack uses unbloated raw; affinity uses percentage points. These are gains from the five slots, not final weapon stats.")} ${html("Leave min or max blank for no bound on that side. Max 0 means no slot of that stat.")}</p><div class="pl-goal-table-wrap"><table class="pl-goal-table"><thead><tr><th>${html("Stat")}</th><th class="pl-gold">★ ${html("Top desired")} <small>${html("min – max")}</small></th><th class="pl-teal">✓ ${html("Acceptable")} <small>${html("min – max")}</small></th></tr></thead><tbody>${availableStats(target).map((key) => {
        const limit = statusStat(key, target) ? 9999 : statMaximum(key, target);
        const box = (tier, bound) => `<input type="number" min="0" max="${limit}" step="1" data-stat="${key}" data-tier="${tier}" data-bound="${bound}" value="${p[tier][bound === "min" ? "stats" : "maxStats"][key] ?? ""}" placeholder="${html(bound === "min" ? "Min" : "Max")}" aria-label="${esc(`${tierName(tier)} · ${statName(key, target)} · ${pl(bound === "min" ? "Min" : "Max")}`)}">`;
        return `<tr><th>${esc(statName(key, target))}${key === "affinity" ? " (%)" : ""}${rollHint(key, target)}</th>${["preferred", "acceptable"].map((tier) => `<td><div class="pl-range">${box(tier, "min")}<span aria-hidden="true">–</span>${box(tier, "max")}</div></td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div></div>
      <div class="pl-editor-section"><div class="pl-section-head"><h3>${html("Skill goals")}</h3><label class="pl-switch" title="${html("Use skill goals")}"><input name="skillEnabled" type="checkbox" aria-label="${html("Use skill goals")}"${p.skillEnabled ? " checked" : ""}><span class="pl-switch-track" aria-hidden="true"></span></label></div><p class="pl-fine">${html("A match for any pair in a column meets that goal. Top desired results also count as acceptable.")} ${html("Each reroll gives one series skill and one group skill; a pair matches only when both match. Choose Any to accept a skill on its own.")}</p><div class="pl-skill-goals">${["preferred", "acceptable"].map((mode) => `<section><h4 class="${mode === "preferred" ? "pl-gold" : "pl-teal"}">${mode === "preferred" ? "★" : "✓"} ${esc(tierName(mode))}</h4><div data-pairs="${mode}">${p[mode].skills.map(comboRow).join("")}</div><button type="button" class="text-button" data-pl-action="add-pair" data-tier="${mode}">＋ ${html("Add combination")}</button></section>`).join("")}</div></div>
      <details class="pl-current-details"><summary>${html("Current weapon (optional)")}</summary><p class="pl-fine">${html("Enter your current bonuses to check goals already met. Known categories also allow Keep Bonuses and can prove goals met by every possible tier combination.")}</p><h4>${html("Current bonuses in game order")}</h4><div class="pl-five-slots">${Array.from({ length: 5 }, (_, index) => `<label>${html("Slot {n}", { n: index + 1 })}<select data-current-bonus="${index}">${options(bonusOptions, p.currentBonuses?.[index], true)}</select></label>`).join("")}</div><h4>${html("Or known categories in game order")}</h4><div class="pl-five-slots">${Array.from({ length: 5 }, (_, index) => `<label>${html("Slot {n}", { n: index + 1 })}<select data-current-category="${index}">${options(categories, target.keepCategories?.[index], true)}</select></label>`).join("")}</div><h4>${html("Current skills")}</h4><div class="pl-current-pair"><select name="currentSeries" aria-label="${html("Series skill")}">${comboOptions(series, p.currentSkill === null ? null : Math.floor(p.currentSkill / 14), true)}</select><span>＋</span><select name="currentGroup" aria-label="${html("Group skill")}">${comboOptions(groups, p.currentSkill === null ? null : p.currentSkill % 14, true)}</select></div></details>
      ${target.attributeForce >= 6 && target.weaponType < 12 ? `<div class="pl-status-values"><h4>${html("Status boost values")}</h4><p class="pl-fine">${html("Enter the II and EX gains shown on this weapon to use a status minimum.")}</p>${[0, 1].map((index) => `<label>${index === 0 ? "II" : "EX"}<input name="element${index}" type="number" min="0" max="9999" step="1" value="${p.elementValues[index] ?? ""}"></label>`).join("")}</div>` : ""}</div></section><section id="pl-finishes-panel" role="tabpanel" aria-labelledby="pl-tab-finishes" hidden></section><p id="pl-editor-error" class="error" role="alert" hidden></p><div class="pl-editor-footer"><button class="text-button" type="button" data-pl-action="cancel-edit">${html("Cancel")}</button><button class="primary" type="submit">${html(isNew ? "Add weapon" : "Save weapon")}</button></div></form>`;
    q("#pl-goal-form").addEventListener("submit", submitGoals);
    if (!q("#pl-editor").open) q("#pl-editor").showModal();
    switchEditorTab(tab, stream);
    if (tab === "goals") q(isNew ? "#pl-goal-form select" : "#pl-goal-form input").focus({ preventScroll: true });
  }
  function closeEditor() {
    const dialog = q("#pl-editor");
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    stopFinishSearch();
    editing = null; draft = null; draftSourceId = null; editorTarget = null; finishList = null; finishViews = {};
  }
  // Fills the open form only; nothing is stored until the goals are saved.
  function copyGoals(sourceId) {
    const raw = getTargets().find((target) => target.id === sourceId);
    const current = findTarget(editing);
    const form = q("#pl-goal-form");
    if (!raw || !current || !form) return;
    if (draft?.id === current.id) draftSourceId = sourceId;
    const p = copiedPlanner(raw, current);
    form.elements.bonusEnabled.checked = p.bonusEnabled;
    form.elements.skillEnabled.checked = p.skillEnabled;
    for (const input of form.querySelectorAll("[data-stat]")) input.value = p[input.dataset.tier][input.dataset.bound === "min" ? "stats" : "maxStats"][input.dataset.stat] ?? "";
    for (const mode of ["acceptable", "preferred"]) form.querySelector(`[data-pairs="${mode}"]`).innerHTML = p[mode].skills.map(comboRow).join("");
    if (form.elements.element0 && raw.weaponType === current.weaponType && raw.attributeForce === current.attributeForce) [0, 1].forEach((i) => { form.elements[`element${i}`].value = p.elementValues[i] ?? ""; });
  }
  // Adding and duplicating open the editor on an unsaved weapon; type and element are chosen there.
  function openNewWeapon(source = null) {
    const weaponType = source?.weaponType ?? 3; const attributeForce = source?.attributeForce ?? 1;
    draft = { id: crypto.randomUUID(), label: "", weaponType, attributeForce, skillCombinations: defaultSkills(weaponType), keepCategories: [null, null, null, null, null], keepSource: null };
    draft.planner = source ? copiedPlanner(source, draft) : normalizedPlanner(draft);
    draftSourceId = source?.id ?? null;
    renderEditor(draft.id);
  }
  // Another type or element changes which stats exist: goals copied from a weapon are copied again for the new kind, otherwise they start over.
  function changeDraftKind(form) {
    if (!draft) return;
    stopFinishSearch();
    draft.label = form.elements.label.value.trim();
    draft.weaponType = Number(form.elements.weaponType.value); draft.attributeForce = Number(form.elements.attributeForce.value);
    const savedFinishes = draft.planner.savedFinishes;
    draft.skillCombinations = defaultSkills(draft.weaponType); delete draft.planner;
    const source = getTargets().find((v) => v.id === draftSourceId);
    draft.planner = source ? copiedPlanner(source, draft) : normalizedPlanner(draft);
    draft.planner.savedFinishes = savedFinishes;
    finishViews = {}; finishList = null;
    renderEditor(draft.id);
  }
  function uniqueLabel(baseName) {
    let label = baseName; let count = 1;
    while (getTargets().some((v) => nameOf(v) === label)) label = `${baseName} ${++count}`;
    return label;
  }
  // Browsing may leave a goal empty (to list every roll); saving still checks it.
  function readEditorTarget({ validate = true } = {}) {
    const form = q("#pl-goal-form");
    if ([...form.querySelectorAll("#pl-goals-panel input, #pl-goals-panel select, [name=label]")].some((input) => !input.checkValidity())) throw new Error(pl("Check the goal fields before continuing."));
    const target = { ...editorTarget, planner: normalizedPlanner(editorTarget) };
    const p = target.planner;
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
      if (validate) validatePlannerRequest({ origin: { baseSeed: 0, bonusCounter: 0, skillCounter: 0 }, targets: [target], limits: { bonus: 0, skill: 0 } });
    return target;
  }
  function editorError(error) {
    const message = ["goals", "statusValues", "excluded", "minAboveMax", "targets", "limits", "state"].includes(error.message) ? errorText(error.message) : error.message;
    q("#pl-editor-error").textContent = message; q("#pl-editor-error").hidden = false;
  }
  function submitGoals(event) {
    event.preventDefault();
    if (!editorTarget) return;
    try {
      const target = readEditorTarget();
      const isNew = draft?.id === target.id;
      if (isNew && !target.label) target.label = uniqueLabel(nameOf(target));
      const previous = getTargets().find((value) => value.id === target.id);
      const changed = isNew || JSON.stringify({ ...previous, planner: normalizedPlanner(previous) }) !== JSON.stringify(target);
      if (changed) target.keepSource = "手入力";
      for (const [stream, view] of Object.entries(finishViews)) if (view.sort) {
        const key = `${stream}:${target.id}`;
        if (JSON.stringify(view.sort) === JSON.stringify(goalFinishSort(target, stream))) delete cache.finishSort[key];
        else cache.finishSort[key] = view.sort;
      }
      if (isNew) { if (cache.selected.length < MAX_SELECTED) cache.selected.push(target.id); setTargets([...getTargets(), target]); }
      else if (changed) setTargets(getTargets().map((v) => v.id === editing ? target : v));
      closeEditor();
      if (changed) invalidate();
      else { persist(); renderResults(); }
      renderWeapons();
    } catch (error) {
      switchEditorTab("goals"); editorError(error);
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
    : ["Every weapon only needs to reach its acceptable goal.", "Bonus and skill rolls are separate streams, so the route is the shortest bonus window plus the shortest skill window.", "Rolls that happen anyway upgrade weapons toward top desired at no extra cost, in list order."]).concat(["Saved picks are alternatives: the route chooses one per stream. Automatic results are used only when no picks are saved."]).map((rule) => `<span>${html(rule)}</span>`).join("")}</span>`;
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
      const saved = data.targets.some((target) => ["bonus", "skill"].some((stream) => hasGoal(target, stream) && target.planner.savedFinishes?.[stream]?.length));
      return `<button type="button" class="pl-route" data-pl-route="${mode}" aria-pressed="${cache.mode === mode}"${totalDone() > 0 && cache.mode !== mode ? " disabled" : ""}><div class="pl-route-title"><span class="pl-radio" aria-hidden="true"></span><strong>${html(mode === "preferred" ? "Top desired route" : "Fastest acceptable")}</strong></div><div class="pl-route-total"><strong>${data.total === null ? "—" : data.total}</strong><span>${html(data.complete ? "rolls" : incomplete ? "Search incomplete" : "No complete route")}</span></div><p class="pl-muted">${data.complete ? html("{bonus} bonus + {skill} skill", { bonus: data.bonus.horizon, skill: data.skill.horizon }) : html("Increase the roll limits or relax your goals.")}</p>${data.complete && data.dropped?.length ? `<p class="pl-drop-note">${html("Leaves out {n}: {names}", { n: data.dropped.length, names: shortNames(data) })}</p>` : ""}${routeRules(mode)}<div class="pl-route-bottom"><span>${html(data.complete ? data.proven ? saved ? "Minimum proven with saved picks" : "Minimum proven" : "Best found" : incomplete ? "Search incomplete" : "No complete route")}</span><span>${html("Within your roll limits")}</span></div></button>`;
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
    if (r.savedConflicts?.length) note = [pl("No route found using saved picks for: {names}. Add more saved options, remove a pick, or adjust the goals or roll limits. Your picks are kept.", { names: r.savedConflicts.map(({ id, stream }) => `${nameOf(r.targets.find((target) => target.id === id))} (${pl(stream === "bonus" ? "Bonus rolls" : "Skill rolls")})`).join(", ") }), note].filter(Boolean).join(" · ");
    if (r.alternativesComplete === false && totalDone() === 0) note = [note, pl("More alternative routes may exist within these roll limits.")].filter(Boolean).join(" · ");
    q("#pl-route-note").textContent = note;
    const choices = r.complete && r.alternatives?.length && totalDone() === 0 && ok ? [r, ...r.alternatives] : [];
    q("#pl-alternatives").hidden = !choices.length;
    q("#pl-alternatives").innerHTML = choices.length ? `<p>${html("Some weapons need the same rolls. Choose which route to follow:")}</p>${choices.map((choice, index) => `<button type="button" class="pl-alternative" data-pl-alt="${index}" aria-pressed="${index === 0}"><span class="pl-radio" aria-hidden="true"></span><span><strong>${html("{rolls} rolls", { rolls: choice.total })}</strong> · ${esc(shortNames(choice, "conflict") ? pl("leaves out {names}", { names: shortNames(choice, "conflict") }) : pl("finishes every weapon"))}</span></button>`).join("")}` : "";
    q("#pl-route-note").className = note ? `pl-route-note${!ok || !r.complete || r.dropped?.length || r.savedConflicts?.length ? " is-warning" : ""}` : "";
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
    const description = step.intent === "acquire" ? "Acquire this ordered layout for a later Keep Bonuses step." : step.intent === "advance" ? "Advance the shared counter on this weapon to reach the next useful result." : "";
    const goalMode = step.intent === "finish" && step.rolls.at(-1).quality === "preferred" ? "preferred" : r.mode;
    q("#pl-guide").innerHTML = `<button type="button" class="pl-guide-pointer" data-pl-action="show-row" aria-hidden="true" tabindex="-1"></button><div class="pl-guide-content"><div class="pl-guide-kicker"><span>${html(saved ? "Saved" : current ? "Current step" : "Preview")}</span><span>${html("Step {n} of {total}", { n: inspected + 1, total: r.steps.length })}</span></div><div class="pl-guide-heading"><div><h3>${esc(nameOf(target))}</h3><p class="pl-menu-action">${esc(actionName(step.action))} <span>${prefix}${step.start}${step.end === step.start ? "" : `–${step.end}`}</span></p></div><span class="pl-repeat">× <strong>${step.rolls.length}</strong></span></div>${step.stream === "skill" ? upgradeWarning(r, [step]) : ""}<div class="pl-guide-goalblock"><span class="pl-guide-label">${html(step.intent === "acquire" ? "Layout" : "Goal")}</span>${step.intent === "acquire" ? `<ol class="pl-guide-slots" aria-label="${html("Layout")}">${step.rolls.at(-1).raw.map((id, index) => `<li><small>${index + 1}</small>${esc(statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]], target))}</li>`).join("")}</ol>` : `<p class="pl-guide-goal">${esc(step.stream === "bonus" ? bonusGoalText(target, goalMode) : pairText(goalFor(target, goalMode, "skill")))}</p>`}${description ? `<p class="pl-guide-purpose">${html(description)}</p>` : ""}</div>${finishMarkup(r, step)}
      <div class="pl-reference-heading"><h4>${html("Expected rolls")}</h4></div><p class="pl-fine pl-reference-note">${html("Use the exact weapon and action above. Match your in-game result to find your place.")}</p><div class="pl-expected-list">${step.rolls.map((roll, index) => {
        const tag = current && compatible() ? "button" : "div";
        return `<${tag}${tag === "button" ? ` type="button" data-pl-match="${index + 1}" aria-label="${html("Match draw {n}", { n: index + 1 })}" aria-pressed="${matched === index + 1}"` : ""} class="pl-expected-roll${index < matched && current ? " is-passed" : ""}${index + 1 === matched && current ? " is-matched" : ""}"><span class="pl-draw-number"><strong>${index + 1}</strong><small>${prefix}${roll.offset}</small></span><span class="pl-draw-result">${resultMarkup(roll, step, target)}${step.intent !== "advance" && index === step.rolls.length - 1 ? badge(step) : ""}</span>${current && matched === index + 1 ? '<span class="pl-match-check">✓</span>' : ""}</${tag}>`;
      }).join("")}</div>
      <footer class="pl-guide-footer">${current ? `<div><strong>${html("{matched}/{total} matched · {remaining} remaining", { matched, total: step.rolls.length, remaining: step.rolls.length - matched })}</strong><button type="button" class="primary" data-pl-action="done"${!compatible() || worker ? " disabled" : ""}>${html("Done & saved")} →</button></div><p class="pl-fine">${html("Finish this block and save in game, then confirm here. Matching a result only marks your place; it never saves a step or advances the counters.")}</p>` : totalDone() < r.steps.length ? `<button type="button" class="secondary" data-pl-action="current">← ${html("Back to current step")}</button>` : `<span class="pl-teal">✓ ${r.dropped?.length ? html("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : html("Route complete. All chosen goals are met.")}</span>`}</footer><details class="pl-state-details"><summary>${html("Saved state details")}</summary><p>${html("Before")} <code>${esc(stateCode(stepState(r, step, "before")))}</code></p><p>${html("After")} <code>${esc(stateCode(stepState(r, step, "after")))}</code></p></details></div>`;
    schedulePointer();
  }
  // A weapon's finish can be swapped for any other that keeps the stream's
  // roll count, until a step in that stream is saved.
  const canChooseFinish = (r, step) => step.intent === "finish" && r.complete && !worker && compatible() && cache.completed[step.stream] === 0;
  function finishMarkup(r, step) {
    if (!canChooseFinish(r, step)) return "";
    const count = getTargets().find((target) => target.id === step.targetId)?.planner?.savedFinishes?.[step.stream]?.length ?? 0;
    const text = count ? pl("The route uses one of this weapon's {n} saved picks.", { n: count }) : pl("Automatic — no saved picks");
    const prefix = step.stream === "bonus" ? "G" : "S";
    return `<div class="pl-finish-card"><div class="pl-finish-card-top"><div><span class="pl-guide-label pl-gold">${html("Finish")}</span><div class="pl-finish-value">${prefix}${step.rolls.at(-1).offset} ${badge(step)}</div></div><button type="button" class="pl-finish-toggle" data-pl-action="finishes">${html("Browse finishes")}</button></div><p class="pl-finish-sub">${esc(text)}</p></div>`;
  }

  const finishSortFor = (stream, target) => cache.finishSort[`${stream}:${target.id}`] ?? goalFinishSort(target, stream);
  const sortKeys = (stream, target) => stream === "bonus" ? FINISH_SORT_KEYS.filter((key) => ["top", "direct"].includes(key) || availableStats(target).includes(key)) : ["top"];
  const finishSearchSignature = (target, stream) => {
    const { savedFinishes, ...goals } = target.planner;
    const state = getState();
    return JSON.stringify([state.baseSeed, state[`${stream}Counter`], target.weaponType, target.attributeForce, target.keepCategories, goals]);
  };
  let finishWorker = null;
  function stopFinishSearch() {
    if (finishWorker) finishWorker.terminate();
    finishWorker = null;
    for (const view of Object.values(finishViews)) view.loading = false;
  }
  function switchEditorTab(tab, stream) {
    if (!editorTarget) return;
    if (tab === "finishes") {
      try {
        editorTarget = readEditorTarget({ validate: false });
        if (draft?.id === editing) draft = editorTarget;
      } catch (error) { editorError(error); return; }
      const nextStream = stream ?? finishList?.stream ?? (editorTarget.planner.bonusEnabled ? "bonus" : "skill");
      if (finishList?.stream !== nextStream) stopFinishSearch();
      // The Top and OK rows are the draft goals themselves; "trying" is a
      // temporary row that changes no goal until it is applied.
      finishList = finishViews[nextStream] ??= { stream: nextStream, from: 1, to: Math.max(1, cache.limits[nextStream]), active: "acceptable", trying: null, notice: "", visible: 50, options: null, error: "" };
    }
    editorTab = tab;
    q("#pl-editor .section-heading .pl-muted").textContent = nameOf(editorTarget);
    filterMenuOpen = false; filterEditing = null; sortMenuOpen = false;
    q("#pl-editor-error").hidden = true;
    for (const name of ["goals", "finishes"]) {
      q(`#pl-tab-${name}`).setAttribute("aria-selected", String(tab === name));
      q(`#pl-tab-${name}`).tabIndex = tab === name ? 0 : -1;
      q(`#pl-${name}-panel`).hidden = tab !== name;
    }
    q("#pl-editor").scrollTop = 0;
    renderFinishModal();
    if (tab === "finishes" && !finishList.loading && (!finishList.options || finishList.signature !== finishSearchSignature(editorTarget, finishList.stream))) searchEditorFinishes();
  }
  function finishBrowserMarkup() {
    const list = finishList;
    if (!list || !editorTarget) return "";
    const target = editorTarget;
    const stream = list.stream;
    const prefix = stream === "bonus" ? "G" : "S";
    const levels = list.sort ?? finishSortFor(stream, target);
    const keys = sortKeys(stream, target);
    const sortName = (key) => key === "top" ? pl("Top desired") : key === "direct" ? pl("No Reset needed") : statName(key, target);
    const unusedSorts = keys.filter((key) => !levels.some((level) => level.key === key));
    const sortChips = levels.map((level, index) => `<span class="pl-sort-chip"><button type="button" data-pl-action="sort-flip" data-index="${index}" aria-label="${html("Sort level {n}: {name}, {direction}. Click to reverse.", { n: index + 1, name: sortName(level.key), direction: pl(level.dir === "desc" ? "High first" : "Low first") })}">${esc(sortName(level.key))} ${level.dir === "desc" ? "↓" : "↑"}</button><button type="button" class="pl-sort-remove" data-pl-action="sort-remove" data-index="${index}" aria-label="${html("Remove sort level {n}", { n: index + 1 })}">×</button></span>`).join("");
    const sortMenu = sortMenuOpen ? `<div class="pl-sort-menu" data-browser-menu>${unusedSorts.map((key) => `<button type="button" data-pl-action="sort-pick" data-key="${key}">${esc(sortName(key))}</button>`).join("")}</div>` : "";
    const filterName = (key) => ({ top: pl("Top desired only"), saved: pl("Saved picks only"), direct: pl("No Reset needed"), action: pl("Action"), series: pl("Series skill"), group: pl("Group skill"), pair: pl("Add combination") })[key] ?? statName(key, target);
    const filterLabel = (filter) => ["top", "saved", "direct"].includes(filter.key) ? filterName(filter.key) : filter.key === "action" ? actionName(filter.value)
      : filter.key === "series" ? t(series[filter.value]) : filter.key === "group" ? t(groups[filter.value]) : filter.key === "pair" ? pairText([filter])
        : `${filterName(filter.key)} ${filter.min !== null ? `≥ ${filter.min}` : ""}${filter.min !== null && filter.max !== null ? " · " : ""}${filter.max !== null ? `≤ ${filter.max}` : ""}`;
    const rowKeys = (row, chips) => row !== "trying" ? (stream === "bonus" ? availableStats(target).filter((key) => !chips.some((chip) => chip.key === key)) : ["pair"])
      : ["top", "saved", ...(stream === "bonus" ? ["action", "direct", ...availableStats(target)] : ["series", "group", "pair"])].filter((key) => key === "pair" || !chips.some((chip) => chip.key === key));
    // The chip being edited holds its own fields, in place of its label.
    const editingChip = () => {
      const f = filterEditing;
      const choices = f.key === "action" ? [["reset", pl("Reset Bonuses")], ["keep", pl("Keep Bonuses")]] : f.key === "series" ? series.map((name, id) => [id, t(name)]) : f.key === "group" ? groups.map((name, id) => [id, t(name)]) : null;
      const field = f.key === "pair" ? `<select data-filter-series aria-label="${html("Series skill")}">${pairOptions(series, f.seriesIndex, "Any series skill")}</select><span>＋</span><select data-filter-group aria-label="${html("Group skill")}">${pairOptions(groups, f.groupIndex, "Any group skill")}</select>`
        : choices ? `<select data-filter-value aria-label="${esc(filterName(f.key))}">${choices.map(([id, label]) => `<option value="${id}"${String(id) === String(f.value) ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`
          : `<span>≥</span><input type="number" min="0" step="1" data-filter-min value="${f.min ?? ""}" aria-label="${html("Filter minimum")}"><span>≤</span><input type="number" min="0" step="1" data-filter-max value="${f.max ?? ""}" aria-label="${html("Filter maximum")}">`;
      return `<span class="pl-sort-chip is-editing"><span class="pl-chip-name">${esc(f.key === "pair" ? pl("Skill pair") : filterName(f.key))}</span>${field}<button type="button" class="pl-chip-apply" data-pl-action="filter-apply" aria-label="${html("Apply")}">✓</button><button type="button" class="pl-sort-remove" data-pl-action="filter-cancel" aria-label="${html("Cancel")}">×</button></span>`;
    };
    const filterRow = (row) => {
      const chips = rowChips(row);
      const label = row === "preferred" ? `★ ${pl("Top")}` : row === "acceptable" ? `✓ ${pl("OK")}` : pl("Trying");
      const keys = rowKeys(row, chips);
      const editing = filterEditing?.row === row ? filterEditing : null;
      const chipMarkup = [...chips.map((chip, index) => editing?.index === index ? editingChip() : `<span class="pl-sort-chip"><button type="button" data-pl-action="filter-edit" data-row="${row}" data-index="${index}">${esc(filterLabel(chip))}</button><button type="button" class="pl-sort-remove" data-pl-action="filter-remove" data-row="${row}" data-index="${index}" aria-label="${html("Remove filter {name}", { name: filterLabel(chip) })}">×</button></span>`), ...(editing && editing.index === null ? [editingChip()] : [])].join(stream === "skill" && row !== "trying" ? `<span class="pl-filter-or">${html("or")}</span>` : "");
      const menu = filterMenuOpen === row ? `<div class="pl-sort-menu" data-browser-menu>${keys.map((key) => `<button type="button" data-pl-action="filter-pick" data-row="${row}" data-key="${key}">${esc(filterName(key))}</button>`).join("")}</div>` : "";
      const actions = row === "trying" ? `<button type="button" class="pl-sort-add" data-pl-action="trying-apply" data-tier="acceptable">${html("Apply to OK")}</button><button type="button" class="pl-sort-add" data-pl-action="trying-apply" data-tier="preferred">${html("Apply to Top")}</button><button type="button" class="pl-sort-add" data-pl-action="trying-discard">${html("Discard")}</button>`
        : !list.trying ? `<button type="button" class="pl-sort-add" data-pl-action="trying-start" data-tier="${row}">${html("Try changes")}</button>` : "";
      const active = list.active === row;
      return `<div class="pl-sort pl-filter-row is-${row}${active ? " is-active" : ""}"><div class="pl-sort-row"><button type="button" class="pl-filter-row-name" data-pl-action="filter-row" data-row="${row}" aria-pressed="${active}" title="${html("Filter the list by this row")}">${esc(label)}</button>${chipMarkup}${keys.length ? `<button type="button" class="pl-sort-add" data-pl-action="filter-menu" data-row="${row}" aria-haspopup="true" aria-expanded="${filterMenuOpen === row}">＋</button>` : ""}${actions}</div>${menu}</div>`;
    };
    const filterRows = `<div class="pl-filter-rows"><span class="pl-sort-label">${html("Filter")}</span>${filterRow("preferred")}${filterRow("acceptable")}${list.trying ? filterRow("trying") : ""}</div>`;
    const filterHint = `<p class="pl-fine">${html("Top and OK filters edit this weapon’s goals. Choose a row’s name to filter the list by it, or Try changes to explore without changing a goal.")}</p>${list.notice ? `<p class="pl-fine pl-filter-notice">${esc(list.notice)}</p>` : ""}`;
    const picks = target.planner.savedFinishes?.[stream] ?? [];
    const savedIds = new Set(picks.map(savedFinishId));
    const current = list.signature === finishSearchSignature(target, stream);
    const savedOption = (option) => savedIds.has(savedFinishId({ ...option, baseSeed: list.origin.baseSeed, originCounter: list.origin[`${stream}Counter`], weaponType: target.weaponType, attributeForce: target.attributeForce }));
    const sortSignature = JSON.stringify(levels);
    if (list.options && (list.sorted?.options !== list.options || list.sorted.signature !== sortSignature)) list.sorted = { options: list.options, signature: sortSignature, rows: sortFinishOptions(list.options, levels) };
    const filters = activeFilters();
    const filtered = list.options ? list.sorted.rows.filter(({ option }) => finishOptionMatches(option, filters, savedOption(option))) : [];
    const inRoute = current ? usedFinish(target.id, stream) : null;
    const items = filtered.slice(0, list.visible).map(({ option, index }) => {
      const saved = savedOption(option);
      const used = inRoute !== null && inRoute.key === `${option.action}:${option.finish}:${(option.action === "keep" ? option.layout ?? option.choices?.find((choice) => choice.id === target.id)?.layout : null)?.join("") ?? ""}`;
      return `<button type="button" class="pl-finish-option${saved ? " is-current" : ""}" data-pl-save-pick="${index}" aria-pressed="${Boolean(saved)}"${!current || list.loading ? " disabled" : ""}${option.meets ? "" : ` data-below-goal`}><span class="pl-finish-where">${option.top ? `<span class="pl-gold">★</span>` : ""}<strong class="pl-finish-roll">${prefix}${option.finish}</strong><span class="pl-finish-how">${esc(actionName(option.action))}${(used ? inRoute.acquire : option.acquire) ? ` · ${esc(pl("Reset at {at} first", { at: `${prefix}${used ? inRoute.acquire : option.acquire}` }))}` : ""}</span>${used ? `<span class="pl-pick-used">${html("Used in current route")}</span>` : ""}${option.meets ? "" : `<span class="pl-below-goal">${html("Below goal")}</span>`}<span class="pl-save-toggle${saved ? " is-saved" : ""}">${ICON_BOOKMARK}${html(saved ? "Saved pick" : "Save pick")}</span></span><span class="pl-finish-result">${resultMarkup(option, { stream }, target)}</span></button>`;
    }).join("");
    const savedRows = picks.map((pick) => savedPickRow(target, stream, pick, 'data-pl-action="draft-remove-pick"')).join("");
    const summary = list.options ? pl("{shown} matching finishes · searched {from}–{to} · {saved} saved", { shown: filtered.length, from: list.loadedFrom, to: list.loadedTo, saved: picks.length }) : pl("Search every finish in the roll range, filtered by the chosen row.");
    return `<div class="pl-browser-search"><label>${html("Stream")}<select data-pl-finish-stream>${["bonus", "skill"].map((value) => `<option value="${value}"${stream === value ? " selected" : ""}>${html(value === "bonus" ? "Bonus rolls" : "Skill rolls")}</option>`).join("")}</select></label><div class="pl-browser-range"><label>${html("From roll")}<input type="number" min="1" max="10000" step="1" data-browser-range="from" value="${list.from}"></label><span>–</span><label>${html("To roll")}<input type="number" min="1" max="10000" step="1" data-browser-range="to" value="${list.to}"></label></div><button type="button" class="secondary" data-pl-action="search-finishes">${html("Search")}</button>${list.loading ? `<button type="button" class="text-button" data-pl-action="cancel-finish-search">${html("Cancel search")}</button>` : ""}</div><p class="pl-fine">${html("Roll numbers start at the current saved position. A Keep finish may need an earlier Reset.")}</p>${picks.length ? `<details class="pl-browser-favorites"><summary>${html("Saved picks ({n})", { n: picks.length })}</summary><ul class="pl-saved-picks">${savedRows}</ul></details>` : ""}<div class="pl-browser-controls">${filterRows}<div class="pl-sort"><span class="pl-sort-label">${html("Sort")}</span><div class="pl-sort-row">${sortChips}${unusedSorts.length ? `<button type="button" class="pl-sort-add" data-pl-action="sort-menu" aria-haspopup="true" aria-expanded="${sortMenuOpen}">＋ ${html("Sort")}</button>` : ""}</div>${sortMenu}</div></div>${filterHint}<p class="pl-fine" role="status">${list.loading ? html("Checking other finishes for {name}…", { name: nameOf(target) }) : esc(summary)}${list.complete === false ? ` · ${html("Showing the best {cap} of {total} by this sort. Narrow the range or add filters to see the rest.", { cap: list.options.length, total: list.total })}` : ""}</p>${list.error ? `<p class="error" role="alert">${esc(list.error)}</p>` : ""}${list.options && !current ? `<p class="pl-browser-warning">${html("Goals or saved position changed. Search again to refresh these finishes. Your saved picks are kept.")}</p>` : ""}<div class="pl-finish-list">${items || (!list.loading && list.options ? `<p class="pl-fine">${html("No finishes match these filters. Your saved picks are kept.")}</p>` : "")}</div>${filtered.length > list.visible ? `<button type="button" class="secondary" data-pl-action="more-finishes">${html("Show more finishes")}</button>` : ""}<p class="pl-fine pl-browser-save-note">${html("Save weapon to keep your goals and saved picks. Build guides separately when you are ready.")}</p>`;
  }
  // A row's chips: Top and OK read the draft goals, so they are always in sync.
  function rowChips(row) {
    if (row === "trying") return finishList.trying?.filters ?? [];
    return tierFinishFilters(editorTarget, row, finishList.stream);
  }
  function activeFilters() {
    const row = finishList.active === "trying" && !finishList.trying ? "acceptable" : finishList.active;
    return rowFilters(rowChips(row));
  }
  // Writes a goal tier into the Goals form, which stays the draft's source.
  function writeTier(tier, value) {
    const form = q("#pl-goal-form");
    if (finishList.stream === "skill") { form.querySelector(`[data-pairs="${tier}"]`).innerHTML = value.skills.map(comboRow).join(""); return; }
    for (const input of form.querySelectorAll(`[data-tier="${tier}"][data-stat]`)) input.value = (input.dataset.bound === "min" ? value.stats : value.maxStats)[input.dataset.stat] ?? "";
  }
  // Sets a row's chips. On a goal row this edits the draft goal; an invalid
  // goal (such as a minimum above what five slots can gain) is rolled back.
  function setRowChips(row, chips) {
    if (row === "trying") { finishList.trying.filters = chips; return true; }
    const before = tierFinishFilters(editorTarget, row, finishList.stream);
    writeTier(row, filtersToTier(chips, finishList.stream));
    try {
      editorTarget = readEditorTarget({ validate: false });
      if (draft?.id === editing) draft = editorTarget;
      return true;
    } catch (error) {
      writeTier(row, filtersToTier(before, finishList.stream));
      finishList.error = error.message; renderFinishModal();
      return false;
    }
  }
  function startTrying(tier) {
    finishList.trying = { from: tier, filters: structuredClone(rowChips(tier)) };
    finishList.active = "trying"; finishList.notice = ""; filterEditing = null; filterMenuOpen = false;
    refreshFinishes();
  }
  function applyTrying(tier) {
    const { skipped } = filtersToTier(finishList.trying.filters, finishList.stream);
    const chips = finishList.trying.filters.filter((chip) => !skipped.includes(chip.key));
    if (!setRowChips(tier, chips)) return;
    finishList.trying = null; finishList.active = tier; filterEditing = null; filterMenuOpen = false;
    finishList.notice = skipped.length ? pl("Top desired, saved, action and Reset filters aren’t part of a goal, so they weren’t applied.") : "";
    refreshFinishes();
  }
  function renderFinishModal() {
    if (!editorTarget || !q("#pl-finishes-panel")) return;
    const count = Object.values(editorTarget.planner.savedFinishes ?? {}).reduce((sum, picks) => sum + picks.length, 0);
    q("#pl-tab-finishes").textContent = count ? pl("Finishes ({n})", { n: count }) : pl("Finishes");
    const panel = q("#pl-finishes-panel");
    const scroll = q("#pl-editor").scrollTop;
    const favoritesOpen = panel.querySelector(".pl-browser-favorites")?.open ?? false;
    panel.innerHTML = finishBrowserMarkup();
    const favorites = panel.querySelector(".pl-browser-favorites");
    if (favorites) favorites.open = favoritesOpen;
    q("#pl-editor").scrollTop = scroll;
  }
  function updateFinishSort(change) {
    if (!finishList || !editorTarget) return;
    const levels = structuredClone(finishList.sort ?? finishSortFor(finishList.stream, editorTarget));
    change(levels, sortKeys(finishList.stream, editorTarget));
    finishList.sort = levels;
    // A capped search kept only the best by the old sort.
    if (finishList.complete === false) refreshFinishes(); else renderFinishModal();
  }
  // Filters are the search's only criteria, so changing them searches again.
  function refreshFinishes() {
    if (finishList?.options || finishList?.loading) searchEditorFinishes(); else renderFinishModal();
  }
  function searchEditorFinishes() {
    if (!finishList || !editorTarget) return;
    try {
      editorTarget = readEditorTarget({ validate: false });
      if (draft?.id === editing) draft = editorTarget;
      for (const key of ["from", "to"]) {
        const input = q(`[data-browser-range="${key}"]`);
        if (input) finishList[key] = Number(input.value);
      }
      if (![finishList.from, finishList.to].every((value) => Number.isInteger(value) && value >= 1 && value <= 10000) || finishList.from > finishList.to) throw new Error(pl("Enter a roll range from 1 to 10,000, with From no higher than To."));
      if (!hasGoal(editorTarget, finishList.stream)) throw new Error(pl("Enable this stream in Goals before searching its finishes."));
      const target = structuredClone(editorTarget);
      const request = { origin: getState(), targets: [target], limits: { bonus: 0, skill: 0, [finishList.stream]: finishList.to } };
      stopFinishSearch();
      const list = finishList;
      list.loading = true; list.error = ""; list.visible = 50;
      const signature = finishSearchSignature(editorTarget, list.stream);
      const from = list.from;
      const helper = new Worker(new URL("./planner-worker.js", import.meta.url), { type: "module" });
      finishWorker = helper;
      const fail = (message) => { if (finishWorker !== helper) return; stopFinishSearch(); list.error = message; renderFinishModal(); };
      helper.onmessage = ({ data }) => {
        if (finishWorker !== helper) return;
        if (data.type === "error") { fail(errorText(data.message)); return; }
        stopFinishSearch();
        Object.assign(list, { options: data.options, complete: data.complete, total: data.total, origin: request.origin, loadedFrom: from, loadedTo: request.limits[list.stream], signature });
        renderFinishModal();
      };
      helper.onerror = (error) => fail(pl("Unable to calculate the guide. {detail}", { detail: error.message }));
      helper.postMessage({ kind: "collect", request, stream: list.stream, targetId: target.id, from, filters: activeFilters(), sort: list.sort ?? finishSortFor(list.stream, editorTarget) });
      q("#pl-editor-error").hidden = true; renderFinishModal();
    } catch (error) { finishList.error = ["goals", "state", "limits", "statusValues", "excluded", "minAboveMax"].includes(error.message) ? errorText(error.message) : error.message; renderFinishModal(); }
  }
  function showFinishes(targetId = route()?.steps[inspected]?.targetId, stream = route()?.steps[inspected]?.stream) {
    if (targetId && ["bonus", "skill"].includes(stream)) renderEditor(targetId, { tab: "finishes", stream });
  }
  function toggleSavedPick(index) {
    const list = finishList; const option = list?.options?.[index];
    if (!editorTarget || !option || list.loading || list.signature !== finishSearchSignature(editorTarget, list.stream)) return;
    const pick = savedFinishFromOption(editorTarget, list.stream, option, list.origin);
    if (!pick) return;
    const picks = editorTarget.planner.savedFinishes ??= { bonus: [], skill: [] };
    const id = savedFinishId(pick);
    picks[list.stream] = picks[list.stream].some((value) => savedFinishId(value) === id) ? picks[list.stream].filter((value) => savedFinishId(value) !== id) : [...picks[list.stream], pick];
    renderFinishModal(); (q(`[data-pl-save-pick="${index}"]`) ?? q("#pl-tab-finishes"))?.focus({ preventScroll: true });
  }
  function applyBrowserFilter() {
    if (!filterEditing || !finishList) return;
    const { row, index, key } = filterEditing;
    const read = (name) => q(`[data-filter-${name}]`).value === "" ? null : Number(q(`[data-filter-${name}]`).value);
    let filter;
    if (key === "pair") filter = { key, seriesIndex: read("series"), groupIndex: read("group") };
    else if (["action", "series", "group"].includes(key)) filter = { key, value: key === "action" ? q("[data-filter-value]").value : Number(q("[data-filter-value]").value) };
    else {
      filter = { key, min: read("min"), max: read("max") };
      if ([filter.min, filter.max].some((value) => value !== null && (!Number.isInteger(value) || value < 0)) || (filter.min !== null && filter.max !== null && filter.min > filter.max)) { finishList.error = errorText("minAboveMax"); renderFinishModal(); return; }
    }
    const chips = [...rowChips(row)];
    // An emptied stat bound removes its chip.
    const empty = Object.hasOwn(filter, "min") && filter.min === null && filter.max === null;
    if (index !== null) { if (empty) chips.splice(index, 1); else chips[index] = filter; }
    else if (!empty) { const same = filter.key === "pair" ? -1 : chips.findIndex((chip) => chip.key === filter.key); if (same >= 0) chips[same] = filter; else chips.push(filter); }
    finishList.error = "";
    if (!setRowChips(row, chips)) return;
    filterEditing = null; finishList.visible = 50; refreshFinishes();
  }
  function removeSavedPick(targetId, stream, id) {
    const raw = getTargets().find((target) => target.id === targetId);
    if (!raw || !["bonus", "skill"].includes(stream)) return;
    const planner = normalizedPlanner(raw);
    if (!planner.savedFinishes) return;
    planner.savedFinishes[stream] = planner.savedFinishes[stream].filter((pick) => savedFinishId(pick) !== id);
    setTargets(getTargets().map((target) => target.id === targetId ? { ...raw, planner } : target));
    invalidate(); renderWeapons();
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
    try { validatePlannerRequest(request); } catch (error) { setError(errorText(error.message)); return; }
    stopWorker();
    finishList = null;
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
        else if (data.phase === "route") { cache.routes[data.mode] = data.route; persist(); renderWeapons(); renderResults(); }
      } else if (data.type === "done") {
        cache.routes = data.routes; stopWorker(); persist(); renderWeapons(); renderResults();
        setStatus(pl("Guides ready. Your saved picks are kept with each weapon."));
      } else if (data.type === "error") {
        stopWorker(); finishList = null; setError(errorText(data.message)); renderResults();
      }
    };
    worker.onerror = (error) => { if (worker !== searchWorker) return; stopWorker(); finishList = null; setError(pl("Unable to calculate the guide. {detail}", { detail: error.message })); renderResults(); };
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
    restoreSavedPicks();
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
    if (!event.target.closest(".pl-copy-wrap")) q("#pl-editor .pl-copy-menu")?.setAttribute("hidden", "");
    if (weaponMenu && !event.target.closest(".pl-menu")) { weaponMenu = null; renderWeapons(); }
    if (action === "state") openState();
    else if (action === "export") exportPlan();
    else if (action === "finishes") showFinishes();
    else if (action === "browse-finishes") showFinishes(button.dataset.id, button.dataset.stream);
    else if (action === "remove-pick") removeSavedPick(button.dataset.id, button.dataset.stream, button.dataset.pick);
    else if (action === "more-finishes") { finishList.visible = (finishList.visible ?? 50) + 50; renderFinishModal(); }
    else if (action === "editor-tab") switchEditorTab(button.dataset.tab);
    else if (action === "search-finishes") searchEditorFinishes();
    else if (action === "cancel-finish-search") { stopFinishSearch(); renderFinishModal(); }
    else if (action === "filter-menu") { filterMenuOpen = filterMenuOpen === button.dataset.row ? false : button.dataset.row; sortMenuOpen = false; renderFinishModal(); }
    else if (action === "filter-row") { finishList.active = button.dataset.row; finishList.visible = 50; refreshFinishes(); }
    else if (action === "trying-start") startTrying(button.dataset.tier);
    else if (action === "trying-apply") applyTrying(button.dataset.tier);
    else if (action === "trying-discard") { finishList.active = finishList.trying.from; finishList.trying = null; finishList.notice = ""; filterEditing = null; filterMenuOpen = false; refreshFinishes(); }
    else if (action === "filter-pick") {
      const { key, row } = button.dataset; filterMenuOpen = false;
      if (["top", "saved", "direct"].includes(key)) { if (setRowChips(row, [...rowChips(row), { key }])) refreshFinishes(); }
      else filterEditing = { row, index: null, key, ...(key === "pair" ? { seriesIndex: null, groupIndex: null } : ["action", "series", "group"].includes(key) ? { value: key === "action" ? "reset" : 0 } : { min: null, max: null }) };
      renderFinishModal(); q("[data-filter-min], [data-filter-value], [data-filter-series]")?.focus();
    }
    else if (action === "filter-edit") { const { row } = button.dataset; const index = Number(button.dataset.index); const f = rowChips(row)[index]; if (!["top", "saved", "direct"].includes(f.key)) filterEditing = { ...f, row, index }; renderFinishModal(); q("[data-filter-min], [data-filter-value], [data-filter-series]")?.focus(); }
    else if (action === "filter-remove") { const { row } = button.dataset; const chips = rowChips(row).filter((_, index) => index !== Number(button.dataset.index)); if (setRowChips(row, chips)) { finishList.visible = 50; refreshFinishes(); } }
    else if (action === "filter-apply") applyBrowserFilter();
    else if (action === "filter-cancel") { filterEditing = null; renderFinishModal(); }
    else if (action === "draft-remove-pick") { editorTarget.planner.savedFinishes[finishList.stream] = editorTarget.planner.savedFinishes[finishList.stream].filter((pick) => savedFinishId(pick) !== button.dataset.pick); renderFinishModal(); }
    else if (action === "wsort-add") { cache.weaponSort = "newTop"; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-chip button")?.focus(); }
    else if (action === "wsort-flip") { cache.weaponSort = cache.weaponSort === "newTop" ? "newBottom" : "newTop"; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-chip button")?.focus(); }
    else if (action === "wsort-remove") { cache.weaponSort = ""; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-add")?.focus(); }
    else if (action === "show-row") q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (action === "group-menu") { groupMenuOpen = !groupMenuOpen; renderGroupBar(); q("#pl-group .pl-sort-menu button")?.focus(); }
    else if (action === "group-pick") { groupMenuOpen = false; cache.weaponGroups = [...cache.weaponGroups, button.dataset.key]; persist(); renderWeapons(); q("#pl-group .pl-sort-add")?.focus(); }
    else if (action === "group-remove") { cache.weaponGroups = cache.weaponGroups.filter((_, index) => index !== Number(button.dataset.index)); persist(); renderWeapons(); }
    else if (groupMenuOpen && !event.target.closest("#pl-group .pl-sort-menu")) { groupMenuOpen = false; renderGroupBar(); }
    else if (action === "sort-menu") { sortMenuOpen = !sortMenuOpen; filterMenuOpen = false; renderFinishModal(); q("#pl-finishes-panel .pl-sort-menu button")?.focus(); }
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
    else if (action === "import") q("#pl-import-file").click();
    else if (action === "add") openNewWeapon();
    else if (action === "copy-menu") { const menu = button.nextElementSibling; menu.hidden = !menu.hidden; button.setAttribute("aria-expanded", String(!menu.hidden)); menu.querySelector("button")?.focus(); }
    else if (action === "copy-from") { copyGoals(button.dataset.id); const wrap = button.closest(".pl-copy-wrap"); wrap.querySelector(".pl-copy-menu").hidden = true; wrap.querySelector(".pl-copy-chip").setAttribute("aria-expanded", "false"); }
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
      if (source) openNewWeapon(source);
    } else if (action === "remove") {
      const id = button.dataset.id; weaponMenu = null; cache.selected = cache.selected.filter((v) => v !== id);
      setTargets(getTargets().filter((target) => target.id !== id));
      if (editing === id) { editing = null; closeEditor(); }
      invalidate(); renderWeapons();
    } else if (action === "add-pair") q(`[data-pairs="${button.dataset.tier}"]`).insertAdjacentHTML("beforeend", comboRow());
    else if (action === "remove-pair") button.closest(".pl-combo").remove();
    else if (action === "cancel") { stopWorker(); if (finishList?.loading) finishList = null; persist(); renderResults(); setStatus(pl("Search cancelled. Any completed route remains available.")); }
    else if (action === "done") markDone();
    else if (action === "current") { inspected = nextCurrent(route(), route().steps[inspected]?.stream); renderResults(); q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    const pick = event.target.closest("[data-pl-save-pick]");
    if (pick && !pick.disabled) toggleSavedPick(Number(pick.dataset.plSavePick));
    const alternative = event.target.closest("[data-pl-alt]");
    const r = route();
    if (alternative && r?.alternatives && totalDone() === 0 && Number(alternative.dataset.plAlt) > 0) {
      const index = Number(alternative.dataset.plAlt) - 1;
      const { alternatives, ...current } = r;
      cache.routes[cache.mode] = { ...alternatives[index], alternatives: [current, ...alternatives.filter((_, i) => i !== index)] };
      cache.matches = {}; inspected = 0; persist(); renderWeapons(); renderResults();
    }
    const routeButton = event.target.closest("[data-pl-route]");
    if (routeButton && !routeButton.disabled && (totalDone() === 0 || cache.mode === routeButton.dataset.plRoute)) { cache.mode = routeButton.dataset.plRoute; cache.matches = {}; inspected = 0; persist(); renderWeapons(); renderResults(); }
    const match = event.target.closest("[data-pl-match]");
    if (match && isCurrent(route(), inspected) && compatible()) { const scrollTop = q(".pl-expected-list").scrollTop; cache.matches[inspected] = Number(match.dataset.plMatch); persist(); renderGuide(); q(".pl-expected-list").scrollTop = scrollTop; q(`[data-pl-match="${match.dataset.plMatch}"]`)?.focus({ preventScroll: true }); }
    const row = event.target.closest("[data-pl-step]");
    if (row && !event.target.closest("input")) { inspected = Number(row.dataset.plStep); renderResults(); }
  });
  // Both tabs share one draft. Escape, Cancel and a backdrop click discard it.
  q("#pl-editor").addEventListener("close", () => { if (!q("#pl-editor").open) closeEditor(); });
  q("#pl-editor").addEventListener("cancel", (event) => { if (sortMenuOpen || filterMenuOpen || filterEditing) event.preventDefault(); });
  q("#pl-editor").addEventListener("mousedown", (event) => {
    const box = q("#pl-editor").getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeEditor();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && weaponMenu) { const id = weaponMenu; weaponMenu = null; renderWeapons(); q(`[data-pl-action="weapon-menu"][data-id="${id}"]`)?.focus(); return; }
    if (event.key === "Escape" && groupMenuOpen) { groupMenuOpen = false; renderGroupBar(); q("#pl-group .pl-sort-add")?.focus(); return; }
    if (event.key === "Escape" && (sortMenuOpen || filterMenuOpen || filterEditing)) { event.preventDefault(); sortMenuOpen = false; filterMenuOpen = false; filterEditing = null; renderFinishModal(); return; }
    if (event.target.matches('[role="tab"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const tab = event.key === "Home" ? "goals" : event.key === "End" ? "finishes" : editorTab === "goals" ? "finishes" : "goals"; switchEditorTab(tab); q(`#pl-tab-${editorTab}`)?.focus(); return; }
    if (event.key === "Enter" && event.target.matches("#pl-finishes-panel input")) { event.preventDefault(); if (filterEditing) applyBrowserFilter(); else searchEditorFinishes(); return; }
    if (event.target.matches("[data-pl-step]") && ["Enter", " "].includes(event.key)) { event.preventDefault(); inspected = Number(event.target.dataset.plStep); renderResults(); }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-pl-select]")) {
      if (input.checked && cache.selected.length >= MAX_SELECTED) { input.checked = false; setError(errorText("targets")); return; }
      cache.selected = input.checked ? [...cache.selected, input.dataset.plSelect] : cache.selected.filter((id) => id !== input.dataset.plSelect);
      invalidate(); renderWeapons();
    } else if (input.matches("[data-pl-new-type]")) changeDraftKind(input.form);
    else if (input.matches("[data-pl-finish-stream]")) switchEditorTab("finishes", input.value);
    else if (input.matches("[data-browser-range]")) finishList[input.dataset.browserRange] = Number(input.value);
    else if (input.matches("[data-pl-done]")) markDone(Number(input.dataset.plDone));
    else if (input.matches("#pl-import-file")) { const [file] = input.files; input.value = ""; if (file) void importPlan(file); }
    // Saved picks beyond the new limit show their warning on the cards.
    else if (input.closest("#pl-limits")) { cache.limits[input.name] = Number(input.value); invalidate(); renderWeapons(); }
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
  function restoreSavedPicks() {
    const targets = getTargets();
    const migrated = migrateSavedFinishes(targets, cache.routes, cache.mode);
    if (JSON.stringify(targets) !== JSON.stringify(migrated)) setTargets(migrated);
  }
  restoreSavedPicks(); sync(); persist();
  return { sync };
}
