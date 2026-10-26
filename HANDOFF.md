# Handoff

## In progress

### codex/weapon-planner-ui

- Task: replace manual table comparison with a guided multi-weapon bonus/skill planner. Local task; no primary issue yet (see P-02).
- PR: none. No open, closed, or merged PR exists for this branch on the fork or upstream.
- Code checkpoint: `f1c703f` — `fix(web): ignore zero status minimums when gains are unknown`.
- Base: local `main`, `origin/main`, and upstream `apeshinzo78/GogmaSeedFinder:main` are `65789e9`; remote heads and the absence of branch PRs were checked on 2026-10-26. `fork` is `pomodorozhong/GogmaSeedFinder`; its `main` is `0545af0`.
- Publication: the remote `fork/codex/weapon-planner-ui` remains at `a9dbecb`. The five fixes after it and this wrap-up's documentation commit are local only; another computer cannot retrieve them yet. Publishing these commits awaits P-03. Opening a PR needs separate authorization and a choice of base repository.
- State: the code review and its three findings are resolved; implementation awaits live planner validation. The user asked to commit the existing edits first, then fix the findings and commit again. Independent changes were saved as five atomic commits:
  - `744ff49`: prove zero-roll bonus goals across valid tier combinations and known categories, and recognize unrestricted skill goals without inventing a current result.
  - `986f469`: retain an unreachable required weapon even when it also conflicts in the other stream, so a partial route cannot be reported complete.
  - `37a8207`: merge up to 200,000 top-desired candidates without overflowing JavaScript's function argument limit; retain an already-met acceptable goal.
  - `ebeea3e`: treat failed schedules from truncated candidates as uncertain, mark optional exclusions "not checked", and retain uncertain required weapons. A complete skill stream can still prove a conflict.
  - `f1c703f`: treat Status minimum 0 like a blank minimum during validation, current-result proofs, and Keep-layout pruning; preserve positive bounds and maximum 0. A real one-roll Keep path remains available with unknown Status II/EX gains.
- Scope: the planner remains tab **08** with Guide as the default and Skill Forecast matching upstream. Adopting forecast rows does not change planner current results or Keep layouts; users update them in the goal editor after rolling elsewhere. Preserve the planner-only scope and the existing limited shared integration described in [the weapon planner](docs/weapon-planner.md).
- Verification at `f1c703f`: `npm run check`, `npm test` (**65** JavaScript/WASM tests), `npm run build`, and `git diff --check` passed. Each of the five commits was checked independently in a temporary detached worktree; the final tested tree matched the final source commit, and that temporary worktree was removed. Review-only scripts additionally matched 1,500 real WASM short-stream exhaustive action searches and 5,000 exhaustive synthetic scheduling cases; these extra scripts were temporary, not committed test tooling.
- Limits: no exhaustive mismatch was found within the tested bounds; this is not a general proof beyond the search/candidate budgets. Bounds can omit a shorter route or a feasible additional weapon, so preserve honest "Best found", "not checked", and incomplete-required-goal behavior.
- Checks not run this session: Rust tests/clippy (Rust and `web/pkg` unchanged), a fresh browser walk-through, real-phone performance, or independent in-game Keep Bonuses/skill validation. Earlier browser load checks passed, but the live-game and phone checks remain outstanding.
- Uncommitted work: no tracked source edits remain. `.claude/launch.json` is an existing untracked local preview configuration and was deliberately excluded from the commits.
- Resume: `npm install`, then `npm run serve`; open `http://127.0.0.1:4341/#planner`. Browser-origin weapons, seed/counters and progress are local data, not source defaults.
- Next action: validate a representative route in the live planner (tab 08) with the user's weapons, including independent G/S saves and an already-met goal, before deciding whether to open a PR and against which repository.
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
  > Status: implemented on `codex/weapon-planner-ui`, based on upstream `65789e9`, with 65 passing JavaScript/WASM tests. Code review fixes are committed locally through `f1c703f`; publication and live planner validation remain pending. The existing engine's independent in-game verification of Keep Bonuses and skills remains a separate validation item.

- **P-03 — Authorize pushing the completed branch to the fork.** Proposed action: push `codex/weapon-planner-ui` to `fork` (`pomodorozhong/GogmaSeedFinder`), publishing the five local fixes after `a9dbecb` and the documentation commit for this wrap-up. The user authorized local commits; publishing these new commits has not been authorized. Blocks: retrieving the fixes and updated handoff from another computer. This request does not cover opening or merging a PR.

## Ranked work

1. Validate representative Keep Bonuses and skill sequences against actual game draws, including weapon switches, filler draws, and saved G/S snapshots; retain the experimental scope until verified.
2. Measure planner responsiveness and memory on a real phone at large roll limits and multiple selected weapons; preserve cancellation and honest complexity-limit labels.
3. Continue the existing seed-search counter-range presets/additional-observation work in [the roadmap](docs/ROADMAP.md) when returning to the broader search flow.

## Pending

No requests outside the active branch. P-02 and P-03 belong to `codex/weapon-planner-ui` above.
