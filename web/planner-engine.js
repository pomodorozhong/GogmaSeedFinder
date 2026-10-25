import { bonusTotals, hasGoal, layoutOf, matchesTier, resultQuality, validLayout, validatePlannerRequest } from "./planner-model.js";

const MODES = ["acceptable", "preferred"];
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const layoutKey = (layout) => layout.join("");
const before = (positions, end) => {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < end) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// Every useful bonus history can be reduced to its final Reset, followed by
// its final Keep (or a direct Reset/current-layout Keep). Earlier draws are
// fillers. Thus the scheduling search needs at most two events per weapon.
// Ordered layouts are retained: equal category counts are not interchangeable.
export async function buildCandidatePools(request, provider, report = () => {}, options = {}) {
  const cap = options.candidateCap ?? 200_000;
  const pools = Object.fromEntries(MODES.map((mode) => [mode, { bonus: [], skill: [], complete: true }]));
  const resetCache = new Map();
  const skillCache = new Map();
  for (let ti = 0; ti < request.targets.length; ti += 1) {
    const target = request.targets[ti];
    const key = `${target.weaponType}:${target.attributeForce}`;
    report({ phase: "predictions", target: ti + 1, total: request.targets.length });
    for (const stream of ["bonus", "skill"]) {
      const sets = Object.fromEntries(MODES.map((mode) => [mode, []]));
      const current = stream === "bonus"
        ? (target.planner.currentBonuses ? bonusTotals(target.planner.currentBonuses, target) : null)
        : target.planner.currentSkill;
      for (const mode of MODES) {
        const lowerBound = stream === "bonus" ? { attack: 0, affinity: 0, element: 0, sharpness: 0, ammo: 0 } : null;
        if (!hasGoal(target, stream) || ((current ?? lowerBound) !== null && matchesTier(current ?? lowerBound, target, stream, mode))) sets[mode].push({ finish: 0, action: "already" });
      }
      const needed = MODES.filter((mode) => sets[mode].length === 0);
      const count = request.limits[stream];
      if (needed.length && count > 0) {
        if (stream === "skill") {
          if (!skillCache.has(key)) skillCache.set(key, provider.skills(target, 0, count));
          const rolls = skillCache.get(key);
          for (let index = 0; index < count; index += 1) {
            for (const mode of needed) if (matchesTier(rolls[index], target, stream, mode)) sets[mode].push({ finish: index + 1, action: "skill" });
          }
        } else {
          if (!resetCache.has(key)) resetCache.set(key, provider.reset(target, 0, count));
          const rolls = resetCache.get(key);
          const layouts = new Map();
          const initial = target.planner.currentBonuses ? layoutOf(target.planner.currentBonuses) : target.keepCategories;
          if (validLayout(initial, target)) layouts.set(layoutKey(initial), { layout: initial, positions: [], initial: true });
          for (let index = 0; index < count; index += 1) {
            const result = Array.from(rolls.subarray(index * 5, index * 5 + 5));
            const totals = bonusTotals(result, target);
            for (const mode of needed) if (matchesTier(totals, target, stream, mode)) sets[mode].push({ finish: index + 1, action: "reset" });
            const layout = layoutOf(result);
            const lk = layoutKey(layout);
            if (!layouts.has(lk)) layouts.set(lk, { layout, positions: [], initial: false });
            layouts.get(lk).positions.push(index + 1);
          }
          let li = 0;
          for (const { layout, positions, initial: known } of layouts.values()) {
            // A loose upper bound is safe for pruning; the real engine still
            // enforces all tier and category caps for every candidate.
            const maximumIds = layout.map((category) => [15, 16, 14, 10][category]);
            const maximum = bonusTotals(maximumIds, target);
            if (!needed.some((mode) => matchesTier(maximum, target, stream, mode))) continue;
            const kept = provider.keep(target, 0, count, layout);
            for (let index = known ? 0 : positions[0]; index < count; index += 1) {
              const totals = bonusTotals(kept.subarray(index * 5, index * 5 + 5), target);
              for (const mode of needed) {
                if (!matchesTier(totals, target, stream, mode)) continue;
                if (sets[mode].length >= cap) { pools[mode].complete = false; continue; }
                sets[mode].push({ finish: index + 1, action: "keep", layout, acquisitions: known ? null : positions });
              }
            }
            if (++li % 6 === 0) { await pause(); report({ phase: "layouts", target: ti + 1, layouts: li, total: layouts.size }); }
          }
        }
      }
      for (const mode of MODES) {
        const choices = sets[mode].sort((a, b) => a.finish - b.finish || Number(Boolean(a.acquisitions)) - Number(Boolean(b.acquisitions)));
        // A direct finish dominates any two-event finish at the same position.
        const direct = new Set(choices.filter((v) => !v.acquisitions).map((v) => v.finish));
        pools[mode][stream].push({ id: target.id, choices: choices.filter((v) => !v.acquisitions || !direct.has(v.finish)) });
      }
    }
    await pause();
  }
  return pools;
}

