import { actionName, bonusGoalText, categoryStat, esc, goalFor, html, resultMarkup, skillPairsText, statName, stateCode, tierName, weaponName } from "./planner-markup.js";
import { BONUS_CATEGORY, hasGoal, normalizedPlanner, routePosition } from "./planner-model.js";
import { pl } from "./planner-text.js";

// Renders route snapshots and owns DOM measurement. Execution state and worker
// lifecycle stay in the route session.
export function createRouteView(root, { metadata, savedPickRow }) {
  const q = (selector) => root.querySelector(selector);
  const nameOf = (target) => weaponName(target, metadata);
  let state = null;
  let pointerFrame = null;
  function badge(step) {
    const quality = step.rolls.at(-1).quality;
    if (step.intent === "finish") return `<span class="pl-badge pl-${quality}">${quality === "preferred" ? "★" : "✓"} ${esc(tierName(quality))}</span>`;
    return `<span class="pl-badge pl-neutral">${html(step.intent === "acquire" ? "Layout acquired" : "Advance")}</span>`;
  }
  const droppedNames = (route) => (route.dropped ?? []).map(({ id, reason, optional }) => `${nameOf(route.targets.find((v) => v.id === id))} (${pl(({ unreachable: "no match within the roll limits", unchecked: "not checked: search limit reached" })[reason] ?? "needs the same rolls as another weapon")}${optional ? ` · ${pl("optional")}` : ""})`).join(", ");
  const shortNames = (route, reason = null) => (route.dropped ?? []).filter((v) => !reason || v.reason === reason).map(({ id }) => nameOf(route.targets.find((v) => v.id === id))).join(", ");
  // Upgrading a weapon to Gogma uses exactly one roll of the shared skill
  // counter. If every weapon in the route is upgraded this session, upgrades
  // take S1 through S<weapons>, so a skill target there needs a warning.
  function upgradeWarning(r, steps) {
    const weapons = r.targets.length - (r.dropped?.length ?? 0);
    if (!steps.some((step) => step.stream === "skill" && step.intent === "finish" && step.end <= weapons)) return "";
    const text = weapons === 1 ? pl("The skill target is the very next skill roll (S1). Upgrading a weapon to Gogma also uses a skill roll, so do this step before upgrading any weapon, or the upgrade takes the target.")
      : pl("A skill target is within S1–S{n}. Each weapon upgraded to Gogma uses one skill roll, so upgrading this route's {n} weapons can take it. Do skill targets in that range before upgrading.", { n: weapons });
    return `<p class="pl-route-note is-warning">${esc(text)}</p>`;
  }
  // What each route mode searches for, shown under its total.
  const routeRules = (mode) => `<span class="pl-route-rules">${(mode === "preferred"
    ? ["Every weapon must reach its top desired goal. A weapon with no top desired goal uses its acceptable goal.", "It searches the same two streams, so it usually needs more rerolls than the fastest route.", "Optional weapons that cannot fit are left out and named with the reason."]
    : ["Every weapon only needs to reach its acceptable goal.", "Bonus and skill rolls are separate streams, so the route is the shortest bonus window plus the shortest skill window.", "Rolls that happen anyway upgrade weapons toward top desired at no extra cost, in list order."]).concat(["Saved picks are alternatives: the route chooses one per stream. Automatic results are used only when no picks are saved."]).map((rule) => `<span>${html(rule)}</span>`).join("")}</span>`;
  function renderRoutes(snapshot) {
    state = snapshot;
    const modes = ["acceptable", "preferred"];
    const hasRoutes = modes.some((mode) => state.routes[mode]);
    q("#pl-results").hidden = !hasRoutes; q("#pl-detail").hidden = !hasRoutes;
    if (!hasRoutes) { q("#pl-rows").replaceChildren(); q("#pl-guide").replaceChildren(); return; }
    const r = state.route;
    // Goals, weapons or limits changed after the build (invalidate clears the
    // signature). An old route must not look like a current answer.
    const outdated = state.outdated;
    q("#pl-routes").classList.toggle("is-outdated", outdated);
    q("#pl-routes").innerHTML = modes.map((mode) => {
      const data = state.routes[mode];
      if (!data) return `<div class="pl-route is-pending"><strong>${html(mode === "preferred" ? "Top desired route" : "Fastest acceptable")}</strong><p class="pl-muted">…</p></div>`;
      const incomplete = data.bonus.status === "incomplete" || data.skill.status === "incomplete";
      const saved = data.targets.some((target) => ["bonus", "skill"].some((stream) => hasGoal(target, stream) && target.planner.savedFinishes?.[stream]?.length));
      return `<button type="button" class="pl-route" data-pl-route="${mode}" aria-pressed="${state.mode === mode}"${state.totalDone > 0 && state.mode !== mode ? " disabled" : ""}><div class="pl-route-title"><span class="pl-radio" aria-hidden="true"></span><strong>${html(mode === "preferred" ? "Top desired route" : "Fastest acceptable")}</strong></div><div class="pl-route-total"><strong>${data.total === null ? "—" : data.total}</strong><span>${html(data.complete ? "rolls" : incomplete ? "Search incomplete" : "No complete route")}</span></div><p class="pl-muted">${data.complete ? html("{bonus} bonus + {skill} skill", { bonus: data.bonus.horizon, skill: data.skill.horizon }) : html("Increase the roll limits or relax your goals.")}</p>${data.complete && data.dropped?.length ? `<p class="pl-drop-note">${html("Leaves out {n}: {names}", { n: data.dropped.length, names: shortNames(data) })}</p>` : ""}${routeRules(mode)}<div class="pl-route-bottom"><span>${html(data.complete ? data.proven ? saved ? "Minimum proven with saved picks" : "Minimum proven" : "Best found" : incomplete ? "Search incomplete" : "No complete route")}</span><span>${html("Within your roll limits")}</span></div></button>`;
    }).join("");
    if (!r) return;
    const ok = state.compatible;
    let note = "";
    if (outdated) {
      q("#pl-route-note").textContent = pl("Your goals, weapons or limits changed after this route was built. Build new guides to see an updated route.");
      q("#pl-route-note").className = "pl-route-note is-warning";
      for (const id of ["#pl-alternatives", "#pl-workspace", "#pl-detail-heading", "#pl-route-complete"]) q(id).hidden = true;
      return;
    }
    if (!ok) note = pl("Position or weapons changed. Build new guides before saving more steps.");
    else if (state.totalDone > 0 && state.totalDone < r.steps.length) note = pl("This route is in progress. Build new guides from your saved position to change routes.");
    else if (!r.proven && r.complete) note = pl("The search reached its complexity budget. A shorter route may exist within these roll limits.");
    if (!r.complete) {
      const streamErrors = [["bonus", "Bonus goals not completed"], ["skill", "Skill goals not completed"]].filter(([stream]) => r[stream].status !== "complete").map(([stream, label]) => `${pl(label)}: ${r[stream].missing.length ? r[stream].missing.map((id) => nameOf(r.targets.find((v) => v.id === id))).join(", ") : pl(r[stream].status === "incomplete" ? "Search incomplete" : "Conflicting roll positions")}`);
      note = streamErrors.join(" · ");
      if (!r.proven) note += ` ${pl("The search reached its complexity budget. A shorter route may exist within these roll limits.")}`;
    }
    if (r.complete && r.dropped?.length) note = [pl("Left out of this route: {names}", { names: droppedNames(r) }), note].filter(Boolean).join(" · ");
    if (r.savedConflicts?.length) note = [pl("No route found using saved picks for: {names}. Add more saved options, remove a pick, or adjust the goals or roll limits. Your picks are kept.", { names: r.savedConflicts.map(({ id, stream }) => `${nameOf(r.targets.find((target) => target.id === id))} (${pl(stream === "bonus" ? "Bonus rolls" : "Skill rolls")})`).join(", ") }), note].filter(Boolean).join(" · ");
    if (r.alternativesComplete === false && state.totalDone === 0) note = [note, pl("More alternative routes may exist within these roll limits.")].filter(Boolean).join(" · ");
    q("#pl-route-note").textContent = note;
    const choices = r.complete && r.alternatives?.length && state.totalDone === 0 && ok ? [r, ...r.alternatives] : [];
    q("#pl-alternatives").hidden = !choices.length;
    q("#pl-alternatives").innerHTML = choices.length ? `<p>${html("Some weapons need the same rolls. Choose which route to follow:")}</p>${choices.map((choice, index) => `<button type="button" class="pl-alternative" data-pl-alt="${index}" aria-pressed="${index === 0}"><span class="pl-radio" aria-hidden="true"></span><span><strong>${html("{rolls} rolls", { rolls: choice.total })}</strong> · ${esc(shortNames(choice, "conflict") ? pl("leaves out {names}", { names: shortNames(choice, "conflict") }) : pl("finishes every weapon"))}</span></button>`).join("")}` : "";
    q("#pl-route-note").className = note ? `pl-route-note${!ok || !r.complete || r.dropped?.length || r.savedConflicts?.length ? " is-warning" : ""}` : "";
    q("#pl-workspace").hidden = !r.complete || r.steps.length === 0;
    q("#pl-detail-heading").hidden = !r.complete || r.steps.length === 0;
    q("#pl-saved-count").textContent = pl("{done} of {total} steps saved", { done: state.totalDone, total: r.steps.length });
    const done = r.complete && (r.steps.length === 0 || state.totalDone === r.steps.length);
    q("#pl-route-complete").hidden = !done;
    q("#pl-route-complete").textContent = done ? `✓ ${r.dropped?.length ? pl("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : pl(r.steps.length ? "Route complete. All chosen goals are met." : "Your current weapons already meet this route’s goals.")}` : "";
    if (!r.complete || !r.steps.length) return;
    const progress = state.progress;
    const row = ({ step, index, saved, current }) => {
      const target = r.targets.find((v) => v.id === step.targetId);
      const prefix = step.stream === "bonus" ? "G" : "S";
      const other = step.stream === "bonus" ? "skill" : "bonus";
      const otherDone = progress.finishedIn(other, step.targetId) ? (other === "bonus" ? pl("Bonus steps done") : pl("Skill steps done")) : "";
      return `<tr data-pl-step="${index}" tabindex="0" class="${state.inspected === index ? "is-inspected " : ""}${current ? "is-current " : ""}${saved ? "is-saved" : ""}" aria-label="${esc(`${pl("Step {n} of {total}", { n: index + 1, total: r.steps.length })}: ${nameOf(target)}, ${actionName(step.action)}${otherDone ? `, ${otherDone}` : ""}`)}"><td class="pl-saved-cell">${saved ? `<span class="pl-saved-check" aria-label="${html("Saved")}">✓</span>` : current ? `<input type="checkbox" data-pl-done="${index}" aria-label="${html("Done & saved")}"${!ok || state.busy ? " disabled" : ""}>` : ""}</td><td><strong class="pl-roll-range">${prefix}${step.start}${step.end !== step.start ? `–${step.end}` : ""}</strong><small>× ${step.rolls.length}</small></td><td><strong class="pl-table-weapon">${esc(nameOf(target))}${otherDone ? ` <span class="pl-other-done" title="${esc(otherDone)}">✓ ${other === "bonus" ? "G" : "S"}</span>` : ""}</strong><span class="pl-table-action">${esc(actionName(step.action))}</span>${badge(step)}</td><td>${resultMarkup(step.rolls.at(-1), step.stream, target, metadata)}</td></tr>`;
    };
    // Bonus (G) and skill (S) steps use separate counters, so each gets its own
    // table and its own progress; either can be saved first.
    q("#pl-rows").innerHTML = [["bonus", "Bonus steps", "Bonus gains"], ["skill", "Skill steps", "Skills"]].map(([stream, title, result]) => {
      const rows = progress.tables[stream];
      const warning = stream === "skill" ? upgradeWarning(r, rows.map(({ step }) => step)) : "";
      return rows.length ? `<section class="pl-stream-table"><h4 class="pl-stream-title">${html(title)} <span>${stream === "bonus" ? "G" : "S"} · ${html("{done} of {total} steps saved", { done: state.completed[stream], total: rows.length })}</span></h4>${warning}<div class="pl-table-scroll"><table class="pl-route-table"><thead><tr><th>${html("Saved")}</th><th>${html("Rolls")}</th><th>${html("Weapon & action")}</th><th>${html(result)}</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div></section>` : "";
    }).join("");
    alignTables(); renderGuide(state);
  }
  // Each table sizes its columns to its content; every column then takes the
  // widest width either table needs so the two read as one grid.
  let aligned = false;
  function alignTables() {
    const heads = [...root.querySelectorAll(".pl-route-table")].map((table) => [...table.querySelectorAll("thead th")]);
    for (const row of heads) for (const th of row) th.style.width = "";
    aligned = false;
    if (heads.length < 2 || !heads.every((row) => row[0].getBoundingClientRect().width > 0)) return;
    aligned = true;
    const widths = heads[0].map((_, column) => Math.max(...heads.map((row) => row[column]?.getBoundingClientRect().width ?? 0)));
    for (const row of heads) row.forEach((th, column) => { th.style.width = `${Math.ceil(widths[column])}px`; });
  }
  // The other stream's counter depends on how far that stream has been saved.
  const stepState = (r, step, side) => ({ ...routePosition(r, state.completed), [`${step.stream}Counter`]: step[side][`${step.stream}Counter`] });
  function renderGuide(snapshot) {
    state = snapshot;
    const progress = state.progress, ok = state.compatible;
    const r = state.route;
    const { step, current, saved } = progress.rows[state.inspected];
    const target = r.targets.find((v) => v.id === step.targetId);
    const matched = Math.max(0, Math.min(step.rolls.length, Number(state.matches[state.inspected]) || 0));
    const prefix = step.stream === "bonus" ? "G" : "S";
    const description = step.intent === "acquire" ? "Acquire this ordered layout for a later Keep Bonuses step." : step.intent === "advance" ? "Advance the shared counter on this weapon to reach the next useful result." : "";
    const goalMode = step.intent === "finish" && step.rolls.at(-1).quality === "preferred" ? "preferred" : r.mode;
    q("#pl-guide").innerHTML = `<button type="button" class="pl-guide-pointer" data-pl-action="show-row" aria-hidden="true" tabindex="-1"></button><div class="pl-guide-content"><div class="pl-guide-kicker"><span>${html(saved ? "Saved" : current ? "Current step" : "Preview")}</span><span>${html("Step {n} of {total}", { n: state.inspected + 1, total: r.steps.length })}</span></div><div class="pl-guide-heading"><div><h3>${esc(nameOf(target))}</h3><p class="pl-menu-action">${esc(actionName(step.action))} <span>${prefix}${step.start}${step.end === step.start ? "" : `–${step.end}`}</span></p></div><span class="pl-repeat">× <strong>${step.rolls.length}</strong></span></div>${step.stream === "skill" ? upgradeWarning(r, [step]) : ""}<div class="pl-guide-goalblock"><span class="pl-guide-label">${html(step.intent === "acquire" ? "Layout" : "Goal")}</span>${step.intent === "acquire" ? `<ol class="pl-guide-slots" aria-label="${html("Layout")}">${step.rolls.at(-1).raw.map((id, index) => `<li><small>${index + 1}</small>${esc(statName(categoryStat(BONUS_CATEGORY[id], target), target))}</li>`).join("")}</ol>` : `<p class="pl-guide-goal">${esc(step.stream === "bonus" ? bonusGoalText(target, goalMode) : skillPairsText(goalFor(target, goalMode, "skill"), metadata))}</p>`}${description ? `<p class="pl-guide-purpose">${html(description)}</p>` : ""}</div>${finishMarkup(r, step, ok)}
      <div class="pl-reference-heading"><h4>${html("Expected rolls")}</h4></div><p class="pl-fine pl-reference-note">${html("Use the exact weapon and action above. Match your in-game result to find your place.")}</p><div class="pl-expected-list">${step.rolls.map((roll, index) => {
        const tag = current && ok ? "button" : "div";
        return `<${tag}${tag === "button" ? ` type="button" data-pl-match="${index + 1}" aria-label="${html("Match draw {n}", { n: index + 1 })}" aria-pressed="${matched === index + 1}"` : ""} class="pl-expected-roll${index < matched && current ? " is-passed" : ""}${index + 1 === matched && current ? " is-matched" : ""}"><span class="pl-draw-number"><strong>${index + 1}</strong><small>${prefix}${roll.offset}</small></span><span class="pl-draw-result">${resultMarkup(roll, step.stream, target, metadata)}${step.intent !== "advance" && index === step.rolls.length - 1 ? badge(step) : ""}</span>${current && matched === index + 1 ? '<span class="pl-match-check">✓</span>' : ""}</${tag}>`;
      }).join("")}</div>
      <footer class="pl-guide-footer">${current ? `<div><strong>${html("{matched}/{total} matched · {remaining} remaining", { matched, total: step.rolls.length, remaining: step.rolls.length - matched })}</strong><button type="button" class="primary" data-pl-action="done"${!ok || state.busy ? " disabled" : ""}>${html("Done & saved")} →</button></div><p class="pl-fine">${html("Finish this block and save in game, then confirm here. Matching a result only marks your place; it never saves a step or advances the counters.")}</p>` : state.totalDone < r.steps.length ? `<button type="button" class="secondary" data-pl-action="current">← ${html("Back to current step")}</button>` : `<span class="pl-teal">✓ ${r.dropped?.length ? html("Route complete. Weapons left out: {names}", { names: shortNames(r) }) : html("Route complete. All chosen goals are met.")}</span>`}</footer><details class="pl-state-details"><summary>${html("Saved state details")}</summary><p>${html("Before")} <code>${esc(stateCode(stepState(r, step, "before")))}</code></p><p>${html("After")} <code>${esc(stateCode(stepState(r, step, "after")))}</code></p></details></div>`;
    schedulePointer();
  }
  // A weapon's finish can be swapped for any other that keeps the stream's
  // roll count, until a step in that stream is saved.
  function finishMarkup(r, step, ok) {
    if (step.intent !== "finish" || !r.complete || state.busy || !ok || state.completed[step.stream] !== 0) return "";
    const raw = state.registered.find((target) => target.id === step.targetId);
    const target = raw ? { ...raw, planner: normalizedPlanner(raw) } : null;
    const picks = target?.planner.savedFinishes?.[step.stream] ?? [];
    const text = !picks.length ? pl("Automatic — no saved picks") : target.planner.routePick?.[step.stream] ? pl("The route uses the pick you chose.")
      : picks.length > 1 ? pl("The route uses one of this weapon's {n} saved picks. Choose one to use it instead.", { n: picks.length }) : pl("The route uses this weapon's saved pick.");
    const rows = picks.length > 1 ? `<ul class="pl-saved-picks">${picks.map((pick) => savedPickRow(target, step.stream, pick, `data-pl-action="remove-pick" data-id="${esc(target.id)}" data-stream="${step.stream}"`, `data-pl-action="route-pick" data-rebuild="true" data-id="${esc(target.id)}" data-stream="${step.stream}"`)).join("")}</ul>` : "";
    const prefix = step.stream === "bonus" ? "G" : "S";
    return `<div class="pl-finish-card"><div class="pl-finish-card-top"><div><span class="pl-guide-label pl-gold">${html("Finish")}</span><div class="pl-finish-value">${prefix}${step.rolls.at(-1).offset} ${badge(step)}</div></div><button type="button" class="pl-finish-toggle" data-pl-action="finishes">${html("Browse finishes")}</button></div><p class="pl-finish-sub">${esc(text)}</p>${rows}</div>`;
  }

  function schedulePointer() {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = null;
      const row = q(`[data-pl-step="${state?.inspected}"]`);
      const guide = q("#pl-guide");
      root.style.setProperty("--pl-sticky-top", `${(document.querySelector(".app-tabs")?.getBoundingClientRect().height ?? 80) + 12}px`);
      if (!row || !guide || q("#pl-workspace").hidden) return;
      const rr = row.getBoundingClientRect(); const gr = guide.getBoundingClientRect();
      // The guide sticks while the table scrolls, so the arrow follows the row.
      // When the row is out of reach the arrow clamps to the guide's top or
      // bottom edge as an up/down button that scrolls back to it.
      const y = rr.top + rr.height / 2 - gr.top;
      const edge = y < 18 ? "up" : y > gr.height - 18 ? "down" : "";
      guide.style.setProperty("--pl-pointer-y", `${Math.max(18, Math.min(gr.height - 18, y))}px`);
      const pointer = guide.querySelector(".pl-guide-pointer");
      if (!pointer) return;
      pointer.classList.toggle("is-edge", Boolean(edge));
      pointer.textContent = edge === "up" ? "▲" : edge === "down" ? "▼" : "";
      pointer.tabIndex = edge ? 0 : -1;
      if (edge) { pointer.removeAttribute("aria-hidden"); pointer.setAttribute("aria-label", pl("Show the current step in the table")); pointer.title = pl("Show the current step in the table"); }
      else { pointer.setAttribute("aria-hidden", "true"); pointer.removeAttribute("aria-label"); pointer.removeAttribute("title"); }
    });
  }
  // Tables measured while the tab was hidden are aligned once they show.
  const observer = new ResizeObserver(() => { if (!aligned) alignTables(); schedulePointer(); });
  observer.observe(q("#pl-workspace")); observer.observe(q("#pl-guide")); observer.observe(q("#pl-rows"));
  window.addEventListener("resize", schedulePointer);
  window.addEventListener("scroll", schedulePointer, { passive: true });
  document.fonts?.ready.then(schedulePointer);
  return { render: renderRoutes, renderGuide, schedulePointer };
}
