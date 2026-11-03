import { pl } from "./planner-text.js";
import { MAX_SELECTED } from "./planner-model.js";

export const errorText = (key) => pl(({ targets: "Select between 1 and {max} weapons.", state: "Enter a known base seed and the counters for the streams you want to plan.", limits: "Enter whole-number roll limits from 0 to 10,000.", goals: "Enable at least one goal per weapon and enter a stat minimum or skill pair.", statusValues: "Enter both status boost values before using a status minimum.", excluded: "Excluding these stats leaves too few bonuses to fill five slots.", minAboveMax: "A minimum is higher than its maximum." })[key] ?? "Unable to calculate the guide. {detail}", { detail: key, max: MAX_SELECTED });

// A stopped search may still have messages queued. Detach its handlers before
// termination so a late result cannot overwrite a newer search.
export function createPlannerWorker(onMessage, onError) {
  const worker = new Worker(new URL("./planner-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "error") onError(errorText(data.message));
    else onMessage(data);
  };
  worker.onerror = ({ message }) => onError(pl("Unable to calculate the guide. {detail}", { detail: message }));
  return worker;
}

export function terminatePlannerWorker(worker) {
  if (!worker) return;
  worker.onmessage = worker.onerror = null;
  worker.terminate();
}
