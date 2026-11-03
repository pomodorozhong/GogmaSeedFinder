import { t, localizedTargetName } from "./i18n.js";
import { actionName, esc, html, resultMarkup, skillPairsText, skillText, statName, statsText, tierName, weaponName } from "./planner-markup.js";
import { createWeaponEditor } from "./planner-editor.js";
import { createPlannerWorker, errorText, terminatePlannerWorker } from "./planner-worker-client.js";
import { availableStats, bonusTotals, choiceKey, goalFinishSort, hasBonusGoal, hasGoal, matchesTier, MAX_SELECTED, migrateSavedFinishes, normalizedFinishSort, normalizedPlanner, normalizedProgress, parsePlannerExport, plannerExport, routePosition, routeWeaponsMatch, samePosition, savedFinishChoice, savedFinishId, validatePlannerRequest } from "./planner-model.js";
import { routeProgress } from "./planner-progress.js";
import { pl } from "./planner-text.js";

const STORAGE_KEY = "gogma-weapon-planner-v1";
const ICON_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>`;

const ICON_MORE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>`;

const number = (value) => value === null || value === undefined ? pl("Unknown") : value.toLocaleString();
const stateCode = (state) => state.baseSeed === null ? pl("Unknown") : `GSF2-B${state.baseSeed}-G${state.bonusCounter ?? "?"}-S${state.skillCounter ?? "?"}`;
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
  const { weapons, attributes } = metadata;
  let stored;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { stored = null; }
  let cache = restoredCache(stored, getTargets());
  const route = () => cache.routes[cache.mode];
  const currentProgress = () => routeProgress(route()?.steps ?? [], cache.completed);
  const totalDone = () => cache.completed.bonus + cache.completed.skill;
  let inspected = currentProgress().nextIndex();
  let routeWorker = null;
  let activeContext = "";
  let stale = false;
  let storageAvailable = true;
  let lastExternal = "";
  let pointerFrame = null;
  let groupMenuOpen = false;
  let weaponMenu = null;
  const nameOf = (target) => weaponName(target, metadata);
  const prepared = () => getTargets().filter((target) => cache.selected.includes(target.id)).map((target) => ({ ...target, planner: normalizedPlanner(target) }));
  const signature = () => JSON.stringify(prepared().map((target) => ({ id: target.id, label: target.label, weaponType: target.weaponType, attributeForce: target.attributeForce, planner: { optional: target.planner.optional, bonusEnabled: target.planner.bonusEnabled, skillEnabled: target.planner.skillEnabled, acceptable: target.planner.acceptable, preferred: target.planner.preferred, elementValues: target.planner.elementValues } })));
  const compatible = () => Boolean(route()) && !stale && cache.signature === signature() && samePosition(getState(), routePosition(route(), cache.completed)) && routeWeaponsMatch(route(), cache.completed, getTargets());

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
  const goalRows = (target, mode, icon, label) => {
    const p = target.planner;
    const lines = [p.bonusEnabled ? bonusGoalText(target, mode) || pl("Any stats") : "", p.skillEnabled ? skillPairsText(goalFor(target, mode, "skill"), metadata) || pl("Any skills") : ""].filter(Boolean);
    const [first = pl("Off"), ...rest] = lines;
    return `<dt class="pl-${mode}">${icon} ${html(label)}</dt><dd class="pl-${mode}">${esc(first)}${rest.map((line) => `<small>${esc(line)}</small>`).join("")}</dd>`;
  };

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
  function invalidate(render = renderResults) {
    stopRouteSearch();
    stale = Object.keys(cache.routes).length > 0;
    cache.signature = "";
    cache.matches = {};
    setStatus(pl("Build guides to apply your changes. Saved picks are kept."));
    persist(); render();
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
    return selected ? { key: choiceKey(selected), acquire: selected.acquire ?? null } : null;
  }
  // One saved pick, judged against the given (possibly draft) goals and the
  // route's roll limit; a pick that cannot be used stays listed with its reason.
  // With two or more saved picks, `routeAttrs` adds a toggle that makes this
  // pick the only one the route may use.
  function savedPickRow(target, stream, pick, removeAttrs, routeAttrs = "") {
    const prefix = stream === "bonus" ? "G" : "S";
    const choice = savedFinishChoice(target, stream, pick, getState());
    const result = stream === "bonus" ? bonusTotals(pick.raw, { ...pick, planner: target.planner }) : pick.raw;
    const fitsGoal = matchesTier(result, target, stream, "acceptable");
    const inRoute = usedFinish(target.id, stream);
    const used = choice.key !== null && choice.key === inRoute?.key;
    const warning = !hasGoal(target, stream) ? pl("Goal is off") : choice.status === "seed" ? pl("Different seed") : choice.status === "weapon" ? pl("Different weapon type or element") : choice.status === "passed" ? pl("Roll already passed") : choice.status === "position" ? pl("Set current state") : !fitsGoal ? pl("Does not meet the updated goal") : choice.finish > cache.limits[stream] ? pl("Outside the roll limit") : "";
    const where = choice.status === "achieved" ? pl("Already met (no rolls)") : `${prefix}${choice.finish > 0 ? choice.finish : pick.finish}`;
    const chosen = target.planner.routePick?.[stream] === savedFinishId(pick);
    const routeToggle = routeAttrs && (target.planner.savedFinishes?.[stream]?.length ?? 0) > 1 && (!warning || chosen) ? `<button type="button" class="pl-route-toggle" ${routeAttrs} data-pick="${esc(savedFinishId(pick))}" aria-pressed="${chosen}">${html(chosen ? "Chosen for route" : "Use for route")}</button>` : "";
    const reset = used && inRoute.acquire ? ` <span>· ${esc(pl("Reset at {at} first", { at: `${prefix}${inRoute.acquire}` }))}</span>` : "";
    return `<li class="pl-saved-pick${warning ? " is-warning" : ""}"><div><strong>${esc(where)}</strong> <span>${esc(actionName(pick.action))}</span>${reset}${used ? `<span class="pl-pick-used">${html("Used in current route")}</span>` : ""}<p>${esc(stream === "bonus" ? statsText(result, target) : skillText(result, metadata))}</p>${warning ? `<small>${esc(warning)}</small>` : ""}${routeToggle}</div><button type="button" class="text-button" ${removeAttrs} data-pick="${esc(savedFinishId(pick))}" aria-label="${html("Remove saved pick {at}", { at: where })}">×</button></li>`;
  }
  function savedPicksMarkup(target) {
    const sections = ["bonus", "skill"].filter((stream) => hasGoal(target, stream) || target.planner.savedFinishes?.[stream]?.length).map((stream) => {
      const picks = target.planner.savedFinishes?.[stream] ?? [];
      const title = pl(stream === "bonus" ? "Bonus rolls" : "Skill rolls");
      const rows = picks.map((pick) => savedPickRow(target, stream, pick, `data-pl-action="remove-pick" data-id="${esc(target.id)}" data-stream="${stream}"`, `data-pl-action="route-pick" data-id="${esc(target.id)}" data-stream="${stream}"`)).join("");
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

  function saveWeapon(target, isNew, sorts) {
    const previous = getTargets().find((value) => value.id === target.id);
    const changed = isNew || JSON.stringify({ ...previous, planner: normalizedPlanner(previous) }) !== JSON.stringify(target);
    if (changed) target.keepSource = "手入力";
    for (const [stream, sort] of Object.entries(sorts)) {
      const key = `${stream}:${target.id}`;
      if (JSON.stringify(sort) === JSON.stringify(goalFinishSort(target, stream))) delete cache.finishSort[key];
      else cache.finishSort[key] = sort;
    }
    if (isNew) {
      if (cache.selected.length < MAX_SELECTED) cache.selected.push(target.id);
      setTargets([...getTargets(), target]);
    } else if (changed) setTargets(getTargets().map((v) => v.id === target.id ? target : v));
    if (changed) invalidate(renderRoutes);
    else { persist(); renderRoutes(); }
    renderWeapons();
  }
  const dialog = q("#pl-editor");
  const editor = createWeaponEditor(dialog, {
    metadata, getTargets, getState, usedFinish, savedPickRow, onSave: saveWeapon,
    settingsFor: (target, stream) => ({
      limit: cache.limits[stream], sort: cache.finishSort[`${stream}:${target.id}`] ?? goalFinishSort(target, stream),
    }),
  });
  const openEditor = (id, options) => editor.open(getTargets().find((target) => target.id === id), options);
  function badge(step) {
    const quality = step.rolls.at(-1).quality;
    if (step.intent === "finish") return `<span class="pl-badge pl-${quality}">${quality === "preferred" ? "★" : "✓"} ${esc(tierName(quality))}</span>`;
    return `<span class="pl-badge pl-neutral">${html(step.intent === "acquire" ? "Layout acquired" : "Advance")}</span>`;
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
  function renderResults() { renderRoutes(); editor.refresh(); }
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
    const outdated = !routeWorker && cache.signature !== signature();
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
    const progress = currentProgress();
    const row = ({ step, index, saved, current }) => {
      const target = r.targets.find((v) => v.id === step.targetId);
      const prefix = step.stream === "bonus" ? "G" : "S";
      const other = step.stream === "bonus" ? "skill" : "bonus";
      const otherDone = progress.finishedIn(other, step.targetId) ? (other === "bonus" ? pl("Bonus steps done") : pl("Skill steps done")) : "";
      return `<tr data-pl-step="${index}" tabindex="0" class="${inspected === index ? "is-inspected " : ""}${current ? "is-current " : ""}${saved ? "is-saved" : ""}" aria-label="${esc(`${pl("Step {n} of {total}", { n: index + 1, total: r.steps.length })}: ${nameOf(target)}, ${actionName(step.action)}${otherDone ? `, ${otherDone}` : ""}`)}"><td class="pl-saved-cell">${saved ? `<span class="pl-saved-check" aria-label="${html("Saved")}">✓</span>` : current ? `<input type="checkbox" data-pl-done="${index}" aria-label="${html("Done & saved")}"${!ok || routeWorker ? " disabled" : ""}>` : ""}</td><td><strong class="pl-roll-range">${prefix}${step.start}${step.end !== step.start ? `–${step.end}` : ""}</strong><small>× ${step.rolls.length}</small></td><td><strong class="pl-table-weapon">${esc(nameOf(target))}${otherDone ? ` <span class="pl-other-done" title="${esc(otherDone)}">✓ ${other === "bonus" ? "G" : "S"}</span>` : ""}</strong><span class="pl-table-action">${esc(actionName(step.action))}</span>${badge(step)}</td><td>${resultMarkup(step.rolls.at(-1), step.stream, target, metadata)}</td></tr>`;
    };
    // Bonus (G) and skill (S) steps use separate counters, so each gets its own
    // table and its own progress; either can be saved first.
    q("#pl-rows").innerHTML = [["bonus", "Bonus steps", "Bonus gains"], ["skill", "Skill steps", "Skills"]].map(([stream, title, result]) => {
      const rows = progress.tables[stream];
      const warning = stream === "skill" ? upgradeWarning(r, rows.map(({ step }) => step)) : "";
      return rows.length ? `<section class="pl-stream-table"><h4 class="pl-stream-title">${html(title)} <span>${stream === "bonus" ? "G" : "S"} · ${html("{done} of {total} steps saved", { done: cache.completed[stream], total: rows.length })}</span></h4>${warning}<div class="pl-table-scroll"><table class="pl-route-table"><thead><tr><th>${html("Saved")}</th><th>${html("Rolls")}</th><th>${html("Weapon & action")}</th><th>${html(result)}</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div></section>` : "";
    }).join("");
    alignTables(); renderGuide(progress, ok);
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
  function renderGuide(progress, ok) {
    const r = route();
    const { step, current, saved } = progress.rows[inspected];
    const target = r.targets.find((v) => v.id === step.targetId);
    const matched = Math.max(0, Math.min(step.rolls.length, Number(cache.matches[inspected]) || 0));
    const prefix = step.stream === "bonus" ? "G" : "S";
    const description = step.intent === "acquire" ? "Acquire this ordered layout for a later Keep Bonuses step." : step.intent === "advance" ? "Advance the shared counter on this weapon to reach the next useful result." : "";
    const goalMode = step.intent === "finish" && step.rolls.at(-1).quality === "preferred" ? "preferred" : r.mode;
    q("#pl-guide").innerHTML = `<button type="button" class="pl-guide-pointer" data-pl-action="show-row" aria-hidden="true" tabindex="-1"></button><div class="pl-guide-content"><div class="pl-guide-kicker"><span>${html(saved ? "Saved" : current ? "Current step" : "Preview")}</span><span>${html("Step {n} of {total}", { n: inspected + 1, total: r.steps.length })}</span></div><div class="pl-guide-heading"><div><h3>${esc(nameOf(target))}</h3><p class="pl-menu-action">${esc(actionName(step.action))} <span>${prefix}${step.start}${step.end === step.start ? "" : `–${step.end}`}</span></p></div><span class="pl-repeat">× <strong>${step.rolls.length}</strong></span></div>${step.stream === "skill" ? upgradeWarning(r, [step]) : ""}<div class="pl-guide-goalblock"><span class="pl-guide-label">${html(step.intent === "acquire" ? "Layout" : "Goal")}</span>${step.intent === "acquire" ? `<ol class="pl-guide-slots" aria-label="${html("Layout")}">${step.rolls.at(-1).raw.map((id, index) => `<li><small>${index + 1}</small>${esc(statName(({ 0: "attack", 1: "affinity", 2: "element", 3: target.weaponType >= 12 ? "ammo" : "sharpness" })[BONUS_CATEGORY[id]], target))}</li>`).join("")}</ol>` : `<p class="pl-guide-goal">${esc(step.stream === "bonus" ? bonusGoalText(target, goalMode) : skillPairsText(goalFor(target, goalMode, "skill"), metadata))}</p>`}${description ? `<p class="pl-guide-purpose">${html(description)}</p>` : ""}</div>${finishMarkup(r, step, ok)}
      <div class="pl-reference-heading"><h4>${html("Expected rolls")}</h4></div><p class="pl-fine pl-reference-note">${html("Use the exact weapon and action above. Match your in-game result to find your place.")}</p><div class="pl-expected-list">${step.rolls.map((roll, index) => {
        const tag = current && ok ? "button" : "div";
        return `<${tag}${tag === "button" ? ` type="button" data-pl-match="${index + 1}" aria-label="${html("Match draw {n}", { n: index + 1 })}" aria-pressed="${matched === index + 1}"` : ""} class="pl-expected-roll${index < matched && current ? " is-passed" : ""}${index + 1 === matched && current ? " is-matched" : ""}"><span class="pl-draw-number"><strong>${index + 1}</strong><small>${prefix}${roll.offset}</small></span><span class="pl-draw-result">${resultMarkup(roll, step.stream, target, metadata)}${step.intent !== "advance" && index === step.rolls.length - 1 ? badge(step) : ""}</span>${current && matched === index + 1 ? '<span class="pl-match-check">✓</span>' : ""}</${tag}>`;
      }).join("")}</div>
      <footer class="pl-guide-footer">${current ? `<div><strong>${html("{matched}/{total} matched · {remaining} remaining", { matched, total: step.rolls.length, remaining: step.rolls.length - matched })}</strong><button type="button" class="primary" data-pl-action="done"${!ok || routeWorker ? " disabled" : ""}>${html("Done & saved")} →</button></div><p class="pl-fine">${html("Finish this block and save in game, then confirm here. Matching a result only marks your place; it never saves a step or advances the counters.")}</p>` : totalDone() < r.steps.length ? `<button type="button" class="secondary" data-pl-action="current">← ${html("Back to current step")}</button>` : `<span class="pl-teal">✓ ${r.dropped?.length ? html("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : html("Route complete. All chosen goals are met.")}</span>`}</footer><details class="pl-state-details"><summary>${html("Saved state details")}</summary><p>${html("Before")} <code>${esc(stateCode(stepState(r, step, "before")))}</code></p><p>${html("After")} <code>${esc(stateCode(stepState(r, step, "after")))}</code></p></details></div>`;
    schedulePointer();
  }
  // A weapon's finish can be swapped for any other that keeps the stream's
  // roll count, until a step in that stream is saved.
  function finishMarkup(r, step, ok) {
    if (step.intent !== "finish" || !r.complete || routeWorker || !ok || cache.completed[step.stream] !== 0) return "";
    const raw = getTargets().find((target) => target.id === step.targetId);
    const target = raw ? { ...raw, planner: normalizedPlanner(raw) } : null;
    const picks = target?.planner.savedFinishes?.[step.stream] ?? [];
    const text = !picks.length ? pl("Automatic — no saved picks") : target.planner.routePick?.[step.stream] ? pl("The route uses the pick you chose.")
      : picks.length > 1 ? pl("The route uses one of this weapon's {n} saved picks. Choose one to use it instead.", { n: picks.length }) : pl("The route uses this weapon's saved pick.");
    const rows = picks.length > 1 ? `<ul class="pl-saved-picks">${picks.map((pick) => savedPickRow(target, step.stream, pick, `data-pl-action="remove-pick" data-id="${esc(target.id)}" data-stream="${step.stream}"`, `data-pl-action="route-pick" data-rebuild="true" data-id="${esc(target.id)}" data-stream="${step.stream}"`)).join("")}</ul>` : "";
    const prefix = step.stream === "bonus" ? "G" : "S";
    return `<div class="pl-finish-card"><div class="pl-finish-card-top"><div><span class="pl-guide-label pl-gold">${html("Finish")}</span><div class="pl-finish-value">${prefix}${step.rolls.at(-1).offset} ${badge(step)}</div></div><button type="button" class="pl-finish-toggle" data-pl-action="finishes">${html("Browse finishes")}</button></div><p class="pl-finish-sub">${esc(text)}</p>${rows}</div>`;
  }

  function showFinishes(targetId = route()?.steps[inspected]?.targetId, stream = route()?.steps[inspected]?.stream) {
    if (targetId && ["bonus", "skill"].includes(stream)) openEditor(targetId, { tab: "finishes", stream });
  }
  // Choosing the pick a weapon's route uses (again: back to any saved pick).
  // From the route itself the guides are rebuilt at once.
  function setRoutePick(targetId, stream, id, rebuild) {
    const raw = getTargets().find((target) => target.id === targetId);
    if (!raw || !["bonus", "skill"].includes(stream)) return;
    const planner = normalizedPlanner(raw);
    if (!planner.routePick) return;
    planner.routePick[stream] = planner.routePick[stream] === id ? null : id;
    setTargets(getTargets().map((target) => target.id === targetId ? { ...raw, planner } : target));
    if (rebuild) build({ preventDefault() {} });
    else { invalidate(); renderWeapons(); }
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
  function stopRouteSearch() {
    terminatePlannerWorker(routeWorker);
    routeWorker = null;
    activeContext = "";
    q("#pl-build").disabled = false; q("#pl-cancel").hidden = true;
  }
  function build(event) {
    event.preventDefault(); setError();
    if (!editor.submitIfOpen()) return;
    cache.limits = { bonus: Number(q('#pl-limits [name="bonus"]').value), skill: Number(q('#pl-limits [name="skill"]').value) };
    const request = { origin: getState(), targets: prepared(), limits: { ...cache.limits } };
    try { validatePlannerRequest(request); } catch (error) { setError(errorText(error.message)); return; }
    stopRouteSearch();
    cache.routes = {}; cache.completed = { bonus: 0, skill: 0 }; cache.matches = {}; cache.mode = "acceptable"; inspected = 0; stale = false; cache.signature = signature();
    persist(); renderResults();
    activeContext = JSON.stringify([getState(), prepared()]);
    q("#pl-build").disabled = true; q("#pl-cancel").hidden = false;
    setStatus(pl("Calculating real roll predictions for weapon {n} of {total}…", { n: 1, total: request.targets.length }));
    routeWorker = createPlannerWorker((data) => {
      if (data.type === "progress") {
        if (data.phase === "predictions") setStatus(pl("Calculating real roll predictions for weapon {n} of {total}…", { n: data.target, total: data.total }));
        else if (data.phase === "layouts") setStatus(pl("Checking ordered layouts for weapon {n}: {count}/{total}…", { n: data.target, count: data.layouts, total: data.total }));
        else if (data.phase === "optimize") setStatus(pl("Finding the shortest {mode} route…", { mode: tierName(data.mode) }));
        else if (data.phase === "route") { cache.routes[data.mode] = data.route; persist(); renderWeapons(); renderResults(); }
      } else if (data.type === "done") {
        cache.routes = data.routes; stopRouteSearch(); persist(); renderWeapons(); renderResults();
        setStatus(pl("Guides ready. Your saved picks are kept with each weapon."));
      }
    }, (message) => {
      stopRouteSearch(); editor.clearFinishResults(); setError(message); renderResults();
    });
    routeWorker.postMessage({ request });
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
    stopRouteSearch();
    try { importState({ state: data.state, targets: data.targets }); }
    catch (error) { setError(error.message); return; }
    cache = restoredCache(data.planner, getTargets());
    restoreSavedPicks();
    cache.selected = cache.selected.filter((id) => getTargets().some((v) => v.id === id));
    stale = false; editor.close();
    q("#pl-limits").elements.bonus.value = cache.limits.bonus;
    q("#pl-limits").elements.skill.value = cache.limits.skill;
    inspected = currentProgress().nextIndex();
    persist(); renderWeapons(); renderResults(); schedulePointer();
    setStatus(pl("Plan imported."));
  }
  function markDone(index = inspected) {
    const r = route();
    if (routeWorker || !r?.complete || !compatible() || !currentProgress().rows[index]?.current) return;
    const step = r.steps[index];
    // saveStep verifies the old counters again and is the only planner action
    // permitted to mutate the app's shared save state.
    try {
      saveStep(step, r.targets.find((v) => v.id === step.targetId));
      cache.completed = { ...cache.completed, [step.stream]: cache.completed[step.stream] + 1 };
      inspected = currentProgress().nextIndex(step.stream);
      persist(); renderWeapons(); renderResults();
      setStatus(pl("Progress saved in this browser"));
    } catch (error) { setError(error.message); renderResults(); }
  }
  function matchDraw(draw) {
    const progress = currentProgress();
    if (!progress.rows[inspected]?.current || !compatible()) return;
    const scrollTop = q(".pl-expected-list").scrollTop;
    cache.matches[inspected] = draw;
    persist(); renderGuide(progress, true);
    q(".pl-expected-list").scrollTop = scrollTop;
    q(`[data-pl-match="${draw}"]`)?.focus({ preventScroll: true });
  }
  function dismissGroupMenu() {
    if (!groupMenuOpen) return false;
    groupMenuOpen = false;
    renderGroupBar();
    return true;
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pl-action]");
    const action = button?.dataset.plAction;

    if (weaponMenu && !event.target.closest(".pl-menu")) { weaponMenu = null; renderWeapons(); }
    if (dialog.contains(event.target)) { editor.click(event.target, dismissGroupMenu); return; }
    if (action === "state") openState();
    else if (action === "export") exportPlan();
    else if (action === "finishes") showFinishes();
    else if (action === "browse-finishes") showFinishes(button.dataset.id, button.dataset.stream);
    else if (action === "remove-pick") removeSavedPick(button.dataset.id, button.dataset.stream, button.dataset.pick);
    else if (action === "route-pick") setRoutePick(button.dataset.id, button.dataset.stream, button.dataset.pick, button.dataset.rebuild === "true");
    else if (action === "wsort-add") { cache.weaponSort = "newTop"; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-chip button")?.focus(); }
    else if (action === "wsort-flip") { cache.weaponSort = cache.weaponSort === "newTop" ? "newBottom" : "newTop"; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-chip button")?.focus(); }
    else if (action === "wsort-remove") { cache.weaponSort = ""; persist(); renderWeapons(); q("#pl-weapon-sort .pl-sort-add")?.focus(); }
    else if (action === "show-row") q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (action === "group-menu") { groupMenuOpen = !groupMenuOpen; renderGroupBar(); q("#pl-group .pl-sort-menu button")?.focus(); }
    else if (action === "group-pick") { groupMenuOpen = false; cache.weaponGroups = [...cache.weaponGroups, button.dataset.key]; persist(); renderWeapons(); q("#pl-group .pl-sort-add")?.focus(); }
    else if (action === "group-remove") { cache.weaponGroups = cache.weaponGroups.filter((_, index) => index !== Number(button.dataset.index)); persist(); renderWeapons(); }
    else if (!event.target.closest("#pl-group .pl-sort-menu") && dismissGroupMenu()) { /* first click dismisses the menu */ }
    else if (action === "import") q("#pl-import-file").click();
    else if (action === "add") editor.add();
    else if (action === "weapon-menu") { weaponMenu = weaponMenu === button.dataset.id ? null : button.dataset.id; renderWeapons(); q(".pl-menu-list button")?.focus(); }
    else if (action === "optional") {
      const id = button.dataset.id; weaponMenu = null;
      setTargets(getTargets().map((v) => v.id === id ? { ...v, planner: { ...normalizedPlanner(v), optional: !normalizedPlanner(v).optional } } : v));
      invalidate(); renderWeapons();
    } else if (action === "edit") { weaponMenu = null; openEditor(button.dataset.id); }

    else if (action === "duplicate") {
      weaponMenu = null; renderWeapons();
      const source = getTargets().find((target) => target.id === button.dataset.id);
      if (source) editor.add(source);
    } else if (action === "remove") {
      const id = button.dataset.id; weaponMenu = null; cache.selected = cache.selected.filter((v) => v !== id);
      setTargets(getTargets().filter((target) => target.id !== id));
      if (editor.id === id) editor.close();
      invalidate(); renderWeapons();
    }
    else if (action === "cancel") {
      stopRouteSearch(); editor.clearFinishResults({ loadingOnly: true }); persist(); renderResults();
      setStatus(pl("Search cancelled. Any completed route remains available."));
    }
    else if (action === "done") markDone();
    else if (action === "current") { inspected = currentProgress().nextIndex(route().steps[inspected]?.stream); renderResults(); q(`#pl-rows [data-pl-step="${inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
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
    if (match) matchDraw(Number(match.dataset.plMatch));
    const row = event.target.closest("[data-pl-step]");
    if (row && !event.target.closest("input")) { inspected = Number(row.dataset.plStep); renderResults(); }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && weaponMenu) { const id = weaponMenu; weaponMenu = null; renderWeapons(); q(`[data-pl-action="weapon-menu"][data-id="${id}"]`)?.focus(); return; }
    if (event.key === "Escape" && groupMenuOpen) { groupMenuOpen = false; renderGroupBar(); q("#pl-group .pl-sort-add")?.focus(); return; }
    if (dialog.contains(event.target)) { editor.keydown(event); return; }
    if (event.target.matches("[data-pl-step]") && ["Enter", " "].includes(event.key)) { event.preventDefault(); inspected = Number(event.target.dataset.plStep); renderResults(); }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-pl-select]")) {
      if (input.checked && cache.selected.length >= MAX_SELECTED) { input.checked = false; setError(errorText("targets")); return; }
      cache.selected = input.checked ? [...cache.selected, input.dataset.plSelect] : cache.selected.filter((id) => id !== input.dataset.plSelect);
      invalidate(); renderWeapons();
    }
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
    if (routeWorker && activeContext !== JSON.stringify([getState(), prepared()])) {
      stopRouteSearch();
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
