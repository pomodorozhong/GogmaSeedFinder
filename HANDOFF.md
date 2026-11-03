# Handoff

## In progress

### codex/weapon-planner-ui

- Task: preserve the existing eight-tab planner UI and features while making its structure easier to review. The user rejected the five flow previews and explicitly chose the fork Pages deployment at `d243015` (app code `4b66dbe`) as the baseline.
- Code checkpoint: `32b840f` — `refactor(web): separate planner editing and shared state rules`. The source extractions and their callers are one refactor commit. The accompanying docs commit records this handoff and the implementation guide.
- Current state: the main planner delegates Goals and Finishes to one weapon editor with one draft. Its controller owns draft validation, filters, saved picks and the finish worker. The finish view renders those results. Both search and display receive the same active filters. Shared modules own weapon profiles, Gogma positions, row progress, result formatting, worker setup and Reset/Keep traversal. Matching a reference result writes only a bookmark; explicit saved-step confirmation rechecks and advances only its own Gogma stream.
- Scope and tradeoff: no UI redesign or Rust API change. The main planner UI is 606 lines, down from 1,065 in the deployed baseline. All production browser JavaScript totals 242 more lines and 401 more bytes than the baseline, with more explicit ownership. This is improved separation rather than a claim of complete SOLID compliance. The form, finish view and controller still use browser DOM and metadata directly.
- Verification at wrap-up (2026-11-03): `npm install`, `npm run check`, all 100 tests, `npm run build`, and `git diff --check` passed. The committed source also passed syntax checks, all 100 tests and build in a fresh detached checkout. The session's final browser comparison against `d243015` passed all 68 disposable checkpoints and all 18 screenshots byte for byte across three planner sizes/languages. Cases covered both save orders, matches, export/import, shared-tab CSVs, draft save/cancel, invalid goal rollback, stream switches, paginated picks, and overlapping route/finish errors, cancellation and retry. Earlier paired checks matched 80 real-WASM runs for candidate/route order, results, progress and predictor calls. Browser checks were performed before wrap-up; source has not changed since them.
- Remaining validation: real-phone memory/performance at large roll limits and independent in-game Keep Bonuses/skill sequences. Rust tests/clippy were not run because Rust and the tracked WASM package are unchanged. Preserve honest complexity-limit and alternative-coverage labels.
- PR and issue: none for this branch on either fork or upstream, verified 2026-11-03. P-02 remains deferred and blocks issue-backed tracking only. Opening a PR still requires its own authorization and a base-repository choice.
- Publication: pushing this work branch to `fork/codex/weapon-planner-ui` is pre-authorized. The remote checkpoint before this wrap-up was `d243015`. A web push triggers fork Pages deployment; inspect Actions if the live build lags. Fork default `main` is `c5511dc`; upstream `origin/main` is `65789e9`, verified 2026-11-03.
- Preservation: rejected flow previews remain in local stash `19c972a`; earlier layout experiments are in `830384a`. The original local per-weapon skill editor remains in stash `pre-planner-ui local weapon and skill changes`. These stashes are local backups, not required to resume the refactor. Keep the old skill-editor branch until the user decides whether that editor should return as separate work.
- Resume: read [the implementation guide and dependency map](docs/weapon-planner.md#reviewing-the-implementation), then `npm install` and `npm run serve`; open `http://127.0.0.1:4341/#planner`. Browser weapons, seed/counters and bookmarks are local data. Disposable comparison servers were stopped; build output, dependencies and local preview settings are excluded from commits.
- Next action: review `32b840f` against the eight-tab fork baseline, then continue representative in-game validation. Issue filing and PR publication remain deferred.
- Avoid: redesigning this UI without a new request; syncing planner current results from forecast adoption; collapsing weapon instances; ranking goals by EX count; advancing counters on a reference match; mixing base Artian and Gogma counters; claiming optimality after a search budget is exhausted.

Pending requests for this branch:

- **P-02 — Choose an issue destination and file the draft below. Deferred at the user's request on 2026-10-28.** The fork has issues disabled; this is a repository setting, not an authentication or network failure. Choose either an issue-enabled fork or the upstream repository, then authorize filing. Proposed label: `enhancement`; milestone: none. Blocks: issue-backed tracking/branch linkage only; review and testing can proceed. Do not enable issues, file upstream, or create labels without the necessary authorization.

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
  > Status: implemented on `codex/weapon-planner-ui` (fork), based on upstream `65789e9`, with 100 passing JavaScript/WASM tests, including plan export/import, choosing and sorting other finishes without extra rolls, and preserving compatible manual finishes after a goal change. Live planner validation remains pending. The existing engine's independent in-game verification of Keep Bonuses and skills remains a separate validation item.

## Ranked work

1. Validate representative Keep Bonuses and skill sequences against actual game draws, including weapon switches, filler draws, and saved G/S snapshots; retain the experimental scope until verified.
2. Measure planner responsiveness and memory on a real phone at large roll limits and multiple selected weapons; preserve cancellation and honest complexity-limit labels.
3. Continue the existing seed-search counter-range presets/additional-observation work in [the roadmap](docs/ROADMAP.md) when returning to the broader search flow.

## Pending

No requests outside the active branch. P-02 belongs to `codex/weapon-planner-ui` above.
