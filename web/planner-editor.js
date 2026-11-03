import { createWeaponProfile } from "./weapon-profiles.js";
import { createPlannerWorker, errorText, terminatePlannerWorker } from "./planner-worker-client.js";
import { goalFormMarkup, readGoalForm, skillPairRow, writeGoalTier } from "./planner-goal-form.js";
import { finishBrowserMarkup } from "./planner-finish-view.js";
import { copiedPlanner, filtersToTier, finishSortKeys, hasGoal, normalizedPlanner, rowFilters, savedFinishFromOption, savedFinishId, tierFinishFilters } from "./planner-model.js";
import { weaponName } from "./planner-markup.js";
import { pl } from "./planner-text.js";

// Both tabs edit a single unsaved weapon. Only a successful submit sends it back to the planner.
export function createWeaponEditor(dialog, { metadata, getTargets, getState, settingsFor, usedFinish, savedPickRow, onSave }) {
  const q = (selector) => dialog.querySelector(selector);
  const nameOf = (target) => weaponName(target, metadata);
  let draft = null;
  let adding = false;
  let draftSourceId = null;
  let editorTab = "goals";
  let finishViews = {};
  let finishList = null;
  let finishWorker = null;
  let filterMenuOpen = false;
  let filterEditing = null;
  let sortMenuOpen = false;

  function open(target, options) {
    if (!target) return;
    if (draft?.id !== target.id) {
      resetFinishViews();
      draft = structuredClone(target);
      draft.planner = normalizedPlanner(draft);
      adding = false;
      draftSourceId = null;
    }
    renderEditor(options);
  }
  function add(source) {
    resetFinishViews();
    const weaponType = source?.weaponType ?? 3;
    draft = createWeaponProfile({ weaponType, attributeForce: source?.attributeForce ?? 1, skillCombinations: metadata.defaultSkills(weaponType) });
    draft.planner = source ? copiedPlanner(source, draft) : normalizedPlanner(draft);
    draftSourceId = source?.id ?? null;
    adding = true;
    renderEditor();
  }
  function resetFinishViews() {
    stopFinishSearch();
    finishViews = {};
    finishList = null;
  }
  function renderEditor({ tab = "goals", stream = "bonus" } = {}) {
    dialog.innerHTML = goalFormMarkup(draft, { isNew: adding, sources: getTargets().filter((v) => v.id !== draft.id), nameOf, metadata });
    q("#pl-goal-form").addEventListener("submit", submitGoals);
    if (!dialog.open) dialog.showModal();
    switchEditorTab(tab, stream);
    if (tab === "goals") q(adding ? "#pl-goal-form select" : "#pl-goal-form input").focus({ preventScroll: true });
  }
  function close() {
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    resetFinishViews();
    draft = null;
  }
  // Fills the open form only; nothing is stored until the goals are saved.
  function copyGoals(sourceId) {
    const raw = getTargets().find((target) => target.id === sourceId);
    const current = draft;
    const form = q("#pl-goal-form");
    if (!raw || !current || !form) return;
    if (adding) draftSourceId = sourceId;
    const p = copiedPlanner(raw, current);
    form.elements.bonusEnabled.checked = p.bonusEnabled;
    form.elements.skillEnabled.checked = p.skillEnabled;
    for (const tier of ["acceptable", "preferred"]) writeGoalTier(form, tier, p[tier], metadata);
    if (form.elements.element0 && raw.weaponType === current.weaponType && raw.attributeForce === current.attributeForce) [0, 1].forEach((i) => { form.elements[`element${i}`].value = p.elementValues[i] ?? ""; });
  }
  // Another type or element changes which stats exist: goals copied from a weapon are copied again for the new kind, otherwise they start over.
  function changeDraftKind(form) {
    if (!adding) return;
    resetFinishViews();
    draft.label = form.elements.label.value.trim();
    draft.weaponType = Number(form.elements.weaponType.value); draft.attributeForce = Number(form.elements.attributeForce.value);
    const savedFinishes = draft.planner.savedFinishes;
    draft.skillCombinations = metadata.defaultSkills(draft.weaponType); delete draft.planner;
    const source = getTargets().find((v) => v.id === draftSourceId);
    draft.planner = source ? copiedPlanner(source, draft) : normalizedPlanner(draft);
    draft.planner.savedFinishes = savedFinishes;
    renderEditor();
  }
  function uniqueLabel(baseName) {
    let label = baseName; let count = 1;
    while (getTargets().some((v) => nameOf(v) === label)) label = `${baseName} ${++count}`;
    return label;
  }
  const readEditorTarget = (options) => readGoalForm(q("#pl-goal-form"), draft, options);
  function editorError(error) {
    const message = ["goals", "statusValues", "excluded", "minAboveMax", "targets", "limits", "state"].includes(error.message) ? errorText(error.message) : error.message;
    q("#pl-editor-error").textContent = message; q("#pl-editor-error").hidden = false;
  }
  function submitGoals(event) {
    event.preventDefault();
    if (!draft) return;
    try {
      const target = readEditorTarget();
      if (adding && !target.label) target.label = uniqueLabel(nameOf(target));
      const sorts = Object.fromEntries(Object.entries(finishViews).filter(([, view]) => view.sort).map(([stream, view]) => [stream, view.sort]));
      onSave(target, adding, sorts);
      close();
    } catch (error) {
      switchEditorTab("goals");
      editorError(error);
    }
  }

  const finishSearchSignature = (target, stream) => {
    const { savedFinishes, ...goals } = target.planner;
    const state = getState();
    return JSON.stringify([state.baseSeed, state[`${stream}Counter`], target.weaponType, target.attributeForce, target.keepCategories, goals]);
  };
  function stopFinishSearch() {
    terminatePlannerWorker(finishWorker);
    finishWorker = null;
    for (const view of Object.values(finishViews)) view.loading = false;
  }
  function switchEditorTab(tab, stream) {
    if (!draft) return;
    if (tab === "finishes") {
      try {
        draft = readEditorTarget({ validate: false });
      } catch (error) { editorError(error); return; }
      const nextStream = stream ?? finishList?.stream ?? (draft.planner.bonusEnabled ? "bonus" : "skill");
      if (finishList?.stream !== nextStream) stopFinishSearch();
      // The Top and OK rows are the draft goals themselves; "trying" is a
      // temporary row that changes no goal until it is applied.
      finishList = finishViews[nextStream] ??= { stream: nextStream, from: 1, to: Math.max(1, settingsFor(draft, nextStream).limit), active: "acceptable", trying: null, notice: "", visible: 50, options: null, error: "" };
    }
    editorTab = tab;
    q(".section-heading .pl-muted").textContent = nameOf(draft);
    filterMenuOpen = false; filterEditing = null; sortMenuOpen = false;
    q("#pl-editor-error").hidden = true;
    for (const name of ["goals", "finishes"]) {
      q(`#pl-tab-${name}`).setAttribute("aria-selected", String(tab === name));
      q(`#pl-tab-${name}`).tabIndex = tab === name ? 0 : -1;
      q(`#pl-${name}-panel`).hidden = tab !== name;
    }
    dialog.scrollTop = 0;
    renderFinishModal();
    if (tab === "finishes" && !finishList.loading && (!finishList.options || finishList.signature !== finishSearchSignature(draft, finishList.stream))) searchEditorFinishes();
  }
  // A row's chips: Top and OK read the draft goals, so they are always in sync.
  function rowChips(row) {
    if (row === "trying") return finishList.trying?.filters ?? [];
    return tierFinishFilters(draft, row, finishList.stream);
  }
  function activeFilters() {
    const row = finishList.active === "trying" && !finishList.trying ? "acceptable" : finishList.active;
    return rowFilters(rowChips(row));
  }
  // Sets a row's chips. On a goal row this edits the draft goal; an invalid
  // goal (such as a minimum above what five slots can gain) is rolled back.
  function setRowChips(row, chips) {
    if (row === "trying") { finishList.trying.filters = chips; return true; }
    const before = tierFinishFilters(draft, row, finishList.stream);
    writeGoalTier(q("#pl-goal-form"), row, filtersToTier(chips, finishList.stream), metadata);
    try {
      draft = readEditorTarget({ validate: false });
      return true;
    } catch (error) {
      writeGoalTier(q("#pl-goal-form"), row, filtersToTier(before, finishList.stream), metadata);
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
    if (!draft || !q("#pl-finishes-panel")) return;
    const count = Object.values(draft.planner.savedFinishes ?? {}).reduce((sum, picks) => sum + picks.length, 0);
    q("#pl-tab-finishes").textContent = count ? pl("Finishes ({n})", { n: count }) : pl("Finishes");
    const panel = q("#pl-finishes-panel");
    const scroll = dialog.scrollTop;
    const favoritesOpen = panel.querySelector(".pl-browser-favorites")?.open ?? false;
    const list = finishList;
    if (!list) { panel.replaceChildren(); dialog.scrollTop = scroll; return; }
    const current = list.signature === finishSearchSignature(draft, list.stream);
    panel.innerHTML = finishBrowserMarkup(draft, list, { levels: list.sort ?? settingsFor(draft, list.stream).sort,
      current, inRoute: current ? usedFinish(draft.id, list.stream) : null, filterEditing, filterMenuOpen, sortMenuOpen, metadata, rowChips, filters: activeFilters(), savedPickRow });
    const favorites = panel.querySelector(".pl-browser-favorites");
    if (favorites) favorites.open = favoritesOpen;
    dialog.scrollTop = scroll;
  }
  function updateFinishSort(change) {
    if (!finishList || !draft) return;
    const levels = structuredClone(finishList.sort ?? settingsFor(draft, finishList.stream).sort);
    change(levels, finishSortKeys(finishList.stream, draft));
    finishList.sort = levels;
    // A capped search kept only the best by the old sort.
    if (finishList.complete === false) refreshFinishes(); else renderFinishModal();
  }
  // Filters are the search's only criteria, so changing them searches again.
  function refreshFinishes() {
    if (finishList?.options || finishList?.loading) searchEditorFinishes(); else renderFinishModal();
  }
  function searchEditorFinishes() {
    if (!finishList || !draft) return;
    try {
      draft = readEditorTarget({ validate: false });
      for (const key of ["from", "to"]) {
        const input = q(`[data-browser-range="${key}"]`);
        if (input) finishList[key] = Number(input.value);
      }
      if (![finishList.from, finishList.to].every((value) => Number.isInteger(value) && value >= 1 && value <= 10000) || finishList.from > finishList.to) throw new Error(pl("Enter a roll range from 1 to 10,000, with From no higher than To."));
      if (!hasGoal(draft, finishList.stream)) throw new Error(pl("Enable this stream in Goals before searching its finishes."));
      const target = structuredClone(draft);
      const request = { origin: getState(), targets: [target], limits: { bonus: 0, skill: 0, [finishList.stream]: finishList.to } };
      stopFinishSearch();
      const list = finishList;
      list.loading = true; list.error = ""; list.visible = 50;
      const signature = finishSearchSignature(draft, list.stream);
      const from = list.from;
      finishWorker = createPlannerWorker((data) => {
        stopFinishSearch();
        Object.assign(list, { options: data.options, complete: data.complete, total: data.total, origin: request.origin, loadedFrom: from, loadedTo: request.limits[list.stream], signature });
        renderFinishModal();
      }, (message) => {
        stopFinishSearch(); list.error = message; renderFinishModal();
      });
      finishWorker.postMessage({ kind: "collect", request, stream: list.stream, targetId: target.id, from, filters: activeFilters(), sort: list.sort ?? settingsFor(draft, list.stream).sort });
      q("#pl-editor-error").hidden = true; renderFinishModal();
    } catch (error) { finishList.error = ["goals", "state", "limits", "statusValues", "excluded", "minAboveMax"].includes(error.message) ? errorText(error.message) : error.message; renderFinishModal(); }
  }
  function toggleSavedPick(index) {
    const list = finishList; const option = list?.options?.[index];
    if (!draft || !option || list.loading || list.signature !== finishSearchSignature(draft, list.stream)) return;
    const pick = savedFinishFromOption(draft, list.stream, option, list.origin);
    if (!pick) return;
    const picks = draft.planner.savedFinishes ??= { bonus: [], skill: [] };
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

  function renderAndFocusFilter() {
    renderFinishModal();
    q("[data-filter-min], [data-filter-value], [data-filter-series]")?.focus();
  }
  function newFilter(key) {
    if (key === "pair") return { key, seriesIndex: null, groupIndex: null };
    if (key === "action") return { key, value: "reset" };
    if (key === "series" || key === "group") return { key, value: 0 };
    return { key, min: null, max: null };
  }
  const toggleFilters = new Set(["top", "saved", "direct"]);
  function startFilter({ row, key }) {
    filterMenuOpen = false;
    if (toggleFilters.has(key)) {
      if (setRowChips(row, [...rowChips(row), { key }])) refreshFinishes();
    } else {
      filterEditing = { ...newFilter(key), row, index: null };
    }
    renderAndFocusFilter();
  }
  function editFilter({ row, index }) {
    const chip = rowChips(row)[Number(index)];
    if (!toggleFilters.has(chip.key)) filterEditing = { ...chip, row, index: Number(index) };
    renderAndFocusFilter();
  }
  function removeFilter({ row, index }) {
    if (setRowChips(row, rowChips(row).filter((_, i) => i !== Number(index)))) {
      finishList.visible = 50;
      refreshFinishes();
    }
  }

  const finishActions = {
    "more-finishes"() { finishList.visible = (finishList.visible ?? 50) + 50; renderFinishModal(); },
    "editor-tab"({ tab }) { switchEditorTab(tab); },
    "search-finishes": searchEditorFinishes,
    "cancel-finish-search"() { stopFinishSearch(); renderFinishModal(); },
    "filter-menu"({ row }) { filterMenuOpen = filterMenuOpen === row ? false : row; sortMenuOpen = false; renderFinishModal(); },
    "filter-row"({ row }) { finishList.active = row; finishList.visible = 50; refreshFinishes(); },
    "filter-pick": startFilter,
    "filter-edit": editFilter,
    "filter-remove": removeFilter,
    "filter-apply": applyBrowserFilter,
    "filter-cancel"() { filterEditing = null; renderFinishModal(); },
    "trying-start"({ tier }) { startTrying(tier); },
    "trying-apply"({ tier }) { applyTrying(tier); },
    "trying-discard"() {
      finishList.active = finishList.trying.from;
      finishList.trying = null; finishList.notice = ""; filterEditing = null; filterMenuOpen = false;
      refreshFinishes();
    },
    "draft-route-pick"({ pick }) {
      const { stream } = finishList;
      const selected = draft.planner.routePick ??= { bonus: null, skill: null };
      selected[stream] = selected[stream] === pick ? null : pick;
      renderFinishModal();
    },
    "draft-remove-pick"({ pick }) {
      const { stream } = finishList;
      const picks = draft.planner.savedFinishes;
      picks[stream] = picks[stream].filter((value) => savedFinishId(value) !== pick);
      renderFinishModal();
    },
  };

  function click(target, dismissGroupMenu) {
    const button = target.closest("[data-pl-action]");
    const data = button?.dataset;
    const action = data?.plAction;
    if (!target.closest(".pl-copy-wrap")) q(".pl-copy-menu")?.setAttribute("hidden", "");

    if (Object.hasOwn(finishActions, action)) finishActions[action](data);
    else if (!dismissGroupMenu()) {
      if (action === "sort-menu") {
        sortMenuOpen = !sortMenuOpen; filterMenuOpen = false; renderFinishModal();
        q("#pl-finishes-panel .pl-sort-menu button")?.focus();
      } else if (action === "sort-pick") {
        sortMenuOpen = false;
        updateFinishSort((levels, keys) => { if (keys.includes(data.key)) levels.push({ key: data.key, dir: "desc" }); });
        dialog.closest(".planner")?.querySelector(".pl-sort-add")?.focus();
      } else if (action === "sort-flip") {
        updateFinishSort((levels) => { const level = levels[Number(data.index)]; level.dir = level.dir === "desc" ? "asc" : "desc"; });
      } else if (action === "sort-remove") updateFinishSort((levels) => levels.splice(Number(data.index), 1));
      else if (sortMenuOpen && !target.closest(".pl-sort-menu")) { sortMenuOpen = false; updateFinishSort(() => {}); }
      else if (action === "cancel-edit") close();
      else if (action === "copy-menu") {
        const menu = button.nextElementSibling; menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden)); menu.querySelector("button")?.focus();
      } else if (action === "copy-from") {
        copyGoals(data.id);
        const wrap = button.closest(".pl-copy-wrap");
        wrap.querySelector(".pl-copy-menu").hidden = true;
        wrap.querySelector(".pl-copy-chip").setAttribute("aria-expanded", "false");
      } else if (action === "add-pair") q(`[data-pairs="${data.tier}"]`).insertAdjacentHTML("beforeend", skillPairRow(metadata));
      else if (action === "remove-pair") button.closest(".pl-combo").remove();
    }
    // A result click can also dismiss a menu before toggling the pick.
    const pick = target.closest("[data-pl-save-pick]");
    if (pick && !pick.disabled) toggleSavedPick(Number(pick.dataset.plSavePick));
  }
  function keydown(event) {
    if (event.key === "Escape" && (sortMenuOpen || filterMenuOpen || filterEditing)) {
      event.preventDefault(); sortMenuOpen = false; filterMenuOpen = false; filterEditing = null; renderFinishModal();
    } else if (event.target.matches('[role="tab"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tab = event.key === "Home" ? "goals" : event.key === "End" ? "finishes" : editorTab === "goals" ? "finishes" : "goals";
      switchEditorTab(tab); q(`#pl-tab-${editorTab}`)?.focus();
    } else if (event.key === "Enter" && event.target.matches("#pl-finishes-panel input")) {
      event.preventDefault();
      if (filterEditing) applyBrowserFilter(); else searchEditorFinishes();
    }
  }
  dialog.addEventListener("change", ({ target }) => {
    if (target.matches("[data-pl-new-type]")) changeDraftKind(target.form);
    else if (target.matches("[data-pl-finish-stream]")) switchEditorTab("finishes", target.value);
    else if (target.matches("[data-browser-range]")) finishList[target.dataset.browserRange] = Number(target.value);
  });
  dialog.addEventListener("close", () => { if (!dialog.open) close(); });
  dialog.addEventListener("cancel", (event) => { if (sortMenuOpen || filterMenuOpen || filterEditing) event.preventDefault(); });
  dialog.addEventListener("mousedown", (event) => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });

  return {
    open, add, close, click, keydown, refresh: renderFinishModal,
    get id() { return draft?.id; },
    clearFinishResults({ loadingOnly = false } = {}) {
      if (!loadingOnly || finishList?.loading) finishList = null;
    },
    submitIfOpen() {
      if (draft) q("#pl-goal-form").requestSubmit();
      return !draft;
    },
  };
}
