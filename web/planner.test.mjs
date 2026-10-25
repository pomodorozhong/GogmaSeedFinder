import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { initSync, predict_gogma_rolls, predict_gogma_keep_rolls, predict_skill_rolls } from "./pkg/gogma_wasm_search.js";
import { bonusTotals, copiedPlanner, layoutOf, matchesTier, normalizedPlanner, resultQuality, routeWeaponsMatch, statGoalMatches, statMaximum, statRollValues, validBonuses, validLayout, validatePlannerRequest } from "./planner-model.js";
import { optimizeStream, planWeapons } from "./planner-engine.js";

initSync({ module: await readFile(new URL("./pkg/gogma_wasm_search_bg.wasm", import.meta.url)) });
const target = (id, weaponType = 3, attributeForce = 1) => {
  const t = { id, weaponType, attributeForce, keepCategories: [null, null, null, null, null], skillCombinations: [{ seriesIndex: 11, groupIndex: 13 }] };
  t.planner = normalizedPlanner(t);
  return t;
};
const request = (targets, bonus = 50, skill = 100) => ({ targets, origin: { baseSeed: 86_315_169, bonusCounter: 480, skillCounter: 188 }, limits: { bonus, skill } });
const provider = (req) => ({
  reset: (t, offset, count) => predict_gogma_rolls(req.origin.baseSeed, t.weaponType, t.attributeForce, req.origin.bonusCounter + offset, 35, count),
  keep: (t, offset, count, layout) => predict_gogma_keep_rolls(req.origin.baseSeed, t.weaponType, t.attributeForce, req.origin.bonusCounter + offset, 35, count, Uint8Array.from(layout)),
  skills: (t, offset, count) => predict_skill_rolls(req.origin.baseSeed, t.weaponType, t.attributeForce, req.origin.skillCounter + offset, 54, count),
});

test("the two Attack examples have equal +36 gains regardless of EX count", () => {
  const t = target("one");
  const a = bonusTotals([15, 15, 8, 8, 6], t);
  const b = bonusTotals([12, 12, 12, 12, 6], t);
  assert.equal(a.attack, 36);
  assert.deepEqual(a, b);
  assert.ok(statGoalMatches(a, { attack: 36 }));
  assert.equal(resultQuality(a, t, "bonus"), resultQuality(b, t, "bonus"));
});

test("stat minimums ignore unspecified stats and use separate units", () => {
  const gs = bonusTotals([11, 14, 16, 6, 10], target("gs", 0));
  assert.deepEqual(gs, { attack: 0, affinity: 10, element: 200, sharpness: 80, ammo: 0 });
  const gun = bonusTotals([8, 12, 16, 6, 10], target("gun", 12));
  assert.equal(gun.ammo, 3);
  assert.equal(gun.sharpness, 0);
  assert.ok(statGoalMatches(gun, { attack: 15 }));
  assert.ok(!statGoalMatches(gun, { attack: 15, affinity: 12 }));
  assert.equal(bonusTotals([11, 14, 15, 8, 6], target("status", 3, 6)).element, null);
});

test("preferred results also satisfy the acceptable route", () => {
  const t = target("one");
  t.planner.acceptable.stats = { affinity: 10 };
  assert.ok(matchesTier({ attack: 42, affinity: 0 }, t, "bonus", "acceptable"));
});

test("known bonuses enforce the actual tier caps, while stat aggregation is general", () => {
  assert.ok(validBonuses([15, 15, 12, 12, 6], target("one")));
  assert.ok(!validBonuses([12, 12, 12, 12, 6], target("one")));
  assert.deepEqual(layoutOf([15, 8, 9, 11, 6]), [0, 0, 1, 2, 3]);
});

test("scheduling avoids a greedy collision and minimizes the shared horizon", async () => {
  const result = await optimizeStream([
    { id: "a", choices: [{ finish: 1, action: "reset" }, { finish: 2, action: "reset" }] },
    { id: "b", choices: [{ finish: 1, action: "reset" }] },
  ], 10);
  assert.equal(result.horizon, 2);
  assert.ok(result.proven);
  assert.equal(result.choices.find((c) => c.id === "b").finish, 1);
});