function matchingSchedule(targets, horizon) {
  const owner = new Map();
  const selected = new Map();
  function augment(target, seen) {
    for (const choice of target.choices) {
      if (choice.finish === 0) { selected.set(target.id, { ...choice, id: target.id }); return true; }
      if (choice.finish > horizon) break;
      if (seen.has(choice.finish)) continue;
      seen.add(choice.finish);
      const previous = owner.get(choice.finish);
      if (!previous || augment(previous, seen)) {
        owner.set(choice.finish, target);
        selected.set(target.id, { ...choice, id: target.id });
        return true;
      }
    }
    return false;
  }
  return targets.every((target) => augment(target, new Set())) ? [...selected.values()] : null;
}

function eventSchedule(targets, horizon, budget) {
  if (targets.every((target) => target.choices.every((v) => !v.acquisitions))) return { choices: matchingSchedule(targets, horizon), exhausted: false };
  const occupied = new Uint8Array(horizon + 1);
  const selected = [];
  let exhausted = false;
  function visit(remaining) {
    if (!remaining.length) return true;
    if (++budget.nodes > budget.max) { exhausted = true; return false; }
    let bestIndex = 0;
    let minimum = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      let count = 0;
      for (const choice of remaining[i].choices) {
        if (choice.finish > horizon) break;
        if (choice.finish === 0 || !occupied[choice.finish]) count += 1;
      }
      if (count < minimum) { minimum = count; bestIndex = i; }
    }
    if (!minimum) return false;
    const target = remaining[bestIndex];
    const rest = remaining.filter((_, i) => i !== bestIndex);
    for (const choice of target.choices) {
      if (choice.finish > horizon) break;
      if (choice.finish !== 0 && occupied[choice.finish]) continue;
      if (choice.finish !== 0) occupied[choice.finish] = 1;
      const tryChoice = (acquire) => {
        if (acquire) occupied[acquire] = 1;
        selected.push({ ...choice, id: target.id, acquire });
        const found = visit(rest);
        if (found) return true;
        selected.pop();
        if (acquire) occupied[acquire] = 0;
        return false;
      };
      if (choice.acquisitions) {
        for (let ai = before(choice.acquisitions, choice.finish) - 1; ai >= 0 && !exhausted; ai -= 1) {
          const acquire = choice.acquisitions[ai];
          if (!occupied[acquire] && tryChoice(acquire)) return true;
        }
      } else if (tryChoice(null)) return true;
      if (choice.finish !== 0) occupied[choice.finish] = 0;
      if (exhausted) return false;
    }
    return false;
  }
  return { choices: visit(targets) ? selected : null, exhausted };
}

export async function optimizeStream(targets, limit, complete = true, options = {}) {
  const missing = targets.filter((target) => !target.choices.length).map((target) => target.id);
  if (missing.length) return { status: complete ? "missing" : "incomplete", missing, proven: complete, horizon: null, choices: [] };
  const budget = { nodes: 0, max: options.maxNodes ?? 200_000 };
  const first = eventSchedule(targets, limit, budget);
  if (!first.choices) return { status: first.exhausted || !complete ? "incomplete" : "missing", missing: [], proven: !first.exhausted && complete, horizon: null, choices: [] };
  let best = first.choices;
  let hi = Math.max(0, ...best.map((c) => c.finish));
  let lo = Math.max(0, ...targets.map((t) => t.choices[0].finish));
  let exhausted = false;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = eventSchedule(targets, mid, budget);
    if (trial.exhausted) { exhausted = true; break; }
    if (trial.choices) { best = trial.choices; hi = Math.max(0, ...best.map((c) => c.finish)); }
    else lo = mid + 1;
    await pause();
  }
  return { status: "complete", horizon: Math.max(0, ...best.map((c) => c.finish)), choices: best.map(({ acquisitions, ...choice }) => choice), proven: complete && !exhausted, nodes: budget.nodes };
}

