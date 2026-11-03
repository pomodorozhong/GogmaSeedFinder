import test from "node:test";
import assert from "node:assert/strict";
import { routeProgress } from "./planner-progress.js";

test("interleaved steps keep their route indices when either table advances first", () => {
  const steps = [
    { stream: "skill", targetId: "a" },
    { stream: "bonus", targetId: "a" },
    { stream: "bonus", targetId: "b" },
    { stream: "skill", targetId: "a" },
  ];
  const progress = routeProgress(steps, { bonus: 0, skill: 1 });
  assert.deepEqual(progress.tables.skill.map((row) => row.index), [0, 3]);
  assert.deepEqual(progress.rows.filter((row) => row.current).map((row) => row.index), [1, 3]);
  assert.deepEqual(progress.rows.filter((row) => row.saved).map((row) => row.index), [0]);
  assert.equal(progress.nextIndex(), 1);
  assert.equal(progress.nextIndex("skill"), 3);
  assert.equal(progress.finishedIn("skill", "a"), false);

  const skillsDone = routeProgress(steps, { bonus: 1, skill: 2 });
  assert.equal(skillsDone.finishedIn("skill", "a"), true);
  assert.equal(skillsDone.finishedIn("skill", "b"), false);
  assert.equal(skillsDone.finishedIn("bonus", "a"), true);
  assert.equal(skillsDone.nextIndex("skill"), 2);
  assert.equal(routeProgress(steps, { bonus: 2, skill: 2 }).nextIndex(), 3);
});
