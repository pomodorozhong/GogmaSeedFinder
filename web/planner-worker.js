import initWasm, { predict_gogma_rolls, predict_gogma_keep_rolls, predict_skill_rolls } from "./pkg/gogma_wasm_search.js";
import { finishOptions, pinFinish, planWeapons, recalcWithFinish } from "./planner-engine.js";

const providerFor = (origin) => ({
  reset: (target, offset, count) => predict_gogma_rolls(origin.baseSeed, target.weaponType, target.attributeForce, origin.bonusCounter + offset, 35, count),
  keep: (target, offset, count, layout) => predict_gogma_keep_rolls(origin.baseSeed, target.weaponType, target.attributeForce, origin.bonusCounter + offset, 35, count, Uint8Array.from(layout)),
  skills: (target, offset, count) => predict_skill_rolls(origin.baseSeed, target.weaponType, target.attributeForce, origin.skillCounter + offset, 54, count),
});

self.onmessage = async ({ data }) => {
  try {
    await initWasm();
    if (data.kind === "finishes") {
      const result = await finishOptions(data.route, data.stream, data.targetId, providerFor(data.route.origin));
      self.postMessage({ type: "finishes", ...result });
    } else if (data.kind === "recalc") {
      self.postMessage({ type: "recalculated", route: await recalcWithFinish(data.route, data.stream, data.targetId, data.option, providerFor(data.route.origin)) });
    } else if (data.kind === "pin") {
      self.postMessage({ type: "pinned", route: pinFinish(data.route, data.stream, data.targetId, data.option, providerFor(data.route.origin)) });
    } else {
      const request = data.request;
      const routes = await planWeapons(request, providerFor(request.origin), (progress) => self.postMessage({ type: "progress", ...progress }), { preservePinsByMode: data.preservePinsByMode });
      self.postMessage({ type: "done", routes });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