test("acquisition events cannot collide with another weapon's finish", async () => {
  const result = await optimizeStream([
    { id: "a", choices: [{ finish: 3, action: "keep", acquisitions: [1, 2], layout: [0, 0, 0, 0, 3] }] },
    { id: "b", choices: [{ finish: 1, action: "reset" }] },
  ], 5);
  assert.equal(result.horizon, 3);
  assert.equal(result.choices.find((c) => c.id === "a").acquire, 2);
  const impossible = await optimizeStream([
    { id: "a", choices: [{ finish: 2, action: "keep", acquisitions: [1] }] },
    { id: "b", choices: [{ finish: 1, action: "reset" }] },
  ], 2);
  assert.equal(impossible.status, "missing");
});

test("bounded optimization reports uncertainty when its search budget is exhausted", async () => {
  const result = await optimizeStream([{ id: "a", choices: [{ finish: 2, action: "keep", acquisitions: [1] }] }], 2, true, { maxNodes: 0 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.proven, false);
});

test("known goals can require zero draws; zero is a valid roll limit", async () => {
  const t = target("one");
  t.planner.currentBonuses = [15, 15, 12, 12, 6];
  t.planner.currentSkill = 11 * 14 + 13;
  const req = request([t], 0, 0);
  const routes = await planWeapons(req, provider(req));
  assert.equal(routes.preferred.total, 0);
  assert.deepEqual(routes.preferred.steps, []);
  assert.deepEqual(routes.preferred.final, req.origin);
  assert.equal(routes.preferred.complete, true);
});

test("real WASM routes replay every intermediate draw and preserve separate counters", async () => {
  const a = target("same-weapon-a");
  const b = target("same-weapon-b");
  for (const t of [a, b]) {
    t.planner.acceptable.stats = { attack: 24 };
    t.planner.preferred.stats = { attack: 36 };
    t.planner.skillEnabled = false;
  }
  const req = request([a, b], 100, 0);
  const api = provider(req);
  const routes = await planWeapons(req, api);
  for (const route of Object.values(routes)) {
    assert.ok(route.complete);
    assert.ok(route.proven);
    assert.equal(route.final.skillCounter, req.origin.skillCounter);
    assert.equal(route.final.bonusCounter - req.origin.bonusCounter, route.total);
    const finished = new Set();
    const layouts = new Map();
    let offset = 0;
    for (const step of route.steps) {
      assert.ok(!finished.has(step.targetId), "a finished bonus is never overwritten");
      assert.equal(step.start, offset + 1);
      const t = req.targets.find((v) => v.id === step.targetId);
      for (const roll of step.rolls) {
        const raw = step.action === "keep" ? api.keep(t, offset, 1, layouts.get(t.id) ?? step.layout) : api.reset(t, offset, 1);
        assert.deepEqual(roll.raw, Array.from(raw));
        layouts.set(t.id, layoutOf(roll.raw));
        offset += 1;
      }
      if (step.intent === "finish") {
        finished.add(step.targetId);
        assert.ok(matchesTier(step.rolls.at(-1).totals, t, "bonus", route.mode));
      }
    }
    assert.equal(finished.size, 2);
    assert.equal(offset, route.bonus.horizon);
  }
  assert.ok(routes.acceptable.total <= routes.preferred.total);
});

test("status values and counter overflow are validated before searching", () => {
  const t = target("status", 3, 6);
  t.planner.acceptable.stats = { element: 100 };
  assert.throws(() => validatePlannerRequest(request([t])), /statusValues/);
  t.planner.elementValues = [30, 50];
  assert.doesNotThrow(() => validatePlannerRequest(request([t])));
  const req = request([t]); req.origin.bonusCounter = 0xffffffff;
  assert.throws(() => validatePlannerRequest(req), /state/);
});

test("stat maximums follow the two-copy and two-slot sharpness/ammo limits", () => {
  const blade = target("blade");
  assert.deepEqual(statRollValues("attack", blade), [["II", 6], ["III", 9], ["EX", 12]]);
  assert.equal(statMaximum("attack", blade), 48);
  assert.equal(bonusTotals([15, 15, 12, 12, 8], blade).attack, 48);
  assert.equal(statMaximum("affinity", blade), 42);
  assert.equal(statMaximum("sharpness", blade), 100);
  assert.equal(statMaximum("element", blade), 2 * 60 + 2 * 90);
  assert.equal(statMaximum("ammo", target("gun", 12, 0)), 4);
  const status = target("status", 3, 6);
  assert.equal(statMaximum("element", status), null);
  status.planner.elementValues = [30, 50];
  assert.equal(statMaximum("element", status), 160);
});

test("copied goals keep the new weapon's own rolls and drop element goals whose gains differ", () => {
  const source = target("source", 3, 1);
  source.planner = { ...source.planner, acceptable: { stats: { attack: 30, element: 150 }, skills: [{ seriesIndex: 2, groupIndex: 4 }] }, currentBonuses: [15, 15, 12, 12, 8], currentSkill: 17 };
  const water = copiedPlanner(source, target("water", 3, 2));
  assert.deepEqual(water.acceptable, source.planner.acceptable);
  assert.equal(water.currentBonuses, null); assert.equal(water.currentSkill, null);
  water.acceptable.stats.attack = 42;
  assert.equal(source.planner.acceptable.stats.attack, 30);
  assert.deepEqual(copiedPlanner(source, target("poison", 3, 6)).acceptable.stats, { attack: 30 });
  assert.deepEqual(copiedPlanner(source, target("raw", 3, 0)).acceptable.stats, { attack: 30 });
  assert.deepEqual(copiedPlanner(source, target("other type", 4, 1)).acceptable.stats, { attack: 30 });
  const poison = target("poison", 3, 6);
  poison.planner = { ...poison.planner, acceptable: { stats: { element: 40 }, skills: [] }, elementValues: [10, 20] };
  const otherPoison = copiedPlanner(poison, target("poison 2", 3, 6));
  assert.deepEqual(otherPoison.acceptable.stats, { element: 40 });
  assert.deepEqual(otherPoison.elementValues, [10, 20]);
  assert.deepEqual(copiedPlanner(poison, target("sleep", 3, 8)).elementValues, [null, null]);
});

test("all planner copy has Japanese and Traditional Chinese translations", async () => {
  const source = await readFile(new URL("./planner-text.js", import.meta.url), "utf8");
  const dictionary = vm.runInNewContext(source.slice(source.indexOf("export const PLANNER_TEXT =") + 7, source.indexOf("export function pl(")) + "\nPLANNER_TEXT;");
  const ui = await readFile(new URL("./planner-ui.js", import.meta.url), "utf8");
  for (const [, key] of ui.matchAll(/(?:html|pl)\("([^"\n]+)"/g)) assert.ok(dictionary[key], `Missing key: ${key}`);
  for (const [key, translations] of Object.entries(dictionary)) {
    assert.equal(translations.length, 2, key);
    for (const text of translations) {
      assert.ok(text.trim().length > 0, key);
      const placeholders = (s) => [...s.matchAll(/\{\w+\}/g)].map(([v]) => v).sort();
      assert.deepEqual(placeholders(text), placeholders(key), key);
    }
  }
});

test("the real three-weapon route uses Keep, preserves ordered layouts, and completes both streams", async () => {
  const targets = [target("long-sword"), target("switch-axe", 8, 5), target("bow", 11, 4)];
  const req = request(targets, 250, 1000);
  const routes = await planWeapons(req, provider(req));
  for (const route of Object.values(routes)) {
    assert.equal(route.complete, true);
    assert.equal(route.proven, true);
    const finalBonuses = new Map(); const finalSkills = new Map();
    for (const step of route.steps) {
      const map = step.stream === "bonus" ? finalBonuses : finalSkills;
      map.set(step.targetId, step.rolls.at(-1));
      const beforeCounter = step.before[`${step.stream}Counter`];
      assert.equal(step.after[`${step.stream}Counter`] - beforeCounter, step.rolls.length);
      const other = step.stream === "bonus" ? "skillCounter" : "bonusCounter";
      assert.equal(step.after[other], step.before[other]);
    }
    for (const t of targets) {
      assert.ok(matchesTier(finalBonuses.get(t.id).totals, t, "bonus", route.mode));
      assert.ok(matchesTier(finalSkills.get(t.id).raw, t, "skill", route.mode));
    }
  }
  assert.ok(routes.preferred.steps.some((step) => step.action === "keep"));
  assert.ok(routes.preferred.steps.some((step) => step.intent === "acquire"));
  assert.ok(routes.acceptable.total <= routes.preferred.total);
});

test("known layouts can start directly with Keep, without fabricating already-met stats", async () => {
  const t = target("known-layout");
  t.keepCategories = [0, 0, 0, 0, 3];
  t.planner.skillEnabled = false;
  const req = request([t], 30, 0);
  const routes = await planWeapons(req, provider(req));
  assert.ok(routes.acceptable.complete);
  assert.equal(routes.acceptable.steps[0].action, "keep");
  assert.ok(routes.acceptable.total > 0);
});

test("an unrelated layout edit invalidates progress; the verified saved result remains compatible", async () => {
  const t = target("one"); t.planner.skillEnabled = false;
  const req = request([t], 100, 0);
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.equal(routeWeaponsMatch(route, 0, [t]), true);
  const changed = structuredClone(t); changed.keepCategories = [0, 0, 0, 0, 3];
  assert.equal(routeWeaponsMatch(route, 0, [changed]), false);
  const raw = route.steps[0].rolls.at(-1).raw;
  changed.planner.currentBonuses = raw; changed.keepCategories = layoutOf(raw);
  assert.equal(routeWeaponsMatch(route, 1, [changed]), true);
});

test("zero minimums need no speculative roll, even when current tiers are unknown", async () => {
  const t = target("one"); t.planner.skillEnabled = false;
  t.planner.acceptable.stats = { attack: 0 }; t.planner.preferred.stats = {};
  const req = request([t], 0, 0);
  const routes = await planWeapons(req, provider(req));
  assert.equal(routes.acceptable.total, 0);
  assert.equal(routes.preferred.total, 0);
});

// Independent exhaustive action simulation checks the event reduction and
// minimum proof against every Reset/Keep/weapon choice in short real streams.
function bruteForceHorizon(req, api, mode) {
  let states = [{ layouts: req.targets.map((t) => validLayout(t.keepCategories, t) ? t.keepCategories : null), done: req.targets.map((t) => t.planner.currentBonuses ? matchesTier(bonusTotals(t.planner.currentBonuses, t), t, "bonus", mode) : false) }];
  for (let offset = 0; offset <= req.limits.bonus; offset += 1) {
    if (states.some((state) => state.done.every(Boolean))) return offset;
    if (offset === req.limits.bonus) break;
    const next = new Map();
    for (const state of states) for (let i = 0; i < req.targets.length; i += 1) {
      if (state.done[i]) continue;
      const t = req.targets[i];
      const draws = [api.reset(t, offset, 1)];
      if (state.layouts[i]) draws.push(api.keep(t, offset, 1, state.layouts[i]));
      for (const draw of draws) {
        const layouts = state.layouts.map((l) => l ? [...l] : null); const done = [...state.done];
        layouts[i] = layoutOf(Array.from(draw));
        done[i] = matchesTier(bonusTotals(draw, t), t, "bonus", mode);
        next.set(JSON.stringify([layouts, done]), { layouts, done });
      }
    }
    states = [...next.values()];
  }
  return null;
}

test("proven bonus minima agree with exhaustive action search on short WASM streams", async () => {
  for (const counter of [0, 80, 480, 1024]) {
    const targets = [target("a", 3, 1), target("b", 8, 5)];
    for (const t of targets) {
      t.planner.skillEnabled = false;
      t.planner.acceptable.stats = { attack: 12 };
      t.planner.preferred.stats = { attack: 21 };
    }
    targets[0].keepCategories = [0, 0, 1, 1, 3];
    const req = request(targets, 6, 0); req.origin.bonusCounter = counter;
    const api = provider(req);
    const routes = await planWeapons(req, api);
    for (const mode of ["acceptable", "preferred"]) {
      const brute = bruteForceHorizon(req, api, mode);
      assert.equal(routes[mode].bonus.horizon, brute, `${mode} at G${counter}`);
      assert.equal(routes[mode].bonus.proven, true);
    }
  }
});
