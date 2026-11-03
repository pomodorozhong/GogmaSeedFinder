import assert from "node:assert/strict";
import test from "node:test";
import { createPosition, readImportedPosition, readSavedPosition, withStreamCounter } from "./save-position.js";

test("a legacy save recovers numeric strings, zero and sources independently", () => {
  assert.deepEqual(readSavedPosition({
    baseSeed: "99999999", bonusCounter: 0x100000000, skillCounter: "0",
    bonusSource: "検索結果", skillSource: 7,
  }), {
    baseSeed: 99_999_999, bonusCounter: null, skillCounter: 0,
    baseSource: null, bonusSource: "検索結果", skillSource: null,
  });
  assert.deepEqual(readSavedPosition(), createPosition(null, null, null, null));
});

test("an imported position accepts unknown counters and rejects a partially invalid save", () => {
  assert.deepEqual(readImportedPosition({ baseSeed: "0", skillCounter: "4294967295" }, "状態コード"),
    createPosition(0, null, 0xffffffff, "状態コード"));
  assert.equal(readImportedPosition({ baseSeed: 0, bonusCounter: -1, skillCounter: 5 }, "状態コード"), null);
  assert.equal(readImportedPosition({ baseSeed: null, bonusCounter: 0 }, "状態コード"), null);
});

test("updating one stream preserves the other until a new seed or fresh search", () => {
  const previous = createPosition(12, 7, 15, "手入力");
  const skill = withStreamCounter(previous, "skill", 12, 16, "予測結果");
  assert.deepEqual(skill, { ...previous, skillCounter: 16, skillSource: "予測結果", baseSource: "予測結果" });
  assert.deepEqual(withStreamCounter(skill, "bonus", 12, 8, "予測結果"),
    { ...skill, bonusCounter: 8, bonusSource: "予測結果" });
  assert.deepEqual(withStreamCounter(skill, "skill", 99, 0, "手入力"), createPosition(99, null, 0, "手入力"));
  assert.deepEqual(withStreamCounter(skill, "bonus", 12, 0, "検索結果", true), createPosition(12, 0, null, "検索結果"));
});
