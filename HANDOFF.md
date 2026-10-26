# Handoff

## In progress

### codex/weapon-planner-ui

- Task: replace manual table comparison with a guided multi-weapon bonus/skill planner. Local task; no primary issue yet (see P-02).
- PR: none. No open, closed, or merged PR exists for this branch on the fork or upstream.
- Code checkpoint: `8305597` — `fix(web): preserve weapon status gains when copying goals`.
- Base: local `main`, `origin/main`, and upstream `apeshinzo78/GogmaSeedFinder:main` are `65789e9`; remote heads and the absence of branch PRs were checked on 2026-10-26. `fork` is `pomodorozhong/GogmaSeedFinder`; its `main` is `0545af0`.
- Publication: the remote `fork/codex/weapon-planner-ui` remains at `a9dbecb` (checked on 2026-10-26). The seven source fixes after it and the handoff updates are local only; another computer cannot retrieve them yet. Publishing these commits awaits P-03. Opening a PR needs separate authorization and a choice of base repository.
- State: both findings from the follow-up planner review are fixed and committed; implementation awaits live planner validation. Three new regression tests failed before the fixes and pass afterwards. The user authorized atomic local commits and explicitly kept P-02/P-03 pending. The latest fixes are separate commits:
  - `519aa9a`: derive Keep-layout bounds from actual known gains in either II/EX order, retaining the reported two-roll route and known zero-gain finishes when the other tier is unknown.
  - `8305597`: preserve the destination's status values when copying goals across weapon types, including unsaved values in its open editor.
- Scope: the planner remains tab **08** with Guide as the default and Skill Forecast matching upstream. Adopting forecast rows does not change planner current results or Keep layouts; users update them in the goal editor after rolling elsewhere. Preserve the planner-only scope and the existing limited shared integration described in [the weapon planner](docs/weapon-planner.md).
- Verification at `8305597`: `npm run check`, `npm test` (**68** JavaScript/WASM tests), `npm run build`, and `git diff --check` passed. Both source commits were checked independently in temporary detached worktrees: **67** tests at `519aa9a` and **68** at `8305597`; both also passed syntax checks and builds, and the temporary worktrees were removed. A temporary review script matched **2,000** randomized real WASM short-stream exhaustive action searches, including reversed status gains, for minimum horizons and list-order top-desired finishes. The preceding review matched another 1,500 WASM cases and 6,000 synthetic scheduling cases (2,000 with restricted budgets). These extra scripts are temporary, not committed test tooling.
- Limits: no exhaustive mismatch was found within the tested bounds; this is not a general proof beyond the search/candidate budgets. Bounds can omit a shorter route or a feasible additional weapon, so preserve honest "Best found", "not checked", and incomplete-required-goal behavior.
- Checks not run this session: Rust tests/clippy (Rust and `web/pkg` unchanged), a fresh browser walk-through, real-phone performance, or independent in-game Keep Bonuses/skill validation. Earlier browser load checks passed, but the live-game and phone checks remain outstanding.
- Uncommitted work: no tracked source edits remain. `.claude/launch.json` remains an unrelated untracked local preview configuration and was excluded from the commits.
- Resume: `npm install`, then `npm run serve`; open `http://127.0.0.1:4341/#planner`. Browser-origin weapons, seed/counters and progress are local data, not source defaults.
- Next action: validate a representative route in the live planner (tab 08) with the user's weapons, including independent G/S saves and an already-met goal, before deciding whether to open a PR and against which repository. Keep issue filing and publication pending.
- Durable design/algorithm details: [weapon planner](docs/weapon-planner.md); [documentation index](docs/README.md).
- Preservation: stash `pre-planner-ui local weapon and skill changes` still holds the original local per-weapon skill editor, which is now removed from this branch. The old `codex/fix-dynamic-status-i18n` branch was not deleted. Keep both until the user decides whether that editor should return as separate work.
- Avoid: changing non-planner tabs on this branch; syncing planner state from forecast-tab adoption (the user rejected both a page-4 layout clear and a planner-side "unconfirmed layout" prompt as confusing); ranking or matching by EX count (a stat maximum, including max 0, is allowed); collapsing distinct weapon instances; marking a matched result as saved; updating counters on previews; claiming optimality after the complexity budget is exhausted; mixing base Artian counters with Gogma G/S counters.

Pending requests for this branch:

- **P-02 — Choose an issue destination and file the draft below. Deferred at the user's request on 2026-10-26.** The fork has issues disabled; this is a repository setting, not an authentication or network failure. Choose either an issue-enabled fork or the upstream repository, then authorize filing. Proposed label: `enhancement`; milestone: none. Blocks: issue-backed tracking/branch linkage only; review and testing can proceed. Do not enable issues, file upstream, or create labels without the necessary authorization.

  Proposed title: **Add guided multi-weapon bonus and skill planning**

  Proposed body:

  > Comparing separate bonus and skill forecast tables requires players to manually choose weapons, count filler rolls, and remember where to use Reset Bonuses versus Keep Bonuses. Add a planner tab that turns per-weapon goals into a full route.
  >
  > Allow up to 100 selected weapon instances, with acceptable and top-desired stat ranges (min/max, max 0 excludes a stat) and alternative series/group skill pairs (either side may be Any). Judge bonus results by accumulated gains, ignore unspecified stats, and keep affinity, element/status, sharpness, and capacity in their own units. EX count must not determine whether a result meets a goal.
  >
  > Generate acceptable and top-desired routes from the existing WASM predictors, using independent bonus/skill roll windows. Schedule useful Reset acquisitions and Keep finishes across weapons, take free top-desired upgrades, leave out optional weapons that cannot fit (with a route per competing choice), and distinguish a proven minimum from the best route found before a complexity limit.
  >
  > Show bonus and skill step tables beside a compact guide with every intermediate result. Persist matching progress separately from explicit done-and-saved confirmation; only the latter updates the shared counters, and bonus and skill steps may be saved in either order.
  >
  > Add it as tab 08 without changing the existing tabs, forecasts, weapon profiles, base Artian tools, or the three UI languages. Cover stat equivalence, distinct weapon instances, conflicting acquisitions, zero limits, route replay, save consistency, and optimality against exhaustive short-stream action search.
  >
  > Status: implemented on `codex/weapon-planner-ui`, based on upstream `65789e9`, with 68 passing JavaScript/WASM tests. Code review fixes are committed locally through `8305597`; publication and live planner validation remain pending. The existing engine's independent in-game verification of Keep Bonuses and skills remains a separate validation item.

- **P-03 — Authorize pushing the completed branch to the fork.** Proposed action: push `codex/weapon-planner-ui` to `fork` (`pomodorozhong/GogmaSeedFinder`), publishing the seven local source fixes after `a9dbecb` and the handoff documentation commits. The user authorized local commits and explicitly kept this publication request pending. Blocks: retrieving the fixes and updated handoff from another computer. This request does not cover opening or merging a PR.

## Ranked work

1. Validate representative Keep Bonuses and skill sequences against actual game draws, including weapon switches, filler draws, and saved G/S snapshots; retain the experimental scope until verified.
2. Measure planner responsiveness and memory on a real phone at large roll limits and multiple selected weapons; preserve cancellation and honest complexity-limit labels.
3. Continue the existing seed-search counter-range presets/additional-observation work in [the roadmap](docs/ROADMAP.md) when returning to the broader search flow.

## Pending

No requests outside the active branch. P-02 and P-03 belong to `codex/weapon-planner-ui` above.
