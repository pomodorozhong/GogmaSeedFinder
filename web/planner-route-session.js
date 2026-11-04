import { choiceKey, MAX_SELECTED, normalizedFinishSort, normalizedPlanner, normalizedProgress, routePosition, routeWeaponsMatch, samePosition, validatePlannerRequest } from "./planner-model.js";
import { routeProgress } from "./planner-progress.js";
import { createPlannerWorker, errorText, terminatePlannerWorker } from "./planner-worker-client.js";
import { tierName } from "./planner-markup.js";
import { pl } from "./planner-text.js";

// The persisted shape stays compatible with existing saves and exports.
function restoredCache(stored, targets) {
  const cache = {
    selected: Array.isArray(stored?.selected) ? stored.selected.filter((v) => typeof v === "string") : targets.slice(0, MAX_SELECTED).map((target) => target.id),
    limits: { bonus: stored?.limits?.bonus ?? 250, skill: stored?.limits?.skill ?? 1000 },
    routes: stored?.routes && typeof stored.routes === "object" ? stored.routes : {},
    mode: stored?.mode === "preferred" ? "preferred" : "acceptable",
    completed: stored?.completed,
    matches: stored?.matches && typeof stored.matches === "object" ? stored.matches : {},
    signature: typeof stored?.signature === "string" ? stored.signature : "",
    weaponSort: ["newTop", "newBottom"].includes(stored?.weaponSort) ? stored.weaponSort : "",
    weaponGroups: Array.isArray(stored?.weaponGroups) ? [...new Set(stored.weaponGroups)].filter((key) => ["type", "element", "selected"].includes(key)) : [],
    finishSort: Object.fromEntries(Object.entries(stored?.finishSort && typeof stored.finishSort === "object" ? stored.finishSort : {})
      .filter(([key, levels]) => /^(bonus|skill):/.test(key) && Array.isArray(levels)).map(([key, levels]) => [key, normalizedFinishSort(levels)])),
  };
  for (const mode of ["acceptable", "preferred"]) {
    const route = cache.routes[mode];
    if (route && (!Array.isArray(route.steps) || !Array.isArray(route.targets) || !route.origin || !route.bonus || !route.skill || route.steps.some((step) => !step.after || !Array.isArray(step.rolls) || !step.rolls.length))) delete cache.routes[mode];
  }
  cache.completed = cache.routes[cache.mode] ? normalizedProgress(cache.routes[cache.mode], cache.completed) : { bonus: 0, skill: 0 };
  return cache;
}