export function replayRoute(request, mode, bonus, skill, provider) {
  const steps = [];
  const position = { ...request.origin };
  const current = new Map(request.targets.map((t) => [t.id, t.planner.currentBonuses ? layoutOf(t.planner.currentBonuses) : t.keepCategories]));
  for (const [stream, solution] of [["bonus", bonus], ["skill", skill]]) {
    if (solution.status !== "complete") continue;
    const events = new Map();
    for (const choice of solution.choices) {
      if (choice.acquire) events.set(choice.acquire, { ...choice, action: "reset", intent: "acquire" });
      if (choice.finish) events.set(choice.finish, { ...choice, intent: "finish" });
    }
    for (let offset = 1; offset <= solution.horizon; offset += 1) {
      const event = events.get(offset);
      const next = event ?? events.get([...events.keys()].filter((v) => v > offset).sort((a, b) => a - b)[0]);
      if (!next) throw new Error("No unfinished weapon for a filler draw");
      const target = request.targets.find((t) => t.id === next.id);
      const action = event?.action ?? (stream === "skill" ? "skill" : next.action === "keep" ? "keep" : "reset");
      const layout = current.get(target.id);
      if (action === "keep" && (!validLayout(layout, target) || (event?.layout && layoutKey(layout) !== layoutKey(event.layout)))) throw new Error("Keep layout replay mismatch");
      const raw = stream === "skill" ? provider.skills(target, offset - 1, 1)[0]
        : Array.from(action === "keep" ? provider.keep(target, offset - 1, 1, layout) : provider.reset(target, offset - 1, 1));
      const totals = stream === "bonus" ? bonusTotals(raw, target) : null;
      const quality = resultQuality(stream === "bonus" ? totals : raw, target, stream);
      if (event?.intent === "finish" && !matchesTier(stream === "bonus" ? totals : raw, target, stream, mode)) throw new Error("Goal replay mismatch");
      if (stream === "bonus") current.set(target.id, layoutOf(raw));
      const beforePosition = { ...position };
      position[`${stream}Counter`] += 1;
      const result = { offset, raw, totals, quality };
      const last = steps.at(-1);
      if (last && last.targetId === target.id && last.action === action && last.stream === stream && last.intent === "advance") {
        last.end = offset; last.rolls.push(result); last.after = { ...position }; last.intent = event?.intent ?? "advance";
      } else steps.push({ targetId: target.id, action, stream, start: offset, end: offset, layout: action === "keep" ? [...layout] : null, intent: event?.intent ?? "advance", rolls: [result], before: beforePosition, after: { ...position } });
    }
  }
  return {
    mode, origin: { ...request.origin }, targets: request.targets, limits: request.limits,
    bonus, skill, steps,
    complete: bonus.status === "complete" && skill.status === "complete",
    proven: bonus.proven && skill.proven,
    total: bonus.status === "complete" && skill.status === "complete" ? bonus.horizon + skill.horizon : null,
    final: { ...position },
  };
}

export async function planWeapons(request, provider, report = () => {}, options = {}) {
  validatePlannerRequest(request);
  const pools = await buildCandidatePools(request, provider, report, options);
  const routes = {};
  for (const mode of MODES) {
    report({ phase: "optimize", mode });
    const pool = pools[mode];
    const bonus = await optimizeStream(pool.bonus, request.limits.bonus, pool.complete, options);
    const skill = await optimizeStream(pool.skill, request.limits.skill, true, options);
    routes[mode] = replayRoute(request, mode, bonus, skill, provider);
    report({ phase: "route", mode, route: routes[mode] });
    await pause();
  }
  return routes;
}
