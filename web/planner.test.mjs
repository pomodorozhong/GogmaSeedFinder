import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { initSync, predict_gogma_rolls, predict_gogma_keep_rolls, predict_skill_rolls } from "./pkg/gogma_wasm_search.js";
import { availableStats, BONUS_CATEGORY, bonusGoalAlwaysMet, bonusTotals, canFillSlots, copiedPlanner, layoutOf, MAX_SELECTED, rangeCanMatch, matchesTier, normalizedPlanner, normalizedProgress, routePosition, streamSteps, resultQuality, routeWeaponsMatch, skillGoalMatches, statGoalMatches, statMaximum, statRollValues, validBonuses, validLayout, validatePlannerRequest } from "./planner-model.js";
import { optimizeStream, planWeapons, selectTargets } from "./planner-engine.js";

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

test("large top-desired pools preserve an already-met acceptable goal", async () => {
  const t = target("already-acceptable");
  t.planner.skillEnabled = false;
  t.planner.acceptable.stats = { attack: 6 };
  t.planner.preferred.stats = { attack: 12 };
  t.planner.currentBonuses = [8, 9, 13, 6, 11];
  t.keepCategories = layoutOf(t.planner.currentBonuses);
  // This stream fills the 200,000-candidate pool, exceeding the number of
  // function arguments JavaScript accepts in a single spread into push.
  const req = request([t], 1000, 0);
  const routes = await planWeapons(req, provider(req));
  assert.ok(routes.acceptable.complete && routes.acceptable.proven);
  assert.equal(routes.acceptable.total, 0);
  assert.deepEqual(routes.acceptable.steps, []);
  assert.ok(routes.preferred.complete);
  assert.ok(routes.preferred.bonus.choices.every((c) => c.finish > 0));
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

test("zero status minimums impose no bound but positive bounds still need known gains", () => {
  assert.ok(statGoalMatches({ attack: 24, element: null }, { attack: 24, element: 0 }));
  assert.ok(!statGoalMatches({ element: null }, { element: 1 }));
  assert.ok(!statGoalMatches({ element: null }, { element: 0 }, { element: 0 }));
  const t = target("status", 3, 6);
  t.planner.skillEnabled = false;
  t.planner.acceptable = { stats: { element: 0 }, maxStats: {}, skills: [] };
  t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  assert.doesNotThrow(() => validatePlannerRequest(request([t])));
  t.planner.acceptable.stats.element = 1;
  assert.throws(() => validatePlannerRequest(request([t])), /statusValues/);
  t.planner.acceptable.stats.element = 0;
  t.planner.acceptable.maxStats.element = 1;
  assert.throws(() => validatePlannerRequest(request([t])), /statusValues/);
  t.planner.acceptable.maxStats.element = 0;
  assert.doesNotThrow(() => validatePlannerRequest(request([t])));
});

test("zero status minimums preserve zero-roll proofs without status boost values", async () => {
  for (const [layout, stats] of [
    [[0, 0, 0, 0, 3], { attack: 24, element: 0 }],
    [[2, 2, 0, 3, 3], { attack: 6, element: 0 }],
    [[null, null, null, null, null], { element: 0 }],
  ]) {
    const t = target("status", 3, 6); t.planner.skillEnabled = false;
    t.keepCategories = layout;
    t.planner.acceptable = { stats, maxStats: {}, skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
    const req = request([t], 0, 0);
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.ok(route.complete && route.proven);
      assert.equal(route.total, 0);
      assert.deepEqual(route.steps, []);
    }
  }
});

test("zero status minimums retain a better Keep path with unknown status gains", async () => {
  const t = target("status", 3, 6); t.planner.skillEnabled = false;
  t.keepCategories = [0, 0, 0, 2, 2];
  t.planner.acceptable = { stats: { attack: 24 }, maxStats: {}, skills: [] };
  t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  const req = request([t], 1, 0);
  // G1 Reset gives Attack +12; the known layout's Keep gives +27, with
  // unknown status gains. Adding minimum 0 must preserve this one-roll path.
  for (const withZero of [false, true]) {
    if (withZero) t.planner.acceptable.stats.element = 0;
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.ok(route.complete && route.proven);
      assert.equal(route.total, 1);
      assert.equal(route.steps[0].action, "keep");
      assert.equal(route.steps[0].rolls.at(-1).totals.element, null);
      assert.equal(route.steps[0].rolls.at(-1).totals.attack, 27);
    }
  }
});

test("Keep pruning preserves the shortest route when status EX gains are below II", async () => {
  for (const [knownLayout, limit] of [[false, 2], [false, 6], [true, 1]]) {
    const t = target("status", 3, 9);
    t.planner.skillEnabled = false;
    t.planner.elementValues = [20, 10];
    t.planner.acceptable = { stats: { affinity: 8, element: 10 }, maxStats: { element: 10 }, skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
    if (knownLayout) t.keepCategories = [1, 3, 1, 1, 2];
    const req = request([t], limit, 0);
    req.origin.baseSeed = 55_944_111;
    req.origin.bonusCounter = knownLayout ? 3660 : 3659;
    // Reset at G3660 acquires the layout; Keep at G3661 reaches Status +10.
    // Treating II +20 as a lower bound used to discard this two-roll route
    // and incorrectly prove the direct Reset at draw 5 was minimal.
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.ok(route.complete && route.proven);
      assert.equal(route.total, knownLayout ? 1 : 2);
      assert.equal(route.bonus.horizon, bruteForceHorizon(req, provider(req), route.mode));
      const finish = route.steps.at(-1);
      assert.equal(finish.action, "keep");
      assert.deepEqual(finish.rolls.at(-1).raw, [13, 6, 9, 9, 14]);
      assert.equal(finish.rolls.at(-1).totals.affinity, 20);
      assert.equal(finish.rolls.at(-1).totals.element, 10);
    }
  }
});

test("Keep pruning retains a known zero status gain when the other tier is unknown", async () => {
  const t = target("status", 3, 9);
  t.planner.skillEnabled = false;
  t.planner.elementValues = [null, 0];
  t.keepCategories = [1, 3, 1, 1, 2];
  t.planner.acceptable = { stats: { affinity: 20 }, maxStats: { element: 0 }, skills: [] };
  t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  const req = request([t], 1, 0);
  req.origin.baseSeed = 55_944_111;
  req.origin.bonusCounter = 3660;
  // The next Reset only has Affinity +10; Keep has +20 and the known EX +0.
  for (const route of Object.values(await planWeapons(req, provider(req)))) {
    assert.ok(route.complete && route.proven);
    assert.equal(route.total, 1);
    assert.equal(route.steps[0].action, "keep");
    assert.equal(route.steps[0].rolls.at(-1).totals.element, 0);
  }
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
  assert.deepEqual(water.acceptable, { ...source.planner.acceptable, maxStats: {} });
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

test("copying goals across weapon types preserves the destination's status gains", () => {
  const source = target("poison long sword", 3, 6);
  source.planner.elementValues = [10, 20];
  source.planner.acceptable = { stats: { attack: 30, element: 40 }, maxStats: {}, skills: [] };
  for (const values of [[30, 50], [null, null]]) {
    const destination = target("poison great sword", 0, 6);
    destination.planner.elementValues = values;
    const copied = copiedPlanner(source, destination);
    assert.deepEqual(copied.elementValues, values);
    assert.deepEqual(copied.acceptable.stats, { attack: 30 });
    assert.deepEqual(destination.planner.elementValues, values);
    assert.deepEqual(source.planner.elementValues, [10, 20]);
  }
});

test("up to MAX_SELECTED weapons can be planned together", () => {
  assert.equal(MAX_SELECTED, 100);
  const many = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => target(`w${i}`));
  assert.doesNotThrow(() => validatePlannerRequest(request(many.slice(0, MAX_SELECTED))));
  assert.throws(() => validatePlannerRequest(request(many)), /targets/);
});

test("weapons that cannot fit are left out, required before optional, earlier before later", async () => {
  const req = (optional = []) => ({ targets: ["a", "b", "c"].map((id) => ({ id, planner: { optional: optional.includes(id) } })), limits: { bonus: 10, skill: 10 } });
  const pool = (bonus, skill) => ({ bonus: Object.entries(bonus).map(([id, finishes]) => ({ id, choices: finishes.map((finish) => ({ finish, action: "reset" })) })), skill: Object.entries(skill).map(([id, finishes]) => ({ id, choices: finishes.map((finish) => ({ finish, action: "skill" })) })) });
  const ids = (selection) => [[...selection.kept].sort(), selection.dropped.map((v) => `${v.id}:${v.reason}`)];
  const clash = pool({ a: [1], b: [1], c: [2] }, { a: [1], b: [2], c: [3] });
  assert.deepEqual(ids(await selectTargets(req(), clash, ["a", "b", "c"])), [["a", "c"], ["b:conflict"]]);
  assert.deepEqual(ids(await selectTargets(req(), clash, ["b", "a", "c"])), [["b", "c"], ["a:conflict"]]);
  assert.deepEqual(ids(await selectTargets(req(["a"]), clash, ["a", "b", "c"])), [["b", "c"], ["a:conflict"]]);
  // A skill conflict also removes the weapon's bonus steps.
  assert.deepEqual(ids(await selectTargets(req(), pool({ a: [1], b: [2], c: [3] }, { a: [1], b: [1], c: [2] }), ["a", "b", "c"])), [["a", "c"], ["b:conflict"]]);
  const unreachable = pool({ a: [1], b: [], c: [] }, { a: [1], b: [2], c: [3] });
  assert.deepEqual(ids(await selectTargets(req(["b"]), unreachable, ["a", "b", "c"])), [["a", "c"], ["b:unreachable"]]);
});

test("a weapon is excluded only when it conflicts in a stream, not because of a weapon dropped in the other", async () => {
  const req = { targets: ["a", "b", "c"].map((id) => ({ id, planner: { optional: id !== "a" } })), limits: { bonus: 10, skill: 10 } };
  const choices = (finishes, action) => Object.entries(finishes).map(([id, finish]) => ({ id, choices: [{ finish, action }] }));
  // Bonus alone would drop C behind B; skill alone would drop B behind A.
  const pool = { bonus: choices({ a: 1, b: 2, c: 2 }, "reset"), skill: choices({ a: 1, b: 1, c: 2 }, "skill") };
  const selection = await selectTargets(req, pool, ["a", "b", "c"]);
  assert.deepEqual([...selection.kept].sort(), ["a", "c"]);
  assert.deepEqual(selection.dropped.map((v) => `${v.id}:${v.reason}`), ["b:conflict"]);
});

test("an unreachable required weapon stays selected when its other stream conflicts", async () => {
  for (const missingStream of ["bonus", "skill"]) for (const order of [["a", "b"], ["b", "a"]]) {
    const req = { targets: ["a", "b"].map((id) => ({ id, planner: { optional: false } })), limits: { bonus: 1, skill: 1 } };
    const pool = Object.fromEntries(["bonus", "skill"].map((stream) => [stream, req.targets.map(({ id }) => ({ id, choices: stream === missingStream && id === "b" ? [] : [{ finish: 1, action: stream === "bonus" ? "reset" : "skill" }] }))]));
    const selection = await selectTargets(req, pool, order);
    assert.ok(selection.kept.has("b"), `${missingStream}, ${order}`);
    assert.ok(!selection.dropped.some(({ id }) => id === "b"));
  }
});

test("real WASM cannot report completion after excluding an unreachable required goal", async () => {
  const a = target("a"); const b = target("b");
  a.planner.bonusEnabled = false;
  for (const t of [a, b]) {
    // Both need the only skill position, S1; B cannot reach Attack +48 in G1–2.
    t.planner.acceptable = { stats: { attack: 48 }, maxStats: {}, skills: [{ seriesIndex: 16, groupIndex: 4 }] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  }
  for (const targets of [[a, b], [b, a]]) {
    const req = request(targets, 2, 1);
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.equal(route.complete, false);
      assert.equal(route.total, null);
      assert.equal(route.bonus.status, "missing");
      assert.deepEqual(route.bonus.missing, ["b"]);
      assert.ok(!route.dropped.some(({ id }) => id === "b"));
    }
  }
  b.planner.optional = true;
  const req = request([a, b], 2, 1);
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.ok(route.complete && route.proven);
  assert.deepEqual(route.dropped, [{ id: "b", reason: "unreachable", optional: true }]);
});

test("optional weapons left out because the search budget ran out are marked unchecked, not conflicting", async () => {
  const req = { targets: ["a", "b", "c"].map((id) => ({ id, planner: { optional: id !== "a" } })), limits: { bonus: 10, skill: 10 } };
  // Keep finishes with acquisitions force the budgeted search.
  const keep = (finish, acquire) => ({ finish, action: "keep", layout: [0, 0, 0, 0, 0], acquisitions: [acquire] });
  const pool = { bonus: [{ id: "a", choices: [keep(2, 1)] }, { id: "b", choices: [keep(4, 3)] }, { id: "c", choices: [keep(6, 5)] }], skill: ["a", "b", "c"].map((id) => ({ id, choices: [{ finish: 0, action: "already" }] })) };
  const selection = await selectTargets(req, pool, ["a", "b", "c"], { maxNodes: 0 });
  assert.ok(selection.exhausted);
  assert.deepEqual([...selection.kept], ["a"]);
  assert.deepEqual(selection.dropped.map((v) => `${v.id}:${v.reason}`), ["b:unchecked", "c:unchecked"]);
});

test("truncated bonus candidates do not prove a conflict or permit dropping a required goal", async () => {
  const weapons = [target("required"), target("other")];
  for (const t of weapons) {
    t.planner.skillEnabled = false;
    t.keepCategories = [0, 0, 0, 3, 3];
    t.planner.acceptable = { stats: { attack: 24 }, maxStats: {}, skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  }
  const req = request(weapons, 4, 0); req.origin.baseSeed = 7;
  // Both can Keep at G2/G3. A cap of one retains only their direct G4
  // finish, so its collision cannot prove the full problem infeasible.
  for (const optional of [true, false]) {
    weapons[1].planner.optional = optional;
    const limited = await planWeapons(req, provider(req), () => {}, { candidateCap: 1 });
    for (const route of Object.values(limited)) {
      assert.equal(route.proven, false);
      if (optional) {
        assert.ok(route.complete);
        assert.equal(route.total, 4);
        assert.deepEqual(route.dropped, [{ id: "other", reason: "unchecked", optional: true }]);
      } else {
        assert.equal(route.complete, false);
        assert.equal(route.bonus.status, "incomplete");
        assert.deepEqual(route.dropped, []);
      }
    }
  }
  for (const route of Object.values(await planWeapons(req, provider(req)))) {
    assert.ok(route.complete && route.proven);
    assert.equal(route.total, 3);
    assert.deepEqual(route.dropped, []);
  }
});

test("truncated bonus candidates do not prove an empty optional goal unreachable", async () => {
  const req = { targets: ["a", "b"].map((id) => ({ id, planner: { optional: id === "b" } })), limits: { bonus: 1, skill: 0 } };
  const pool = {
    complete: false,
    bonus: [{ id: "a", choices: [{ finish: 1, action: "reset" }] }, { id: "b", choices: [] }],
    skill: ["a", "b"].map((id) => ({ id, choices: [{ finish: 0, action: "already" }] })),
  };
  const selection = await selectTargets(req, pool, ["a", "b"]);
  assert.deepEqual([...selection.kept], ["a"]);
  assert.deepEqual(selection.dropped, [{ id: "b", reason: "unchecked", optional: true }]);
  assert.ok(selection.exhausted);
});

test("a complete skill stream proves conflicts despite truncated bonus candidates", async () => {
  const req = { targets: ["a", "b"].map((id) => ({ id, planner: { optional: id === "b" } })), limits: { bonus: 1, skill: 1 } };
  const pool = {
    complete: false,
    ...Object.fromEntries(["bonus", "skill"].map((stream) => [stream, ["a", "b"].map((id) => ({ id, choices: [{ finish: 1, action: stream === "bonus" ? "reset" : "skill" }] }))])),
  };
  const selection = await selectTargets(req, pool, ["a", "b"]);
  assert.deepEqual([...selection.kept], ["a"]);
  assert.deepEqual(selection.dropped, [{ id: "b", reason: "conflict", optional: true }]);
  assert.equal(selection.exhausted, false);
});

test("competing weapons produce a route for each choice of which one to finish", async () => {
  const origin = { baseSeed: 86_315_169, bonusCounter: 480, skillCounter: 188 };
  const rolls = predict_skill_rolls(origin.baseSeed, 3, 1, origin.skillCounter, 54, 40);
  const once = [...rolls].find((v) => rolls.filter((w) => w === v).length === 1);
  const weapons = ["first", "second"].map((id) => {
    const t = target(id);
    t.planner.bonusEnabled = false;
    t.planner.acceptable.skills = [{ seriesIndex: Math.floor(once / 14), groupIndex: once % 14 }];
    t.planner.preferred.skills = [];
    return t;
  });
  const req = { origin, targets: weapons, limits: { bonus: 0, skill: 40 } };
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.ok(route.complete);
  assert.deepEqual(route.dropped.map((v) => v.id), ["second"]);
  assert.equal(route.alternatives.length, 1);
  assert.deepEqual(route.alternatives[0].dropped.map((v) => v.id), ["first"]);
  assert.ok(route.alternatives[0].steps.every((step) => step.targetId === "second"));
});

test("Any in a skill pair accepts one skill on its own", () => {
  const ebonyLord = 5 * 14 + 13;
  const otherLord = 18 * 14 + 13;
  const ebonyOther = 5 * 14 + 2;
  assert.ok(skillGoalMatches(otherLord, [{ seriesIndex: null, groupIndex: 13 }]));
  assert.ok(!skillGoalMatches(ebonyOther, [{ seriesIndex: null, groupIndex: 13 }]));
  assert.ok(skillGoalMatches(ebonyOther, [{ seriesIndex: 5, groupIndex: null }]));
  assert.ok(!skillGoalMatches(otherLord, [{ seriesIndex: 5, groupIndex: 13 }]));
  const t = target("horn", 5, 1);
  t.planner = normalizedPlanner({ ...t, planner: { acceptable: { skills: [{ seriesIndex: null, groupIndex: 13 }, { seriesIndex: 5, groupIndex: null }, { seriesIndex: 21, groupIndex: 0 }] }, preferred: { skills: [{ seriesIndex: 5, groupIndex: 13 }] } } });
  assert.deepEqual(t.planner.acceptable.skills, [{ seriesIndex: null, groupIndex: 13 }, { seriesIndex: 5, groupIndex: null }]);
  assert.equal(resultQuality(ebonyLord, t, "skill"), "preferred");
  assert.equal(resultQuality(otherLord, t, "skill"), "acceptable");
  assert.equal(resultQuality(ebonyOther, t, "skill"), "acceptable");
  assert.equal(resultQuality(18 * 14 + 2, t, "skill"), "none");
});

test("an Any skill pair finishes no later than the exact pair it contains", async () => {
  const plan = async (pair) => {
    const t = target("horn", 5, 1);
    t.planner.bonusEnabled = false;
    t.planner.acceptable.skills = [pair];
    t.planner.preferred.skills = [];
    const req = request([t], 0, 1000);
    return (await planWeapons(req, provider(req))).acceptable;
  };
  const exact = await plan({ seriesIndex: 5, groupIndex: 13 });
  const any = await plan({ seriesIndex: null, groupIndex: 13 });
  assert.ok(any.complete);
  assert.ok(!exact.complete || any.total <= exact.total);
  assert.equal(any.steps.at(-1).rolls.at(-1).raw % 14, 13);
});

test("unrestricted skill goals need zero rolls even when current skills are unknown", async () => {
  const goals = [
    [{ seriesIndex: null, groupIndex: null }],
    Array.from({ length: 14 }, (_, groupIndex) => ({ seriesIndex: null, groupIndex })),
    Array.from({ length: 21 }, (_, seriesIndex) => ({ seriesIndex, groupIndex: null })),
  ];
  for (const skills of goals) for (const limit of [0, 5]) {
    const t = target("any"); t.planner.bonusEnabled = false;
    t.planner.acceptable.skills = skills; t.planner.preferred.skills = [];
    const req = request([t], 0, limit);
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.ok(route.complete && route.proven);
      assert.equal(route.total, 0);
      assert.deepEqual(route.steps, []);
      assert.deepEqual(route.final, req.origin);
    }
  }
});

test("an already-guaranteed skill goal still takes a free top-desired upgrade", async () => {
  const a = target("any"); const b = target("later");
  const req = request([a, b], 0, 2);
  const rolls = provider(req).skills(a, 0, 2);
  assert.notEqual(rolls[0], rolls[1]);
  const pair = (value) => ({ seriesIndex: Math.floor(value / 14), groupIndex: value % 14 });
  for (const t of [a, b]) t.planner.bonusEnabled = false;
  a.planner.acceptable.skills = [{ seriesIndex: null, groupIndex: null }];
  a.planner.preferred.skills = [pair(rolls[0])];
  b.planner.acceptable.skills = [pair(rolls[1])]; b.planner.preferred.skills = [];
  const alone = request([a], 0, 0);
  const zero = (await planWeapons(alone, provider(alone))).acceptable;
  assert.ok(zero.complete && zero.proven);
  assert.equal(zero.total, 0);
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.equal(route.total, 2);
  assert.ok(route.skill.choices.every((choice) => choice.top));
  assert.deepEqual(route.skill.choices.map(({ id, finish }) => [id, finish]).sort(), [["any", 1], ["later", 2]]);
});

test("stat goals are min/max ranges; blank sides are unbounded and max 0 excludes a stat", () => {
  const t = target("range");
  t.planner = normalizedPlanner({ ...t, planner: { acceptable: { stats: { attack: 30 }, maxStats: { sharpness: 30 } }, preferred: { stats: { attack: 36 }, maxStats: { sharpness: 0, ammo: 0 } } } });
  assert.deepEqual(t.planner.preferred.maxStats, { sharpness: 0 });
  const oneSharpI = bonusTotals([15, 15, 12, 12, 6], t);
  const oneSharpEx = bonusTotals([15, 15, 12, 12, 10], t);
  const noSharp = bonusTotals([15, 15, 12, 12, 9], t);
  assert.equal(resultQuality(noSharp, t, "bonus"), "preferred");
  assert.equal(resultQuality(oneSharpI, t, "bonus"), "acceptable");
  assert.equal(resultQuality(oneSharpEx, t, "bonus"), "none");
  // A max alone is a goal; an unknown status value proves neither bound.
  const status = target("status", 3, 6);
  status.planner = normalizedPlanner({ ...status, planner: { acceptable: { stats: {}, maxStats: { element: 0 } }, preferred: { stats: {} } } });
  assert.doesNotThrow(() => validatePlannerRequest(request([status])));
  assert.equal(resultQuality(bonusTotals([15, 15, 12, 12, 11], status), status, "bonus"), "none");
  assert.equal(resultQuality(bonusTotals([15, 15, 12, 12, 8], status), status, "bonus"), "preferred");
  status.planner.acceptable.maxStats = { element: 40 };
  assert.throws(() => validatePlannerRequest(request([status])), /statusValues/);
});

test("older saves with excluded stats load as max 0 in both tiers", () => {
  const t = target("legacy");
  const p = normalizedPlanner({ ...t, planner: { acceptable: { stats: { attack: 30, sharpness: 50 } }, preferred: { stats: { attack: 36 } }, excluded: ["sharpness", "ammo"] } });
  assert.deepEqual(p.acceptable, { stats: { attack: 30 }, maxStats: { sharpness: 0 }, skills: t.planner.acceptable.skills });
  assert.deepEqual(p.preferred.maxStats, { sharpness: 0 });
});

test("range goals are validated: min not above max, and max-0 stats leave slots to fill", () => {
  const t = target("bad");
  t.planner.acceptable.stats = { attack: 30 };
  t.planner.acceptable.maxStats = { attack: 20 };
  assert.throws(() => validatePlannerRequest(request([t])), /minAboveMax/);
  const gun = target("gun", 12, 0);
  assert.ok(canFillSlots(gun, ["affinity"]));
  assert.ok(!canFillSlots(gun, ["attack", "affinity"]));
  gun.planner.acceptable.stats = {};
  gun.planner.acceptable.maxStats = { attack: 0, affinity: 0 };
  assert.throws(() => validatePlannerRequest(request([gun])), /excluded/);
});

test("Keep layouts are pruned only when no tier choice could fit the range", () => {
  const t = target("prune");
  t.planner.acceptable = { stats: { attack: 24 }, maxStats: { sharpness: 30 }, skills: [] };
  t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  // One sharpness slot ranges 30–50, so Sharpness I can still meet max 30.
  const layout = [0, 0, 0, 1, 3];
  const low = bonusTotals(layout.map((c) => [8, 9, 11, 6][c]), t);
  const high = bonusTotals(layout.map((c) => [15, 16, 14, 10][c]), t);
  assert.ok(rangeCanMatch(low, high, t, "acceptable"));
  const twoSharp = [0, 0, 0, 3, 3];
  assert.ok(!rangeCanMatch(bonusTotals(twoSharp.map((c) => [8, 9, 11, 6][c]), t), bonusTotals(twoSharp.map((c) => [15, 16, 14, 10][c]), t), t, "acceptable"));
});

test("routes respect maximums, and an unknown weapon is not assumed to be under one", async () => {
  const t = target("capped");
  t.planner.skillEnabled = false;
  t.planner.acceptable.stats = { attack: 24 };
  t.planner.acceptable.maxStats = { sharpness: 30 };
  t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  const req = request([t], 300, 0);
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.ok(route.complete);
  assert.ok(route.steps.length > 0);
  const finish = route.steps.at(-1).rolls.at(-1);
  assert.ok(finish.totals.sharpness <= 30);
  assert.ok(finish.totals.attack >= 24);
});

test("the acceptable route takes top-desired finishes only when they cost no extra rolls", async () => {
  const direct = (finish, top = false) => ({ finish, action: "reset", top });
  const finishOf = (result, id) => result.choices.find((c) => c.id === id);
  // A top finish at 2 fits inside B's horizon of 3: free upgrade.
  let result = await optimizeStream([{ id: "a", choices: [direct(1), direct(2, true)] }, { id: "b", choices: [direct(3)] }], 10);
  assert.equal(result.horizon, 3);
  assert.deepEqual(finishOf(result, "a"), { id: "a", finish: 2, action: "reset", top: true });
  // The only top finish collides with B: no upgrade.
  result = await optimizeStream([{ id: "a", choices: [direct(1), direct(3, true)] }, { id: "b", choices: [direct(3)] }], 10);
  assert.equal(finishOf(result, "a").finish, 1);
  // A later top finish would lengthen the route: no upgrade.
  result = await optimizeStream([{ id: "a", choices: [direct(1), direct(5, true)] }, { id: "b", choices: [direct(3)] }], 10);
  assert.equal(result.horizon, 3);
  assert.equal(finishOf(result, "a").finish, 1);
});

test("a later upgrade cannot take an earlier weapon's top-desired finish", async () => {
  const direct = (finish, top = false) => ({ finish, action: "reset", top });
  const result = await optimizeStream([
    { id: "a", choices: [direct(1), direct(2, true)] },
    { id: "b", choices: [direct(2), direct(3, true)] },
    { id: "c", choices: [direct(1), direct(3, true)] },
  ], 10);
  assert.equal(result.horizon, 3);
  assert.deepEqual(Object.fromEntries(result.choices.map((c) => [c.id, c.finish])), { a: 2, b: 3, c: 1 });
});

test("real WASM: a free Keep upgrade to top desired is taken without lengthening the acceptable route", async () => {
  // Reported case: Ice HH could stop acceptable at G26, but Thunder HH needs
  // G46 anyway, so Ice can Keep through G27–35 to a top-desired result.
  const horn = (id, attributeForce) => {
    const t = target(id, 5, attributeForce);
    t.planner.skillEnabled = false;
    t.planner.acceptable = { stats: { attack: 36 }, maxStats: { affinity: 0 }, skills: [] };
    t.planner.preferred = { stats: { attack: 42 }, maxStats: { affinity: 0 }, skills: [] };
    return t;
  };
  const req = { origin: { baseSeed: 67_723_575, bonusCounter: 87, skillCounter: 77 }, targets: [horn("ice", 3), horn("thunder", 4)], limits: { bonus: 60, skill: 0 } };
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.equal(route.bonus.horizon, 46);
  assert.ok(route.proven);
  const finish = (id) => route.steps.find((s) => s.targetId === id && s.intent === "finish");
  assert.deepEqual([finish("ice").action, finish("ice").end, finish("ice").rolls.at(-1).quality], ["keep", 35, "preferred"]);
  assert.deepEqual([finish("thunder").end, finish("thunder").rolls.at(-1).quality], [46, "preferred"]);
});

test("bonus and skill progress are independent, so skill steps can be saved first", async () => {
  const t = target("both");
  const req = request([t], 300, 1000);
  const route = (await planWeapons(req, provider(req))).acceptable;
  const bonus = streamSteps(route, "bonus");
  const skill = streamSteps(route, "skill");
  assert.ok(bonus.length > 0 && skill.length > 0);
  // Skills first: only the skill counter moves; the bonus counter stays at the origin.
  assert.deepEqual(routePosition(route, { bonus: 0, skill: 1 }), { ...req.origin, skillCounter: skill[0].after.skillCounter });
  assert.deepEqual(routePosition(route, { bonus: bonus.length, skill: 0 }), { ...req.origin, bonusCounter: bonus.at(-1).after.bonusCounter });
  const saved = structuredClone(t);
  saved.planner.currentSkill = skill[0].rolls.at(-1).raw;
  assert.equal(routeWeaponsMatch(route, { bonus: 0, skill: 1 }, [saved]), skill[0].targetId === t.id);
  // An older single count covered bonus steps first.
  assert.deepEqual(normalizedProgress(route, bonus.length + 1), { bonus: bonus.length, skill: 1 });
  assert.deepEqual(normalizedProgress(route, { bonus: 99, skill: -1 }), { bonus: bonus.length, skill: 0 });
});

test("regression fixture: a reported seven-weapon session keeps its free top-desired upgrade", async () => {
  const { request: req, expected } = JSON.parse(await readFile(new URL("../tests/fixtures/planner_free_upgrade_2026-10-26.json", import.meta.url), "utf8"));
  const routes = await planWeapons(req, provider(req));
  for (const mode of ["acceptable", "preferred"]) {
    const route = routes[mode];
    assert.deepEqual([route.total, route.bonus.horizon, route.skill.horizon, route.proven], [expected[mode].total, expected[mode].bonusHorizon, expected[mode].skillHorizon, expected[mode].proven], mode);
  }
  const finishes = routes.acceptable.steps.filter((s) => s.intent === "finish");
  assert.equal(finishes.length, expected.acceptable.finishes);
  assert.equal(finishes.filter((s) => s.rolls.at(-1).quality === "preferred").length, expected.acceptable.topDesiredFinishes);
  for (const step of expected.freeUpgrade) {
    const actual = finishes.find((s) => s.targetId === step.target && s.stream === "bonus");
    assert.deepEqual({ target: actual.targetId, action: actual.action, start: actual.start, end: actual.end, quality: actual.rolls.at(-1).quality }, step);
  }
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

test("a top-desired maximum does not hide the acceptable tier's zero-roll finish", async () => {
  const t = target("one"); t.planner.skillEnabled = false;
  t.planner.acceptable.stats = { attack: 0 };
  t.planner.preferred.stats = { attack: 42 }; t.planner.preferred.maxStats = { affinity: 0 };
  for (const limit of [0, 5]) {
    const req = request([t], limit, 0);
    const route = (await planWeapons(req, provider(req))).acceptable;
    assert.ok(route.complete && route.proven);
    assert.equal(route.total, 0);
  }
});

test("physical maximums need zero rolls even when current bonuses are unknown", async () => {
  for (const [weaponType, attributeForce] of [[3, 1], [11, 4], [12, 0], [3, 6]]) for (const limit of [0, 5]) {
    const t = target("maximums", weaponType, attributeForce); t.planner.skillEnabled = false;
    t.planner.elementValues = [20, 35];
    t.planner.acceptable = { stats: {}, maxStats: Object.fromEntries(availableStats(t).map((key) => [key, statMaximum(key, t)])), skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
    const req = request([t], limit, 0);
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.ok(route.complete && route.proven);
      assert.equal(route.total, 0);
      assert.deepEqual(route.steps, []);
      assert.deepEqual(route.final, req.origin);
    }
  }
});

test("known categories prove already-met ranges without inventing their current tiers", async () => {
  const cases = [
    { weaponType: 3, attributeForce: 1, layout: [0, 0, 0, 0, 3], stats: { attack: 24 }, maxStats: { affinity: 0 } },
    { weaponType: 3, attributeForce: 1, layout: [0, 0, 0, 0, 3], stats: { attack: 30 }, maxStats: { attack: 42, affinity: 0 } },
    { weaponType: 3, attributeForce: 6, layout: [0, 0, 0, 0, 3], stats: { attack: 24 }, maxStats: { element: 0 } },
    { weaponType: 3, attributeForce: 6, layout: [2, 2, 0, 3, 3], stats: { attack: 6, sharpness: 60 }, maxStats: { affinity: 0, sharpness: 100 } },
    { weaponType: 12, attributeForce: 0, layout: [3, 0, 3, 1, 1], stats: { ammo: 2, affinity: 12 }, maxStats: { ammo: 4, affinity: 20 } },
    { weaponType: 3, attributeForce: 1, layout: [2, 2, 2, 2, 0], stats: { element: 300 }, maxStats: { element: 300 } },
  ];
  for (const c of cases) for (const limit of [0, 5]) {
    const t = target("categories", c.weaponType, c.attributeForce); t.planner.skillEnabled = false;
    t.keepCategories = c.layout;
    t.planner.acceptable = { stats: c.stats, maxStats: c.maxStats, skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
    const req = request([t], limit, 0);
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.ok(route.complete && route.proven, JSON.stringify(c));
      assert.equal(route.total, 0);
      assert.deepEqual(route.steps, []);
      assert.deepEqual(route.final, req.origin);
      assert.equal(route.targets[0].planner.currentBonuses, null);
    }
  }
});

test("partially known categories preserve the proven zero-roll minimum", async () => {
  const cases = [
    { layout: [0, null, null, null, null], stats: { attack: 6 }, maxStats: {} },
    { layout: [null, 1, null, 1, null], stats: { affinity: 12 }, maxStats: { attack: 33 } },
    { layout: [0, 0, null, 0, 0], stats: { attack: 30 }, maxStats: {} },
  ];
  for (const c of cases) for (const limit of [0, 1]) {
    const t = target("partial"); t.planner.skillEnabled = false;
    t.keepCategories = c.layout;
    t.planner.acceptable = { stats: c.stats, maxStats: c.maxStats, skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
    const req = request([t], limit, 0);
    for (const route of Object.values(await planWeapons(req, provider(req)))) {
      assert.equal(route.bonus.horizon, bruteForceHorizon(req, provider(req), route.mode));
      assert.ok(route.complete && route.proven);
      assert.equal(route.total, 0);
      assert.deepEqual(route.steps, []);
    }
  }
});

test("partial layouts do not prove uncertain goals or invent a Keep action", async () => {
  const t = target("partial"); t.planner.skillEnabled = false;
  t.keepCategories = [0, null, null, null, null];
  t.planner.acceptable = { stats: { attack: 7 }, maxStats: {}, skills: [] };
  t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
  assert.equal(bonusGoalAlwaysMet(t, "acceptable"), false);
  const req = request([t], 1, 0);
  for (const route of Object.values(await planWeapons(req, provider(req)))) {
    assert.equal(route.bonus.horizon, bruteForceHorizon(req, provider(req), route.mode));
    assert.ok(route.steps.every((step) => step.action !== "keep"));
  }
  t.keepCategories = [3, 3, 3, null, null];
  assert.equal(bonusGoalAlwaysMet(t, "acceptable"), false, "an impossible partial layout cannot prove a goal vacuously");
});

test("zero-roll proofs cover alternative bonus tiers and reject any attainable gap", async () => {
  const t = target("alternatives"); t.planner.skillEnabled = false;
  t.planner.acceptable = { stats: { attack: 27 }, maxStats: {}, skills: [] };
  t.planner.preferred = { stats: {}, maxStats: { attack: 24 }, skills: [] };
  assert.ok(bonusGoalAlwaysMet(t, "acceptable"));
  assert.ok(!bonusGoalAlwaysMet(t, "preferred"));
  const req = request([t], 0, 0);
  const route = (await planWeapons(req, provider(req))).acceptable;
  assert.ok(route.complete && route.proven);
  assert.equal(route.total, 0);
  t.planner.preferred.maxStats.attack = 21;
  assert.ok(!bonusGoalAlwaysMet(t, "acceptable"), "Attack +24 is possible and matches neither tier");
});

test("uncertain bonus ranges still require a draw", async () => {
  for (const [layout, stats, maxStats] of [
    [[null, null, null, null, null], {}, { attack: 47 }],
    [[0, 0, 0, 0, 3], { attack: 31 }, {}],
    [[0, 0, 0, 0, 3], {}, { attack: 41 }],
    [[2, 2, 0, 3, 3], {}, { element: 0 }],
  ]) {
    const t = target("uncertain"); t.planner.skillEnabled = false;
    t.keepCategories = layout;
    t.planner.acceptable = { stats, maxStats, skills: [] };
    t.planner.preferred = { stats: {}, maxStats: {}, skills: [] };
    const req = request([t], 0, 0);
    const route = (await planWeapons(req, provider(req))).acceptable;
    assert.equal(route.complete, false);
    assert.equal(route.bonus.status, "missing");
  }
});

// Independent exhaustive action simulation checks the event reduction and
// minimum proof against every Reset/Keep/weapon choice in short real streams.
// Test unknown initial tiers separately by trying every ordered five-slot
// result and applying the existing validity rules, not the planner's proof.
function currentBonusGoalGuaranteed(t, mode) {
  if (t.planner.currentBonuses) return matchesTier(bonusTotals(t.planner.currentBonuses, t), t, "bonus", mode);
  const ids = Object.keys(BONUS_CATEGORY).map(Number);
  const choices = Array.from({ length: 5 }, (_, i) => ids.filter((id) => t.keepCategories?.[i] == null || BONUS_CATEGORY[id] === t.keepCategories[i]));
  let possible = false;
  function allMatch(draw) {
    if (draw.length === 5) {
      if (!validBonuses(draw, t)) return true;
      possible = true;
      return matchesTier(bonusTotals(draw, t), t, "bonus", mode);
    }
    return choices[draw.length].every((id) => allMatch([...draw, id]));
  }
  return allMatch([]) && possible;
}

function bruteForceHorizon(req, api, mode) {
  let states = [{ layouts: req.targets.map((t) => t.planner.currentBonuses ? layoutOf(t.planner.currentBonuses) : validLayout(t.keepCategories, t) ? t.keepCategories : null), done: req.targets.map((t) => currentBonusGoalGuaranteed(t, mode)) }];
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
