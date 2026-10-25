import initWasm, { predict_gogma_rolls, predict_gogma_keep_rolls, predict_skill_rolls } from "./pkg/gogma_wasm_search.js";
import { planWeapons } from "./planner-engine.js";

self.onmessage = async ({ data }) => {
  try {
    await initWasm();
    const request = data.request;
    const provider = {
      reset: (target, offset, count) => predict_gogma_rolls(request.origin.baseSeed, target.weaponType, target.attributeForce, request.origin.bonusCounter + offset, 35, count),
      keep: (target, offset, count, layout) => predict_gogma_keep_rolls(request.origin.baseSeed, target.weaponType, target.attributeForce, request.origin.bonusCounter + offset, 35, count, Uint8Array.from(layout)),
      skills: (target, offset, count) => predict_skill_rolls(request.origin.baseSeed, target.weaponType, target.attributeForce, request.origin.skillCounter + offset, 54, count),
    };
    const routes = await planWeapons(request, provider, (progress) => self.postMessage({ type: "progress", ...progress }));
    self.postMessage({ type: "done", routes });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
