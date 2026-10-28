import { bonusGoalAlwaysMet, bonusTotals, hasGoal, layoutOf, matchesTier, rangeCanMatch, resultQuality, savedFinishChoice, skillGoalAlwaysMet, validLayout, validatePlannerRequest } from "./planner-model.js";

const MODES = ["acceptable", "preferred"];
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const layoutKey = (layout) => layout.join("");
const schedulingBudget = (options) => ({ nodes: 0, max: options.maxNodes ?? 200_000, work: 0, maxWork: options.maxWork ?? 300_000_000 });
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
// Acceptable candidates carry `top` when they also meet the top-desired goal,
// so the acceptable route can take a free upgrade (see optimizeStream).
export async function buildCandidatePools(request, provider, report = () => {}, options = {}) {
  const cap = options.candidateCap ?? 200_000;
  const pools = Object.fromEntries(MODES.map((mode) => [mode, { bonus: [], skill: [], complete: true }]));
  const resetCache = new Map();
  const skillCache = new Map();
  for (let ti = 0; ti < request.targets.length; ti += 1) {
    const target = request.targets[ti];
    const key = `${target.weaponType}:${target.attributeForce}`;
    report({ phase: "predictions", target: ti + 1, total: request.targets.length });
    for (const stream of options.streams ?? ["bonus", "skill"]) {
      const sets = Object.fromEntries(MODES.map((mode) => [mode, []]));
      const savedKeys = new Set(hasGoal(target, stream) ? (target.planner.savedFinishes?.[stream] ?? [])
        .map((pick) => savedFinishChoice(target, stream, pick, request.origin)).filter((pick) => pick.status === "pending").map((pick) => pick.key) : []);
      const current = stream === "bonus"
        ? (target.planner.currentBonuses ? bonusTotals(target.planner.currentBonuses, target) : null)
        : target.planner.currentSkill;
      // An unknown current result still needs no roll when every possible
      // result meets the goal, including any known bonus categories.
      const met = (mode) => !hasGoal(target, stream) || (current !== null
        ? matchesTier(current, target, stream, mode)
        : stream === "bonus" ? bonusGoalAlwaysMet(target, mode) : skillGoalAlwaysMet(target, mode));
      for (const mode of MODES) {
        if (met(mode)) sets[mode].push({ finish: 0, action: "already", top: mode === "acceptable" && hasGoal(target, stream) && met("preferred") });
      }
      const needed = MODES.filter((mode) => sets[mode].length === 0 || savedKeys.size > 0 || options.includeMet);
      const count = request.limits[stream];
      if (needed.length && count > 0) {
        if (stream === "skill") {
          if (!skillCache.has(key)) skillCache.set(key, provider.skills(target, 0, count));
          const rolls = skillCache.get(key);
          for (let index = 0; index < count; index += 1) {
            const top = matchesTier(rolls[index], target, stream, "preferred");
            for (const mode of needed) if (matchesTier(rolls[index], target, stream, mode)) sets[mode].push({ finish: index + 1, action: "skill", top: mode === "acceptable" && top });
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
            const top = matchesTier(totals, target, stream, "preferred");
            for (const mode of needed) if (matchesTier(totals, target, stream, mode)) sets[mode].push({ finish: index + 1, action: "reset", top: mode === "acceptable" && top });
            const layout = layoutOf(result);
            const lk = layoutKey(layout);
            if (!layouts.has(lk)) layouts.set(lk, { layout, positions: [], initial: false });
            layouts.get(lk).positions.push(index + 1);
          }
          let li = 0;
          for (const { layout, positions, initial: known } of layouts.values()) {
            // Loose bounds (top and bottom tier in every slot) are safe for
            // pruning; the real engine still enforces all tier and category
            // caps for every candidate.
            const maximum = bonusTotals(layout.map((category) => [15, 16, 14, 10][category]), target);
            const minimum = bonusTotals(layout.map((category) => [8, 9, 11, 6][category]), target);
            // Custom status gains can put either tier first. A bounded stat
            // can only match known gains, so ignore unknown endpoints.
            for (const stat of Object.keys(minimum)) {
              const known = [minimum[stat], maximum[stat]].filter(Number.isFinite);
              minimum[stat] = known.length ? Math.min(...known) : null;
              maximum[stat] = known.length ? Math.max(...known) : null;
            }
            if (!needed.some((mode) => rangeCanMatch(minimum, maximum, target, mode))) continue;
            const kept = provider.keep(target, 0, count, layout);
            for (let index = known ? 0 : positions[0]; index < count; index += 1) {
              const totals = bonusTotals(kept.subarray(index * 5, index * 5 + 5), target);
              const top = matchesTier(totals, target, stream, "preferred");
              for (const mode of needed) {
                if (!matchesTier(totals, target, stream, mode)) continue;
                const choice = { finish: index + 1, action: "keep", layout, acquisitions: known ? null : positions, top: mode === "acceptable" && top };
                if (sets[mode].length >= cap && !savedKeys.has(choiceKey(choice))) { pools[mode].complete = false; continue; }
                sets[mode].push(choice);
              }
            }
            if (++li % 6 === 0) { await pause(); report({ phase: "layouts", target: ti + 1, layouts: li, total: layouts.size }); }
          }
        }
      }
      // A weapon that already meets its acceptable goal can still be
      // upgraded for free; the top-desired candidates are its options.
      if (sets.acceptable.length === 1 && sets.acceptable[0].action === "already" && !sets.acceptable[0].top) {
        for (const choice of sets.preferred) {
          if (choice.action !== "already") sets.acceptable.push({ ...choice, top: true });
        }
      }
      for (const mode of MODES) {
        const choices = sets[mode].sort((a, b) => a.finish - b.finish || Number(Boolean(a.acquisitions)) - Number(Boolean(b.acquisitions)));
        // A direct finish dominates any two-event finish at the same position,
        // unless only the two-event finish is a top-desired result.
        const direct = new Map();
        for (const v of choices) if (!v.acquisitions) direct.set(v.finish, Boolean(direct.get(v.finish) || v.top));
        pools[mode][stream].push({ id: target.id, choices: choices.filter((v) => options.includeMet || savedKeys.has(choiceKey(v)) || !v.acquisitions || !direct.has(v.finish) || (v.top && !direct.get(v.finish))) });
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
      // Only whether this target beats the current minimum matters, so stop
      // counting once it cannot. Scanned choices count toward the budget too:
      // with many weapons a single node can scan thousands of choices.
      let count = 0;
      for (const choice of remaining[i].choices) {
        if (choice.finish > horizon || count >= minimum) break;
        budget.work += 1;
        if (choice.finish === 0 || !occupied[choice.finish]) count += 1;
      }
      if (count < minimum) { minimum = count; bestIndex = i; }
    }
    if (budget.work > budget.maxWork) { exhausted = true; return false; }
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
  const budget = schedulingBudget(options);
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
  const horizon = Math.max(0, ...best.map((c) => c.finish));
  // Among schedules of this minimum length, prefer top-desired finishes:
  // positions up to the horizon are rolled anyway, so an upgrade is free.
  // Weapons are upgraded greedily in list order on a separate budget, which
  // never affects whether the minimum is proven.
  if (!exhausted) {
    const upgradeBudget = schedulingBudget(options);
    let current = targets;
    const topOnly = (i) => current.map((t, j) => j === i ? { ...t, choices: t.choices.filter((c) => c.top) } : t);
    for (let i = 0; i < current.length; i += 1) {
      // A weapon already finishing top desired is locked there, so a later
      // weapon's upgrade cannot cost it its own.
      if (best.find((c) => c.id === current[i].id)?.top) { current = topOnly(i); continue; }
      if (!current[i].choices.some((c) => c.top && c.finish <= horizon)) continue;
      const trialTargets = topOnly(i);
      const trial = eventSchedule(trialTargets, horizon, upgradeBudget);
      if (trial.exhausted) break;
      if (trial.choices) { current = trialTargets; best = trial.choices; }
      await pause();
    }
  }
  return { status: "complete", horizon, choices: best.map(({ acquisitions, ...choice }) => choice), proven: complete && !exhausted, nodes: budget.nodes };
}

const choiceKey = (choice) => `${choice.action}:${choice.finish}:${choice.layout ? layoutKey(choice.layout) : ""}`;

// A weapon's saved options are alternatives: choose one, and never fall back
// to automatic results while a nonempty saved collection exists.
function savedChoiceSets(request, provider) {
  return Object.fromEntries(["bonus", "skill"].map((stream) => [stream, new Map(request.targets
    .filter((target) => hasGoal(target, stream) && target.planner.savedFinishes?.[stream]?.length)
    .map((target) => [target.id, new Set(target.planner.savedFinishes[stream].flatMap((pick) => {
      const choice = savedFinishChoice(target, stream, pick, request.origin);
      if (!choice.key || choice.finish > request.limits[stream]) return [];
      if (choice.status === "pending") {
        const predicted = stream === "skill" ? provider.skills(target, choice.finish - 1, 1)[0]
          : Array.from(pick.action === "keep" ? provider.keep(target, choice.finish - 1, 1, pick.layout) : provider.reset(target, choice.finish - 1, 1));
        if (JSON.stringify(predicted) !== JSON.stringify(pick.raw)) return [];
      }
      return [choice.key];
    }))]))]));
}

// Browsing is independent of a built route and uses the full search limit.
// Saving a result from this list does not schedule or execute anything.
export async function collectFinishOptions(request, stream, targetId, provider, report = () => {}, options = {}) {
  validatePlannerRequest(request);
  const from = options.from ?? 1;
  if (!Number.isInteger(from) || from < 1 || from > request.limits[stream]) throw new Error("range");
  const target = request.targets.find((value) => value.id === targetId);
  if (!target || !["bonus", "skill"].includes(stream) || !hasGoal(target, stream)) throw new Error("goals");
  const predictions = new Map();
  const cached = Object.fromEntries(["reset", "keep", "skills"].map((kind) => [kind, (weapon, offset, count, layout) => {
    const key = `${kind}:${offset}:${count}:${layout?.join("") ?? ""}`;
    if (!predictions.has(key)) predictions.set(key, provider[kind](weapon, offset, count, layout));
    return predictions.get(key);
  }]));
  const pools = await buildCandidatePools({ ...request, targets: [target] }, cached, report, { ...options, streams: [stream], includeMet: true });
  const choices = pools.acceptable[stream][0].choices;
  const found = choices.filter((choice) => choice.finish >= from).map((choice) => {
    const rolls = stream === "skill" ? cached.skills(target, 0, request.limits[stream])
      : choice.action === "keep" ? cached.keep(target, 0, request.limits[stream], choice.layout) : cached.reset(target, 0, request.limits[stream]);
    const raw = stream === "skill" ? rolls[choice.finish - 1] : Array.from(rolls.subarray((choice.finish - 1) * 5, choice.finish * 5));
    return { key: choiceKey(choice), finish: choice.finish, action: choice.action, layout: choice.layout ?? null,
      acquire: choice.acquisitions?.find((position) => position < choice.finish) ?? null,
      raw, top: matchesTier(stream === "bonus" ? bonusTotals(raw, target) : raw, target, stream, "preferred"),
      totals: stream === "bonus" ? bonusTotals(raw, target) : null };
  });
  return { options: found, complete: pools.acceptable.complete };
}

// The weapons scheduled in a stream, limited to finishes within its horizon.
// A weapon keeps the finish the player pinned, and a weapon finishing top
// desired stays top desired, so choosing one weapon's finish never costs
// another weapon its own.
function lockedTargets(pool, solution, pins = {}) {
  const chosen = new Map(solution.choices.map((choice) => [choice.id, choice]));
  return pool.filter((target) => chosen.has(target.id)).map((target) => ({
    ...target,
    choices: target.choices.filter((choice) => choice.finish <= solution.horizon
      && (pins[target.id] ? choiceKey(choice) === pins[target.id] : !chosen.get(target.id).top || choice.top)),
  }));
}

// Every finish for one weapon within the stream's roll count. A finish that
// fits carries the full schedule that makes room for it: other weapons keep
// their own finishes when possible, and `moves` names any that must change.
// A finish that does not fit the current route (it overlaps another weapon's
// finish, a chosen finish, or a top-desired finish) is still listed with
// `fits: false`; `collides` names weapons using its roll, and choosing it
// recalculates the whole stream (see recalcWithFinish). Identical results are
// listed once, preferring a copy that fits. The search is per finish, so a
// budget-limited finish is reported as unchecked, not impossible.
export async function finishOptions(route, stream, targetId, provider, options = {}) {
  const request = { origin: route.origin, targets: route.targets, limits: route.limits };
  const solution = route[stream];
  const pool = (await buildCandidatePools(request, provider, () => {}, { ...options, streams: [stream] }))[route.mode][stream];
  const locked = lockedTargets(pool, solution, route.pins?.[stream]);
  const index = locked.findIndex((target) => target.id === targetId);
  const target = route.targets.find((v) => v.id === targetId);
  const keys = new Map(solution.choices.map((choice) => [choice.id, choiceKey(choice)]));
  const currentKey = keys.get(targetId);
  const unchanged = locked.map((v) => ({ ...v, choices: v.choices.filter((choice) => choiceKey(choice) === keys.get(v.id)) }));
  const users = new Map();
  for (const choice of solution.choices) {
    if (choice.id === targetId) continue;
    for (const position of [choice.finish, choice.acquire]) if (position) users.set(position, choice.id);
  }
  const own = pool.find((v) => v.id === targetId).choices.filter((choice) => choice.finish <= solution.horizon);
  const found = [];
  const byResult = new Map();
  let unchecked = 0;
  for (let i = 0; i < own.length; i += 1) {
    const choice = own[i];
    const raw = choice.finish === 0 ? null
      : stream === "skill" ? provider.skills(target, choice.finish - 1, 1)[0]
        : Array.from(choice.action === "keep" ? provider.keep(target, choice.finish - 1, 1, choice.layout) : provider.reset(target, choice.finish - 1, 1));
    const current = choiceKey(choice) === currentKey;
    const result = JSON.stringify(raw);
    const earlier = current ? undefined : byResult.get(result);
    if (earlier !== undefined && found[earlier].fits) continue;
    const attempt = (targets) => eventSchedule(targets.map((v, j) => j === index ? { ...v, choices: [choice] } : v), solution.horizon, schedulingBudget(options));
    let trial = attempt(unchanged);
    if (!trial.choices && !trial.exhausted) trial = attempt(locked);
    if (!trial.choices && trial.exhausted) { unchecked += 1; continue; }
    const fits = Boolean(trial.choices);
    if (earlier !== undefined && !fits) continue;
    const entry = {
      key: choiceKey(choice),
      finish: choice.finish,
      action: choice.action,
      acquire: fits ? trial.choices.find((v) => v.id === targetId).acquire ?? null : null,
      top: Boolean(choice.top),
      current,
      raw,
      totals: stream === "bonus" && raw ? bonusTotals(raw, target) : null,
      fits,
      moves: fits ? trial.choices.filter((v) => v.id !== targetId && choiceKey(v) !== keys.get(v.id)).map((v) => v.id) : [],
      collides: fits || !users.has(choice.finish) ? [] : [users.get(choice.finish)],
      choices: fits ? trial.choices.map(({ acquisitions, ...v }) => v) : null,
    };
    if (earlier !== undefined) found[earlier] = entry;
    else { if (!current) byResult.set(result, found.length); found.push(entry); }
    if (i % 20 === 19) await pause();
  }
  // The current finish stands for its result; drop other copies of it.
  const currentResult = JSON.stringify(found.find((entry) => entry.current)?.raw);
  const listed = found.filter((entry) => entry.current || JSON.stringify(entry.raw) !== currentResult);
  listed.sort((a, b) => Number(b.top) - Number(a.top) || a.finish - b.finish);
  return { options: listed, unchecked };
}

// Re-plans one stream with a weapon's finish forced to a choice that does not
// fit the current route. Earlier chosen finishes are kept when they still fit
// together and released otherwise. The stream may take more rolls, so the
// minimum is proven only if its roll count is unchanged.
export async function recalcWithFinish(route, stream, targetId, option, provider, options = {}) {
  const request = { origin: route.origin, targets: route.targets, limits: route.limits };
  const pools = (await buildCandidatePools(request, provider, () => {}, { ...options, streams: [stream] }))[route.mode];
  const scheduled = new Set(route[stream].choices.map((choice) => choice.id));
  const forced = pools[stream].filter((target) => scheduled.has(target.id)).map((target) => target.id === targetId ? { ...target, choices: target.choices.filter((choice) => choiceKey(choice) === option.key) } : target);
  const pins = Object.fromEntries(Object.entries(route.pins?.[stream] ?? {}).filter(([id]) => id !== targetId && scheduled.has(id)));
  const pinned = forced.map((target) => pins[target.id] ? { ...target, choices: target.choices.filter((choice) => choiceKey(choice) === pins[target.id]) } : target);
  const complete = stream === "bonus" ? pools.complete : true;
  let solution = await optimizeStream(pinned, request.limits[stream], complete, options);
  let released = [];
  if (solution.status !== "complete" && Object.keys(pins).length) {
    solution = await optimizeStream(forced, request.limits[stream], complete, options);
    released = Object.keys(pins);
  }
  if (solution.status !== "complete") throw new Error("noRecalc");
  const kept = Object.fromEntries(Object.entries(pins).filter(([id]) => !released.includes(id)));
  const next = replayRoute(request, route.mode, stream === "bonus" ? solution : route.bonus, stream === "skill" ? solution : route.skill, provider);
  return {
    ...next,
    proven: route.proven && solution.proven && solution.horizon === route[stream].horizon,
    dropped: route.dropped,
    alternatives: route.alternatives,
    alternativesComplete: route.alternativesComplete,
    pins: { ...route.pins, [stream]: { ...kept, [targetId]: option.key } },
    released,
  };
}

// Rebuilds the route with one weapon's finish chosen from finishOptions. The
// other stream, the roll count and the minimum proof are unchanged.
export function pinFinish(route, stream, targetId, option, provider) {
  const request = { origin: route.origin, targets: route.targets, limits: route.limits };
  const solution = { ...route[stream], choices: option.choices };
  const next = replayRoute(request, route.mode, stream === "bonus" ? solution : route.bonus, stream === "skill" ? solution : route.skill, provider);
  return {
    ...next,
    proven: route.proven,
    dropped: route.dropped,
    alternatives: route.alternatives,
    alternativesComplete: route.alternativesComplete,
    pins: { ...route.pins, [stream]: { ...route.pins?.[stream], [targetId]: option.key } },
  };
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

// Decides which weapons a route finishes. Weapons are tried in priority order,
// required before optional, and a weapon is kept only if every weapon kept so
// far still fits within the roll limit. A required weapon with no reachable
// goal is never dropped, so the route reports it as missing instead.
// Dropping a weapon removes it from both streams: half a weapon is not a goal,
// so each weapon is tested against both streams before it is dropped.
export async function selectTargets(request, pool, order, options = {}, budgets = null) {
  const optional = new Set(request.targets.filter((t) => t.planner.optional).map((t) => t.id));
  const dropped = new Map();
  let exhausted = false;
  const streams = ["bonus", "skill"].map((stream) => ({
    limit: request.limits[stream],
    complete: stream === "skill" || pool.complete !== false,
    byId: new Map(pool[stream].map((target) => [target.id, target])),
    budget: budgets?.[stream] ?? schedulingBudget(options),
  }));
  const unreachable = new Set(order.filter((id) => streams.some(({ byId }) => !byId.get(id).choices.length)));
  for (const id of order) if (optional.has(id) && unreachable.has(id)) {
    const proven = streams.some(({ byId, complete }) => complete && !byId.get(id).choices.length);
    dropped.set(id, proven ? "unreachable" : "unchecked");
    if (!proven) exhausted = true;
  }
  const kept = [...order.filter((id) => !optional.has(id)), ...order.filter((id) => optional.has(id) && !dropped.has(id))];
  // A stream with an unreachable required weapon is reported as missing, so
  // it cannot exclude anything.
  const active = streams.filter(({ byId }) => kept.every((id) => byId.get(id).choices.length));
  const fits = (ids) => {
    let uncertain = false;
    for (const { byId, limit, budget, complete } of active) {
      const trial = eventSchedule(ids.map((id) => byId.get(id)), limit, budget);
      if (trial.exhausted || (!trial.choices && !complete)) uncertain = true;
      else if (!trial.choices) return false;
    }
    // A complete stream can prove a conflict even when the other stream is
    // uncertain. Failure in truncated candidates alone proves nothing.
    return uncertain ? null : true;
  };
  const all = fits(kept);
  const fit = all ? [...kept] : [];
  for (let i = 0; !all && i < kept.length; i += 1) {
    const trial = all === null ? null : fits([...fit, kept[i]]);
    if (trial === null) {
      // Candidate collection or scheduling left feasibility uncertain. Keep
      // required weapons for the final search and leave optional ones
      // unchecked, since they may still fit.
      exhausted = true;
      for (const id of kept.slice(i)) if (optional.has(id)) dropped.set(id, "unchecked"); else fit.push(id);
      break;
    }
    // Unreachable optional weapons were removed above. An unreachable
    // required weapon must survive a conflict in its other stream, so the
    // final solve still reports the missing goal.
    if (trial || unreachable.has(kept[i])) fit.push(kept[i]);
    else dropped.set(kept[i], "conflict");
    await pause();
  }
  return { kept: new Set(fit), dropped: [...dropped].map(([id, reason]) => ({ id, reason, optional: optional.has(id) })), exhausted };
}

async function planRoute(request, pool, mode, order, provider, options, selection = null) {
  selection ??= await selectTargets(request, pool, order, options);
  const only = (stream) => pool[stream].filter((target) => selection.kept.has(target.id));
  const bonus = await optimizeStream(only("bonus"), request.limits.bonus, pool.complete, options);
  const skill = await optimizeStream(only("skill"), request.limits.skill, true, options);
  const route = replayRoute(request, mode, bonus, skill, provider);
  route.dropped = selection.dropped;
  if (selection.exhausted) route.proven = false;
  return route;
}

async function findAlternativeRoutes(request, pool, mode, ids, primary, provider, options) {
  const alternatives = [];
  const queue = [{ prefix: [], dropped: primary.dropped }];
  const prefixes = new Set(["[]"]);
  const routeKey = (route) => JSON.stringify(route.dropped.map(({ id }) => id).sort());
  const routes = new Set([routeKey(primary)]);
  const budgets = Object.fromEntries(["bonus", "skill"].map((stream) => [stream, schedulingBudget(options)]));
  let complete = primary.proven;
  let attempts = 0;
  for (let qi = 0; qi < queue.length; qi += 1) {
    const node = queue[qi];
    for (const { id } of node.dropped.filter((v) => v.reason === "conflict")) {
      // Keep every earlier choice in this prefix. Repeatedly adding displaced
      // weapons explores combinations of independent conflicts, not just swaps
      // against the primary route. Canonical prefixes avoid permutation work.
      const prefix = ids.filter((v) => v === id || node.prefix.includes(v));
      const key = JSON.stringify(prefix);
      if (prefixes.has(key)) continue;
      if (alternatives.length >= 4 || attempts >= (options.maxAlternativeAttempts ?? 500)) return { alternatives, complete: false };
      prefixes.add(key);
      attempts += 1;
      const order = [...prefix, ...ids.filter((v) => !prefix.includes(v))];
      const selection = await selectTargets(request, pool, order, options, budgets);
      if (selection.exhausted) return { alternatives, complete: false };
      // Required weapons still take priority. An optional choice that cannot
      // coexist with them cannot become an alternative by being promoted.
      if (!prefix.every((v) => selection.kept.has(v))) continue;
      queue.push({ prefix, dropped: selection.dropped });
      const selectedKey = routeKey(selection);
      if (routes.has(selectedKey)) continue;
      routes.add(selectedKey);
      const route = await planRoute(request, pool, mode, order, provider, options, selection);
      if (!route.proven) complete = false;
      if (route.complete) alternatives.push(route);
    }
  }
  return { alternatives, complete };
}

export async function planWeapons(request, provider, report = () => {}, options = {}) {
  validatePlannerRequest(request);
  const pools = await buildCandidatePools(request, provider, report, options);
  const routes = {};
  const ids = request.targets.map((t) => t.id);
  const savedSets = savedChoiceSets(request, provider);
  for (const mode of MODES) {
    report({ phase: "optimize", mode });
    const basePool = { ...pools[mode], ...Object.fromEntries(["bonus", "skill"].map((stream) => [stream,
      pools[mode][stream].map((target) => savedSets[stream].has(target.id)
        ? { ...target, choices: target.choices.filter((choice) => savedSets[stream].get(target.id).has(choiceKey(choice))) } : target)])) };
    const requestedPins = options.preservePinsByMode?.[mode] ?? {};
    let released = new Set();
    let activePins = Object.fromEntries(["bonus", "skill"].map((stream) => [stream, Object.fromEntries(Object.entries(requestedPins[stream] ?? {}).filter(([id]) => !savedSets[stream].has(id)))]));
    const restrictPool = (pins) => {
      const validPins = Object.fromEntries(["bonus", "skill"].map((stream) => [stream, {}]));
      const nextPool = { ...basePool };
      for (const stream of ["bonus", "skill"]) {
        const byId = new Map(basePool[stream].map((target) => [target.id, target]));
        for (const [id, key] of Object.entries(pins?.[stream] ?? {})) {
          const target = byId.get(id);
          if (!target) continue;
          const choice = target.choices.find((candidate) => choiceKey(candidate) === key);
          if (choice) validPins[stream][id] = key;
          else released.add(id);
        }
        nextPool[stream] = basePool[stream].map((target) => {
          const key = validPins[stream][target.id];
          return key ? { ...target, choices: target.choices.filter((choice) => choiceKey(choice) === key) } : target;
        });
      }
      return { pool: nextPool, pins: validPins };
    };
    const solve = async () => {
      const restricted = restrictPool(activePins);
      activePins = restricted.pins;
      return { pool: restricted.pool, route: await planRoute(request, restricted.pool, mode, ids, provider, options) };
    };
    let solved = await solve();
    if (!solved.route.complete && Object.values(activePins).some((pins) => Object.keys(pins).length)) {
      // Keep manual choices when they still allow a complete route. If they
      // alone make the route impossible, release only enough choices to find
      // a complete route again.
      const unpinned = await planRoute(request, basePool, mode, ids, provider, options);
      if (unpinned.complete) {
        while (!solved.route.complete && Object.values(activePins).some((pins) => Object.keys(pins).length)) {
          const failedStreams = ["bonus", "skill"].filter((stream) => solved.route[stream].status !== "complete");
          const candidates = failedStreams.flatMap((stream) => Object.keys(activePins[stream]).map((id) => [stream, id]));
          const fallback = ["bonus", "skill"].flatMap((stream) => Object.keys(activePins[stream]).map((id) => [stream, id]));
          const [stream, id] = (candidates.length ? candidates : fallback).at(-1);
          delete activePins[stream][id];
          released.add(id);
          solved = await solve();
        }
      }
    }
    // An optional pinned weapon can be omitted if it no longer fits. Free its
    // old finish and retry so another finish can still include that weapon.
    while (true) {
      const missingPins = ["bonus", "skill"].flatMap((stream) => Object.entries(activePins[stream])
        .filter(([id, key]) => !solved.route[stream].choices.some((choice) => choice.id === id && choiceKey(choice) === key))
        .map(([id]) => [stream, id]));
      if (!missingPins.length) break;
      for (const [stream, id] of missingPins) { delete activePins[stream][id]; released.add(id); }
      solved = await solve();
    }
    const pool = solved.pool;
    const primary = solved.route;
    const { alternatives, complete } = await findAlternativeRoutes(request, pool, mode, ids, primary, provider, options);
    const annotatePins = (route) => {
      const pins = { bonus: {}, skill: {} };
      const savedConflicts = [];
      const routeReleased = new Set(released);
      for (const stream of ["bonus", "skill"]) {
        const choices = new Map(route[stream].choices.map((choice) => [choice.id, choice]));
        for (const [id, keys] of savedSets[stream]) {
          const choice = choices.get(id);
          if (choice && keys.has(choiceKey(choice))) pins[stream][id] = choiceKey(choice);
          else savedConflicts.push({ id, stream });
        }
        for (const [id, key] of Object.entries(activePins[stream])) {
          const choice = choices.get(id);
          if (choice && choiceKey(choice) === key) pins[stream][id] = key;
          else routeReleased.add(id);
        }
      }
      return { ...route, pins, savedConflicts, released: [...routeReleased] };
    };
    const annotatedAlternatives = alternatives.map(annotatePins);
    const annotatedPrimary = annotatePins(primary);
    for (const route of [annotatedPrimary, ...annotatedAlternatives]) route.alternativesComplete = complete;
    annotatedPrimary.alternatives = annotatedAlternatives;
    routes[mode] = annotatedPrimary;
    report({ phase: "route", mode, route: annotatedPrimary });
    await pause();
  }
  return routes;
}
