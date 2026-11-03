import assert from "node:assert/strict";
import test from "node:test";
import { restoreProfiles } from "./weapon-profiles.js";

test("legacy saves keep duplicate weapons, their own Keep slots, and explicitly empty skill picks", () => {
  const weapon = { weaponType: 1, attributeForce: 2 };
  const [first, second] = restoreProfiles([
    null,
    { ...weapon, keepCategories: [0, 1, null, 5, 3] },
    { ...weapon, id: "second", skillCombinations: [] },
  ], { weapons: 14, attributes: 10, series: 21, groups: 14 });
  assert.equal(first.id, "legacy-0");
  assert.deepEqual(first.keepCategories, [0, 1, null, null, 3]);
  assert.deepEqual(first.skillCombinations, [{ seriesIndex: 11, groupIndex: 13 }, { seriesIndex: 18, groupIndex: 13 }]);
  assert.equal(second.id, "second");
  assert.deepEqual(second.keepCategories, Array(5).fill(null));
  assert.deepEqual(second.skillCombinations, []);
});
