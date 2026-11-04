import { t, localizedTargetName } from "./i18n.js";
import { actionName, bonusGoalText, esc, goalFor, html, skillPairsText, skillText, stateCode, statsText, weaponName } from "./planner-markup.js";
import { createWeaponEditor } from "./planner-editor.js";
import { errorText } from "./planner-worker-client.js";
import { bonusTotals, goalFinishSort, hasGoal, matchesTier, MAX_SELECTED, migrateSavedFinishes, normalizedPlanner, parsePlannerExport, plannerExport, savedFinishChoice, savedFinishId } from "./planner-model.js";
import { createRouteSession } from "./planner-route-session.js";
import { createRouteView } from "./planner-route-view.js";
import { pl } from "./planner-text.js";

const STORAGE_KEY = "gogma-weapon-planner-v1";
const ICON_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>`;

const ICON_MORE = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>`;

export function initPlanner({ root, getState, getTargets, setTargets, saveStep, openState, importState, metadata }) {
  const { weapons, attributes } = metadata;
  let stored;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { stored = null; }
  const session = createRouteSession(stored, {
    getState, getTargets, saveStep, onStatus: (message) => setStatus(message), onError: (message) => setError(message),
    onChange: () => { persist(); renderWeapons(); renderResults(); },
  });
  const cache = session.cache;
  const route = session.route;
  let storageAvailable = true;
  let lastExternal = "";
  let groupMenuOpen = false;
  let weaponMenu = null;
  const nameOf = (target) => weaponName(target, metadata);
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
  const invalidate = () => session.invalidate();
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
  const usedFinish = session.usedFinish;
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
    if (changed) invalidate();
    else { persist(); renderResults(); }
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
  const routeView = createRouteView(root, { metadata, savedPickRow });
  function renderResults() {
    q("#pl-build").disabled = session.busy; q("#pl-cancel").hidden = !session.busy;
    routeView.render(session.snapshot()); editor.refresh();
  }
  function showFinishes(targetId = route()?.steps[session.inspected]?.targetId, stream = route()?.steps[session.inspected]?.stream) {
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
  function build(event) {
    event.preventDefault(); setError();
    if (!editor.submitIfOpen()) return;
    session.build({ bonus: Number(q('#pl-limits [name="bonus"]').value), skill: Number(q('#pl-limits [name="skill"]').value) });
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
    session.stop();
    try { importState({ state: data.state, targets: data.targets }); }
    catch (error) { setError(error.message); return; }
    session.restore(data.planner);
    restoreSavedPicks();
    cache.selected = cache.selected.filter((id) => getTargets().some((v) => v.id === id));
    editor.close();
    q("#pl-limits").elements.bonus.value = cache.limits.bonus;
    q("#pl-limits").elements.skill.value = cache.limits.skill;
    persist(); renderWeapons(); renderResults(); routeView.schedulePointer();
    setStatus(pl("Plan imported."));
  }
  const markDone = (index) => session.confirm(index);
  function matchDraw(draw) {
    if (!session.match(draw)) return;
    const scrollTop = q(".pl-expected-list").scrollTop;
    persist(); routeView.renderGuide(session.snapshot());
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
    else if (action === "show-row") q(`#pl-rows [data-pl-step="${session.inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      session.cancel();
    }
    else if (action === "done") markDone();
    else if (action === "current") { session.current(); q(`#pl-rows [data-pl-step="${session.inspected}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    const alternative = event.target.closest("[data-pl-alt]");
    if (alternative && Number(alternative.dataset.plAlt) > 0) session.chooseAlternative(Number(alternative.dataset.plAlt) - 1);
    const routeButton = event.target.closest("[data-pl-route]");
    if (routeButton && !routeButton.disabled) session.chooseMode(routeButton.dataset.plRoute);
    const match = event.target.closest("[data-pl-match]");
    if (match) matchDraw(Number(match.dataset.plMatch));
    const row = event.target.closest("[data-pl-step]");
    if (row && !event.target.closest("input")) { session.inspect(Number(row.dataset.plStep)); }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && weaponMenu) { const id = weaponMenu; weaponMenu = null; renderWeapons(); q(`[data-pl-action="weapon-menu"][data-id="${id}"]`)?.focus(); return; }
    if (event.key === "Escape" && groupMenuOpen) { groupMenuOpen = false; renderGroupBar(); q("#pl-group .pl-sort-add")?.focus(); return; }
    if (dialog.contains(event.target)) { editor.keydown(event); return; }
    if (event.target.matches("[data-pl-step]") && ["Enter", " "].includes(event.key)) { event.preventDefault(); session.inspect(Number(event.target.dataset.plStep)); }
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
    if (external === lastExternal) { routeView.schedulePointer(); return; }
    lastExternal = external;
    session.syncContext(); editor.syncContext();
    q("#pl-position").textContent = stateCode(getState());
    renderWeapons(); renderResults(); routeView.schedulePointer();
  }
  window.addEventListener("gogma-state-change", sync);
  function restoreSavedPicks() {
    const targets = getTargets();
    const migrated = migrateSavedFinishes(targets, cache.routes, cache.mode);
    if (JSON.stringify(targets) !== JSON.stringify(migrated)) setTargets(migrated);
  }
  restoreSavedPicks(); sync(); persist();
  return { sync };
}
