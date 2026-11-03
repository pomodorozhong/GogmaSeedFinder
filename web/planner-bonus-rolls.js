import { bonusTotals, layoutOf, validLayout } from "./planner-model.js";

// Loose bounds for a Keep layout. A status weapon can have EX below II, or
// only one known tier, so compare the finite endpoints independently per stat.
function layoutBounds(layout, target) {
  const high = bonusTotals(layout.map((category) => [15, 16, 14, 10][category]), target);
  const low = bonusTotals(layout.map((category) => [8, 9, 11, 6][category]), target);
  for (const stat of Object.keys(low)) {
    const ends = [low[stat], high[stat]].filter(Number.isFinite);
    low[stat] = ends.length ? Math.min(...ends) : null;
    high[stat] = ends.length ? Math.max(...ends) : null;
  }
  return { low, high };
}

// Visit each eligible Reset, then each reachable Keep in layout discovery
// order. A known layout needs no acquisition. For the others, the scheduler
// can choose any Reset position before the finish, even one before `from`.
export async function visitBonusRolls(target, count, resetRolls, provider, {
  from = 1, onReset, onKeep, directOnly = false, canKeep, batchSize, onBatch,
}) {
  const layouts = new Map();
  const initial = target.planner.currentBonuses ? layoutOf(target.planner.currentBonuses) : target.keepCategories;
  if (validLayout(initial, target)) layouts.set(initial.join(""), { layout: initial, acquisitions: null });
  for (let index = 0; index < count; index += 1) {
    const raw = Array.from(resetRolls.subarray(index * 5, index * 5 + 5));
    const finish = index + 1;
    if (finish >= from) onReset?.(finish, raw);
    if (!onKeep) continue;
    const layout = layoutOf(raw);
    const key = layout.join("");
    if (!layouts.has(key)) layouts.set(key, { layout, acquisitions: [] });
    layouts.get(key).acquisitions?.push(finish);
  }
  if (!onKeep) return;

  let scanned = 0;
  for (const { layout, acquisitions } of layouts.values()) {
    if (directOnly && acquisitions) continue;
    const { low, high } = layoutBounds(layout, target);
    if (!canKeep(low, high)) continue;
    const rolls = provider.keep(target, 0, count, layout);
    const first = Math.max(from, (acquisitions?.[0] ?? 0) + 1);
    for (let index = first - 1; index < count; index += 1) {
      onKeep(index + 1, rolls.subarray(index * 5, index * 5 + 5), layout, acquisitions);
    }
    if (++scanned % batchSize === 0) await onBatch(scanned, layouts.size);
  }
}
