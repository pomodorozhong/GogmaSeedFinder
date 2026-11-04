import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initSync, predict_gogma_rolls, predict_gogma_keep_rolls, predict_skill_rolls } from "./pkg/gogma_wasm_search.js";
import { layoutOf, normalizedPlanner } from "./planner-model.js";
import { collectFinishOptions, planWeapons } from "./planner-engine.js";

initSync({ module: readFileSync(new URL("./pkg/gogma_wasm_search_bg.wasm", import.meta.url)) });
const origin = { baseSeed: 86315169, bonusCounter: 480, skillCounter: 188 };
const weapons = [["long-sword", 3, 1], ["switch-axe", 8, 5], ["bow", 11, 4]].map(([id, weaponType, attributeForce]) => {
  const target = { id, label: "", weaponType, attributeForce, keepCategories: Array(5).fill(null), skillCombinations: [{ seriesIndex: 11, groupIndex: 13 }] };
  target.planner = normalizedPlanner(target);
  return target;
});
const provider = (position) => ({
  reset: (t, offset, count) => predict_gogma_rolls(position.baseSeed, t.weaponType, t.attributeForce, position.bonusCounter + offset, 35, count),
  keep: (t, offset, count, layout) => predict_gogma_keep_rolls(position.baseSeed, t.weaponType, t.attributeForce, position.bonusCounter + offset, 35, count, Uint8Array.from(layout)),
  skills: (t, offset, count) => predict_skill_rolls(position.baseSeed, t.weaponType, t.attributeForce, position.skillCounter + offset, 54, count),
});
const routes = await planWeapons({ origin, targets: weapons, limits: { bonus: 250, skill: 1000 } }, provider(origin));
const signature = (targets) => JSON.stringify(targets.map((target) => ({ id: target.id, label: target.label, weaponType: target.weaponType, attributeForce: target.attributeForce, planner: Object.fromEntries(["optional", "bonusEnabled", "skillEnabled", "acceptable", "preferred", "elementValues"].map((key) => [key, target.planner[key]])) })));
const metadata = {
  weapons: Array.from({ length: 14 }, (_, id) => [id, `Weapon ${id}`]), attributes: Array.from({ length: 10 }, (_, id) => [id, `Element ${id}`]),
  bonuses: [6, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((id) => [id, `Bonus ${id}`]), bonusName: (_, id) => `Bonus ${id}`,
  series: Array.from({ length: 21 }, (_, id) => `Series ${id}`), groups: Array.from({ length: 14 }, (_, id) => `Group ${id}`), defaultSkills: () => [{ seriesIndex: 11, groupIndex: 13 }],
};

class WorkerStub {
  static instances = [];
  constructor() { WorkerStub.instances.push(this); }
  postMessage(message) { this.request = structuredClone(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
  fail(message = "worker failed") { this.onerror?.({ message }); }
}
let initPlanner;
async function mount({ mode = "preferred", cached = true, locale = "en", position = origin, targets = weapons, stored, rejectSave = false } = {}) {
  const dom = new JSDOM('<main class="planner"></main>', { url: "http://localhost" });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, Node: window.Node, Element: window.Element, MutationObserver: window.MutationObserver,
    Worker: WorkerStub, ResizeObserver: class { observe() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  WorkerStub.instances = [];
  localStorage.setItem("gogma-seed-finder-language-v1", locale);
  let registered = structuredClone(targets), state = { ...position };
  localStorage.setItem("gogma-weapon-planner-v1", JSON.stringify(stored ?? { selected: registered.map((t) => t.id), routes: cached ? routes : {}, mode, signature: signature(registered) }));
  initPlanner ??= (await import("./planner-ui.js")).initPlanner;
  const root = document.querySelector("main"), errors = [], saves = [];
  window.addEventListener("error", (event) => { errors.push(event.error); event.preventDefault(); });
  const change = () => window.dispatchEvent(new window.Event("gogma-state-change"));
  const app = initPlanner({ root, metadata, getState: () => ({ ...state }), getTargets: () => registered,
    setTargets: (targets) => { registered = targets; change(); }, openState() {}, importState: ({ state: next, targets }) => { state = next; registered = targets; change(); },
    saveStep: (step) => {
      if (rejectSave) throw new Error("position recheck failed");
      const key = `${step.stream}Counter`;
      assert.equal(state.baseSeed, step.before.baseSeed); assert.equal(state[key], step.before[key]);
      const target = registered.find((value) => value.id === step.targetId), raw = step.rolls.at(-1).raw;
      if (step.stream === "bonus") { target.planner.currentBonuses = raw; target.keepCategories = layoutOf(raw); }
      else target.planner.currentSkill = raw;
      state = { ...state, [key]: step.after[key] }; saves.push(step); change();
    },
  });
  const q = (selector) => { const node = root.querySelector(selector); assert.ok(node, selector); return node; };
  const click = (selector) => { q(selector).click(); assert.deepEqual(errors, []); };
  const input = (selector, value, type = "input") => { const field = q(selector); if (field.type === "checkbox") field.checked = value; else field.value = value; field.dispatchEvent(new window.Event(type, { bubbles: true })); assert.deepEqual(errors, []); };
  const cache = () => JSON.parse(localStorage.getItem("gogma-weapon-planner-v1"));
  return { dom, root, q, click, input, cache, saves, errors, app, targets: () => registered, state: () => state, changePosition: (position) => { state = { ...position }; change(); } };
}
const edit = '[data-pl-action="edit"][data-id="long-sword"]';
const browse = '[data-pl-action="browse-finishes"][data-id="long-sword"][data-stream="bonus"]';
const attack = '[data-tier="acceptable"][data-stat="attack"][data-bound="min"]';
const action = (name) => `[data-pl-action="${name}"]`;
async function finish(worker) {
  const { request, stream, targetId, from, filters, sort } = worker.request;
  const result = await collectFinishOptions(request, stream, targetId, provider(request.origin), () => {}, { from, filters, sort });
  worker.emit({ type: "collected", ...result });
}

test("the three-weapon acquisition guide and every step render in all three languages", async () => {
  for (const locale of ["ja", "en", "zh-Hant"]) {
    const ui = await mount({ locale });
    const acquisition = routes.preferred.steps.findIndex((step) => step.intent === "acquire");
    assert.ok(acquisition >= 0);
    ui.click(`[data-pl-step="${acquisition}"]`);
    assert.equal(ui.root.querySelectorAll(".pl-guide-slots li").length, 5);
    for (let i = 0; i < routes.preferred.steps.length; i++) {
      ui.click(`[data-pl-step="${i}"]`);
      assert.equal(ui.root.querySelectorAll(".pl-expected-roll").length, routes.preferred.steps[i].rolls.length);
    }
    ui.dom.window.close();
  }
});

test("matching only bookmarks; explicit confirmations complete both streams in either order", async () => {
  for (const order of [["bonus", "skill"], ["skill", "bonus"]]) {
    const ui = await mount();
    for (const stream of order) for (const [index, step] of routes.preferred.steps.entries()) {
      if (step.stream !== stream) continue;
      ui.click(`[data-pl-step="${index}"]`);
      const before = structuredClone(ui.state()), count = ui.saves.length;
      ui.click('[data-pl-match="1"]');
      assert.deepEqual(ui.state(), before); assert.equal(ui.saves.length, count);
      assert.equal(ui.cache().matches[index], 1);
      ui.click(action("done"));
      assert.equal(ui.state()[`${stream}Counter`], step.after[`${stream}Counter`]);
      const other = stream === "bonus" ? "skill" : "bonus";
      assert.equal(ui.state()[`${other}Counter`], before[`${other}Counter`]);
    }
    assert.equal(ui.saves.length, routes.preferred.steps.length);
    assert.equal(ui.q("#pl-route-complete").hidden, false);
    const restored = await mount({ stored: ui.cache(), targets: ui.targets(), position: ui.state() });
    assert.equal(restored.q("#pl-route-complete").hidden, false);
    assert.equal(restored.root.querySelectorAll("[data-pl-done]").length, 0);
    restored.dom.window.close(); ui.dom.window.close();
  }
});

test("raw goal edits survive tabs, reject invalid fields, and Cancel discards them", async () => {
  const ui = await mount();
  ui.click(edit); ui.input(attack, "30"); ui.input('[name="label"]', "  Edited  ");
  ui.click('[data-pl-action="editor-tab"][data-tab="finishes"]');
  assert.equal(WorkerStub.instances.at(-1).request.request.targets[0].planner.acceptable.stats.attack, 30);
  ui.click('[data-pl-action="editor-tab"][data-tab="goals"]');
  assert.equal(ui.q(attack).value, "30"); assert.equal(ui.q('[name="label"]').value, "  Edited  ");
  ui.input(attack, "9999"); ui.click('[data-pl-action="editor-tab"][data-tab="finishes"]');
  assert.equal(ui.q("#pl-goals-panel").hidden, false); assert.equal(ui.q("#pl-editor-error").hidden, false);
  ui.click(action("cancel-edit")); assert.equal(ui.targets()[0].planner.acceptable.stats.attack, 36);
  ui.click(edit); assert.equal(ui.q(attack).value, "36");
  ui.input(attack, ""); ui.input('[name="label"]', "Saved");
  ui.q("#pl-goal-form").requestSubmit();
  assert.deepEqual(ui.errors, []); assert.equal(ui.targets()[0].label, "Saved");
  assert.deepEqual(ui.targets()[0].planner.acceptable.stats, {});
  ui.dom.window.close();
});

test("finish chips update the raw draft transactionally and picks persist only on Save", async () => {
  const ui = await mount(); ui.click(browse);
  await finish(WorkerStub.instances.at(-1));
  ui.click('[data-pl-action="filter-edit"][data-row="acceptable"][data-index="0"]');
  ui.input("[data-filter-min]", "99"); ui.click(action("filter-apply"));
  assert.equal(ui.q(attack).value, "36"); assert.ok(ui.q("#pl-finishes-panel .error").textContent);
  ui.input("[data-filter-min]", "30"); ui.click(action("filter-apply"));
  const search = WorkerStub.instances.at(-1);
  assert.equal(search.request.request.targets[0].planner.acceptable.stats.attack, 30);
  assert.ok(search.request.filters.some((f) => f.key === "attack" && f.min === 30));
  await finish(search);
  ui.click("[data-pl-save-pick]");
  assert.equal(ui.targets()[0].planner.savedFinishes?.bonus.length ?? 0, 0);
  ui.q("#pl-goal-form").requestSubmit(); assert.deepEqual(ui.errors, []);
  assert.equal(ui.targets()[0].planner.acceptable.stats.attack, 30);
  assert.equal(ui.targets()[0].planner.savedFinishes.bonus.length, 1);
  assert.equal(ui.q("#pl-editor").open, false);
  ui.dom.window.close();
});

test("route failure and cancellation leave a concurrent finish search usable", async () => {
  for (const cancel of [false, true]) {
    const ui = await mount({ cached: false });
    ui.q("#pl-limits").requestSubmit(); const routeWorker = WorkerStub.instances.at(-1);
    ui.click(browse); const finishWorker = WorkerStub.instances.at(-1);
    assert.notEqual(routeWorker, finishWorker);
    if (cancel) routeWorker.emit({ type: "progress", phase: "route", mode: "acceptable", route: routes.acceptable });
    if (cancel) ui.click(action("cancel")); else routeWorker.fail();
    assert.equal(routeWorker.terminated, true); assert.equal(finishWorker.terminated, undefined);
    assert.ok(ui.q(action("search-finishes")));
    await finish(finishWorker); assert.deepEqual(ui.errors, []);
    assert.ok(ui.root.querySelectorAll("[data-pl-save-pick]").length > 0);
    assert.equal(ui.q("#pl-build").disabled, false);
    routeWorker.emit({ type: "done", routes: {} });
    if (cancel) assert.ok(ui.cache().routes.acceptable);
    ui.dom.window.close();
  }
});

test("finish failure, retry, stream switching and close own only the finish worker", async () => {
  const ui = await mount({ cached: false });
  ui.q("#pl-limits").requestSubmit(); const routeWorker = WorkerStub.instances.at(-1);
  ui.click(browse); const first = WorkerStub.instances.at(-1); first.fail();
  assert.equal(routeWorker.terminated, undefined); assert.equal(first.terminated, true);
  assert.match(ui.q("#pl-finishes-panel").textContent, /worker failed/);
  ui.click(action("search-finishes")); const retry = WorkerStub.instances.at(-1);
  ui.input("[data-pl-finish-stream]", "skill", "change"); const skill = WorkerStub.instances.at(-1);
  assert.equal(retry.terminated, true); assert.equal(skill.request.stream, "skill");
  retry.emit({ type: "collected", options: [], complete: true, total: 0 });
  await finish(skill); assert.deepEqual(ui.errors, []);
  assert.ok(ui.root.querySelectorAll("[data-pl-save-pick]").length > 0);
  ui.click(action("search-finishes")); const pending = WorkerStub.instances.at(-1);
  ui.click(action("cancel-edit")); assert.equal(pending.terminated, true); assert.equal(routeWorker.terminated, undefined);
  ui.dom.window.close();
});

test("changing the shared position cancels obsolete finish work and permits a fresh search", async () => {
  const ui = await mount(); ui.click(browse); const first = WorkerStub.instances.at(-1);
  ui.changePosition({ ...origin, bonusCounter: origin.bonusCounter + 1 });
  assert.equal(first.terminated, true); assert.equal(ui.q(action("search-finishes")).disabled, false);
  first.emit({ type: "collected", options: [], complete: true, total: 0 });
  ui.click(action("search-finishes")); const next = WorkerStub.instances.at(-1);
  assert.equal(next.request.request.origin.bonusCounter, origin.bonusCounter + 1);
  await finish(next); assert.deepEqual(ui.errors, []);
  assert.ok(ui.root.querySelectorAll("[data-pl-save-pick]").length > 0);
  ui.dom.window.close();
});

test("copying and duplicating goals preserve independent weapon instances and raw edits", async () => {
  const ui = await mount();
  ui.click(edit); ui.input('[name="label"]', "Own name");
  ui.click(action("copy-menu")); ui.click('[data-pl-action="copy-from"][data-id="switch-axe"]');
  assert.equal(ui.q('[name="label"]').value, "Own name");
  assert.equal(ui.q(attack).value, "18");
  assert.equal(ui.q('[data-tier="acceptable"][data-stat="affinity"][data-bound="min"]').value, "14");
  ui.click('[data-pl-action="add-pair"][data-tier="acceptable"]');
  ui.input('[data-pairs="acceptable"] .pl-combo:last-child [data-pair="series"]', "0", "change");
  ui.input('[data-pairs="acceptable"] .pl-combo:last-child [data-pair="group"]', "", "change");
  ui.q("#pl-goal-form").requestSubmit(); assert.deepEqual(ui.errors, []);
  assert.deepEqual(ui.targets()[0].planner.acceptable.skills.at(-1), { seriesIndex: 0, groupIndex: null });
  ui.click('[data-pl-action="weapon-menu"][data-id="long-sword"]');
  ui.click('[data-pl-action="duplicate"][data-id="long-sword"]');
  ui.input('[name="weaponType"]', "12", "change");
  assert.equal(ui.q(attack).value, "18");
  assert.equal(ui.root.querySelectorAll('[data-stat="sharpness"]').length, 0);
  assert.ok(ui.root.querySelectorAll('[data-stat="ammo"]').length > 0);
  ui.q("#pl-goal-form").requestSubmit(); assert.deepEqual(ui.errors, []);
  assert.equal(ui.targets().length, 4);
  assert.notEqual(ui.targets().at(-1).id, ui.targets()[0].id);
  assert.equal(ui.targets()[0].weaponType, 3); assert.equal(ui.targets().at(-1).weaponType, 12);
  assert.deepEqual(ui.targets().at(-1).keepCategories, Array(5).fill(null));
  ui.dom.window.close();
});

test("status draft values and partial current results are validated before saving", async () => {
  const ui = await mount(); ui.click(action("add"));
  ui.input('[name="attributeForce"]', "6", "change");
  const status = '[data-tier="acceptable"][data-stat="element"][data-bound="min"]';
  ui.input(status, "10");
  ui.q("#pl-goal-form").requestSubmit();
  assert.equal(ui.q("#pl-editor").open, true); assert.equal(ui.q("#pl-editor-error").hidden, false);
  ui.input('[name="element0"]', "0"); ui.input('[name="element1"]', "5");
  ui.input('[data-current-bonus="0"]', "8", "change");
  ui.q("#pl-goal-form").requestSubmit(); assert.equal(ui.q("#pl-editor").open, true);
  ui.input('[data-current-bonus="0"]', "", "change");
  ui.q("#pl-goal-form").requestSubmit(); assert.deepEqual(ui.errors, []);
  assert.equal(ui.targets().length, 4);
  assert.deepEqual(ui.targets().at(-1).planner.elementValues, [0, 5]);
  assert.equal(ui.targets().at(-1).planner.acceptable.stats.element, 10);
  assert.equal(ui.targets().at(-1).planner.currentBonuses, null);
  ui.dom.window.close();
});

test("a failed saved-step recheck leaves progress unchanged", async () => {
  const ui = await mount({ rejectSave: true });
  ui.click('[data-pl-step="0"]');
  const before = ui.cache().completed, position = ui.state();
  ui.click(action("done"));
  assert.deepEqual(ui.cache().completed, before); assert.equal(ui.saves.length, 0);
  assert.deepEqual(ui.state(), position); assert.match(ui.q("#pl-error").textContent, /position recheck failed/);
  ui.dom.window.close();
});