// Owns route search and execution. No DOM, editor state, or finish worker is
// reachable here. The app rechecks the affected stream inside saveStep.
export function createRouteSession(stored, { getState, getTargets, saveStep, onChange, onStatus, onError }) {
  const cache = restoredCache(stored, getTargets());
  const route = () => cache.routes[cache.mode];
  const progress = () => routeProgress(route()?.steps ?? [], cache.completed);
  const totalDone = () => cache.completed.bonus + cache.completed.skill;
  const prepared = () => getTargets().filter((target) => cache.selected.includes(target.id)).map((target) => ({ ...target, planner: normalizedPlanner(target) }));
  const signature = () => JSON.stringify(prepared().map((target) => ({ id: target.id, label: target.label, weaponType: target.weaponType, attributeForce: target.attributeForce, planner: { optional: target.planner.optional, bonusEnabled: target.planner.bonusEnabled, skillEnabled: target.planner.skillEnabled, acceptable: target.planner.acceptable, preferred: target.planner.preferred, elementValues: target.planner.elementValues } })));
  const context = () => JSON.stringify([getState(), prepared()]);
  let inspected = progress().nextIndex();
  let worker = null;
  let activeContext = "";
  let stale = false;
  const compatible = () => Boolean(route()) && !stale && cache.signature === signature() && samePosition(getState(), routePosition(route(), cache.completed)) && routeWeaponsMatch(route(), cache.completed, getTargets());

  function stop() {
    terminatePlannerWorker(worker);
    worker = null; activeContext = "";
  }
  function fail(message) {
    stop(); onError(message); onChange();
  }
  function build(limits) {
    cache.limits = { ...limits };
    const request = { origin: getState(), targets: prepared(), limits: { ...cache.limits } };
    try { validatePlannerRequest(request); } catch (error) { onError(errorText(error.message)); return; }
    stop();
    cache.routes = {}; cache.completed = { bonus: 0, skill: 0 }; cache.matches = {}; cache.mode = "acceptable"; cache.signature = signature();
    inspected = 0; stale = false; activeContext = context();
    try {
      worker = createPlannerWorker((data) => {
        if (data.type === "progress") {
          if (data.phase === "predictions") onStatus(pl("Calculating real roll predictions for weapon {n} of {total}…", { n: data.target, total: data.total }));
          else if (data.phase === "layouts") onStatus(pl("Checking ordered layouts for weapon {n}: {count}/{total}…", { n: data.target, count: data.layouts, total: data.total }));
          else if (data.phase === "optimize") onStatus(pl("Finding the shortest {mode} route…", { mode: tierName(data.mode) }));
          else if (data.phase === "route") { cache.routes[data.mode] = data.route; onChange(); }
        } else if (data.type === "done") {
          cache.routes = data.routes; stop(); onChange();
          onStatus(pl("Guides ready. Your saved picks are kept with each weapon."));
        }
      }, fail);
      onChange();
      onStatus(pl("Calculating real roll predictions for weapon {n} of {total}…", { n: 1, total: request.targets.length }));
      worker.postMessage({ request });
    } catch (error) { fail(errorText(error.message)); }
  }
  function inspect(index) {
    inspected = Math.max(0, Math.min(index, Math.max(0, (route()?.steps.length ?? 0) - 1)));
  }

  return {
    cache, route, progress, totalDone, compatible, build, stop,
    get inspected() { return inspected; },
    get busy() { return worker !== null; },
    usedFinish(id, stream) {
      const choice = compatible() ? route()?.[stream].choices.find((value) => value.id === id) : null;
      return choice ? { key: choiceKey(choice), acquire: choice.acquire ?? null } : null;
    },
    snapshot() {
      inspect(inspected);
      return { route: route(), routes: cache.routes, mode: cache.mode, completed: cache.completed, matches: cache.matches,
        progress: progress(), totalDone: totalDone(), inspected, busy: worker !== null, compatible: compatible(),
        outdated: !worker && cache.signature !== signature(), registered: getTargets() };
    },
    invalidate() {
      stop(); stale = Object.keys(cache.routes).length > 0; cache.signature = ""; cache.matches = {};
      onStatus(pl("Build guides to apply your changes. Saved picks are kept."));
      onChange();
    },
    cancel() {
      stop(); onChange(); onStatus(pl("Search cancelled. Any completed route remains available."));
    },
    syncContext() {
      if (worker && activeContext !== context()) {
        stop(); onStatus(pl("Position or weapons changed. Build new guides before saving more steps."));
      }
      cache.selected = cache.selected.filter((id) => getTargets().some((target) => target.id === id));
    },
    restore(stored) {
      stop(); Object.assign(cache, restoredCache(stored, getTargets()));
      inspected = progress().nextIndex(); stale = false;
    },
    inspect(index) { inspect(index); onChange(); },
    current() { inspected = progress().nextIndex(route()?.steps[inspected]?.stream); onChange(); },
    chooseMode(mode) {
      if (!["acceptable", "preferred"].includes(mode) || (totalDone() > 0 && mode !== cache.mode)) return;
      cache.mode = mode; cache.matches = {}; inspected = 0; onChange();
    },
    chooseAlternative(index) {
      const r = route();
      if (totalDone() > 0 || !r?.alternatives?.[index]) return;
      const { alternatives, ...current } = r;
      cache.routes[cache.mode] = { ...alternatives[index], alternatives: [current, ...alternatives.filter((_, i) => i !== index)] };
      cache.matches = {}; inspected = 0; onChange();
    },
    match(draw) {
      const row = progress().rows[inspected];
      if (!row?.current || !compatible() || !Number.isInteger(draw) || draw < 1 || draw > row.step.rolls.length) return false;
      cache.matches[inspected] = draw;
      return true;
    },
    confirm(index = inspected) {
      const r = route();
      if (worker || !r?.complete || !compatible() || !progress().rows[index]?.current) return;
      const step = r.steps[index];
      try {
        saveStep(step, r.targets.find((target) => target.id === step.targetId));
        cache.completed = { ...cache.completed, [step.stream]: cache.completed[step.stream] + 1 };
        inspected = progress().nextIndex(step.stream);
        onChange(); onStatus(pl("Progress saved in this browser"));
      } catch (error) { onError(error.message); onChange(); }
    },
  };
}
