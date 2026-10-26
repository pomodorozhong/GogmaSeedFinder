# Handoff

## In progress

### codex/weapon-planner-ui

- Task: replace manual table comparison with a guided multi-weapon bonus/skill planner. Local task; no primary issue yet (see P-02).
- PR: none. No open, closed, or merged PR exists for this branch on the fork or upstream.
- Code checkpoint: `b3456f2` — `feat(web): choose another finish for a weapon without extra rolls`.
- Base: local `main`, `origin/main`, and upstream `apeshinzo78/GogmaSeedFinder:main` are `65789e9`; remote heads and the absence of branch PRs were checked on 2026-10-26. `fork` is `pomodorozhong/GogmaSeedFinder`; its `main` is `0545af0`.
- Publication: pushed to `fork/codex/weapon-planner-ui` with this handoff on 2026-10-26 (P-03 approved by the user). Opening a PR needs separate authorization and a choice of base repository.
- State: implementation complete and awaiting review and live validation. Since the previous push (`a9dbecb`) the branch gained:
  - Review and path-completeness fixes from another session (`744ff49`…`1edede9`), including zero-roll proofs with partial layouts, zero-gain status tiers, retained unreachable required weapons, and combined route alternatives (up to four, with a coverage warning).
  - `6d75596`: **Export plan / Import plan** in the planner's position strip. The JSON file (format `gogma-weapon-planner`, version 1) carries the seed and G/S counters, all registered weapons, and the planner's selection, limits, routes, matches and saved steps. Import confirms, validates the position before changing anything, and resumes at the same step. Base Artian counters and forecast-tab settings are not included.
  - `b3456f2`: **Other finishes (no extra rolls)** on a weapon's finish step. It lists every result that keeps the stream's roll count (top desired first, identical results deduplicated). Choosing one rebuilds the route with that finish pinned (`route.pins`). Other weapons keep their finishes when possible, otherwise the option names them; top-desired and earlier pinned finishes are never lost. Allowed only before any step of that stream is saved; Build guides discards pins. Motivation: every result meeting a tier counts the same, so the route took a dragon great sword's G27 Reset/G28 Keep (Affinity +6) over a free G36 Keep (Affinity +10). The user rejected raising the goal (it would exclude higher-Attack results) and chose this over automatic stat ranking.
- Verification at `b3456f2`: `npm run check`, `npm test` (**80** JavaScript/WASM tests), `npm run build`, and `git diff --check` passed. Browser (in-app, user's 10-weapon data): export → import round trip identical; import into cleared storage restored 11 weapons, 10 selected, position and route; a wrong file is rejected unchanged; buttons fit at 375px. Finish chooser listed 89 alternatives for the dragon great sword in about 0.5 s; choosing G36 kept 451 rolls and changed no other weapon. The user's browser route now uses that G36 pin.
- Scope: the planner remains tab **08** with Guide as the default and Skill Forecast matching upstream. Adopting forecast rows does not change planner current results or Keep layouts; users update them in the goal editor after rolling elsewhere. Preserve the planner-only scope and the existing limited shared integration described in [the weapon planner](docs/weapon-planner.md).
- Verification at `1edede9`: `npm run check`, `npm test` (**76** JavaScript/WASM tests), `npm run build`, and `git diff --check` passed. All three commits were checked independently in a temporary detached worktree: **70** tests at `567d34b`, **71** at `db0be78`, and **76** at `1edede9`; each also passed syntax checks and builds. The temporary worktree was removed. Five targeted new tests failed before implementation; the protective negative case already passed. The four original temporary review repros now all pass. A temporary independent action-search script also matched **3,000** mode comparisons across **1,500** randomized two-/three-weapon real-WASM scenarios after the fixes. These temporary scripts are not committed test tooling; the new durable coverage is in `web/planner.test.mjs`.
- Limits: no exhaustive mismatch was found within the tested bounds; this is not a general proof beyond the search/candidate budgets. Bounds can omit a shorter route or a feasible additional weapon, so preserve honest "Best found", "not checked", and incomplete-required-goal behavior. The four-alternative display cap and alternative-discovery budgets can leave further combinations unchecked; preserve the separate alternative-coverage warning.
- Checks not run: Rust tests/clippy (Rust and `web/pkg` unchanged), real-phone performance, finish-chooser speed with very large roll limits, and independent in-game Keep Bonuses/skill validation.
- Uncommitted work: none. `.claude/launch.json` is an unrelated untracked local preview configuration and must stay excluded from commits.
- Resume: `npm install`, then `npm run serve`; open `http://127.0.0.1:4341/#planner`. Browser-origin weapons, seed/counters and progress are local data, not source defaults.
- Next action: follow the user's route in game (tab 08), including independent G/S saves, and try Export/Import on the other computer; then decide whether to open a PR and against which repository. Keep issue filing pending.
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
  > Status: implemented on `codex/weapon-planner-ui` (fork), based on upstream `65789e9`, with 80 passing JavaScript/WASM tests, including plan export/import and choosing another finish without extra rolls. Live planner validation remains pending. The existing engine's independent in-game verification of Keep Bonuses and skills remains a separate validation item.

## Ranked work

1. Validate representative Keep Bonuses and skill sequences against actual game draws, including weapon switches, filler draws, and saved G/S snapshots; retain the experimental scope until verified.
2. Measure planner responsiveness and memory on a real phone at large roll limits and multiple selected weapons; preserve cancellation and honest complexity-limit labels.
3. Continue the existing seed-search counter-range presets/additional-observation work in [the roadmap](docs/ROADMAP.md) when returning to the broader search flow.

## Pending

No requests outside the active branch. P-02 belongs to `codex/weapon-planner-ui` above.
