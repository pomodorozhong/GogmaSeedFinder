# Handoff

## In progress

### codex/weapon-planner-ui

- Task: preserve the existing eight-tab planner UI and features while making its structure easier to review. The user rejected the five flow previews and explicitly chose the fork Pages deployment at `d243015` (app code `4b66dbe`) as the baseline.
- Code checkpoint: `e003c0c` — `fix(web): isolate planner state and restore acquisition guides`, following refactor `32b840f`. The review fixes are committed; the accompanying `docs:` commit updates this handoff and the implementation guide. The user requested pushing this branch on 2026-11-05 and explicitly requested no PR.
- Current state: `planner-editor-state.js` owns raw goal fields; validated weapons are derived for browsing and saving. Copy and filter edits update the draft before projecting controls, and invalid chip edits are transactional. `planner-route-session.js` owns route search, compatibility, bookmarks and saved-step progress; `planner-route-view.js` renders snapshots and measures the guide and tables. Route and finish searches own independent workers and errors. External position changes stop obsolete finish work. The acquisition guide now imports its category dependency and uses the shared category-to-stat helper. Matching still writes only a bookmark; explicit saved-step confirmation rechecks and advances only its own Gogma stream.
- Scope and tradeoff: the existing eight-tab UI, save/export format and Rust/WASM APIs are preserved. The main planner UI is 332 lines; the additional draft, session and view modules make ownership explicit. This is not a claim of reduced total source size or complete SOLID compliance. DOM adapters and views still use browser metadata directly.
- Verification: on 2026-11-05, `npm install`, `npm run check` (syntax plus ESLint `no-undef`), all 110 tests, `npm run build`, and `git diff --check` passed again before committing. Committed source `e003c0c` also passed check, all 110 tests and build in a detached checkout, reusing dependencies only after confirming identical manifests and lockfiles. Ten new DOM integration tests use real-WASM route/finish data and injected worker failures to cover all step rendering in three languages, both stream save orders, bookmark-only matching, rejected save confirmations, draft validation/copy/duplication, saved picks, status values and independent search failure/cancellation/retry. On 2026-11-04 a disposable comparison matched all 51 normalized route-step DOM snapshots against `d243015`, across both modes and three languages; a real-browser preview built a route with the tracked WASM, rendered all five acquisition slots and reported no browser errors or warnings. The second review found no remaining actionable issues in these changed paths. The previous checkpoint's broader screenshot, import/export and forecast checks were not rerun in full after this follow-up; its acquisition rendering gap is now covered by a durable test. Temporary comparison files, screenshots and dependencies are excluded from commits.
- Remaining validation: real-phone memory/performance at large roll limits and independent in-game Keep Bonuses/skill sequences. Rust tests/clippy were not run because Rust and the tracked WASM package are unchanged. Preserve honest complexity-limit and alternative-coverage labels.
- PR and issue: none for this branch on either fork or upstream, verified 2026-11-05. No PR is to be created for this push, per the user's instruction. P-02 remains deferred and blocks issue-backed tracking only.
- Publication: destination `fork/codex/weapon-planner-ui`, authorized by the user on 2026-11-05. The remote checkpoint before this push was `24c452f`. A web push triggers fork Pages deployment; inspect Actions if the live build lags. Fork default `main` is `c5511dc`; upstream `origin/main` is `65789e9`, verified 2026-11-05.
- Preservation: rejected flow previews remain in local stash `19c972a`; earlier layout experiments are in `830384a`. The original local per-weapon skill editor remains in stash `pre-planner-ui local weapon and skill changes`. These stashes are local backups, not required to resume the refactor. Keep the old skill-editor branch until the user decides whether that editor should return as separate work.
- Resume: read [the implementation guide and dependency map](docs/weapon-planner.md#reviewing-the-implementation), then `npm install` and `npm run serve`; open `http://127.0.0.1:4341/#planner`. Browser weapons, seed/counters and bookmarks are local data. Disposable comparison servers were stopped; build output, dependencies and local preview settings are excluded from commits.
- Next action: continue representative in-game validation of Keep Bonuses and skill sequences, then measure planner memory and responsiveness on a real phone. Issue filing remains deferred; no PR was requested.
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
  > Status: implemented on `codex/weapon-planner-ui` (fork), based on upstream `65789e9`, with 110 passing JavaScript/WASM and DOM integration tests, including plan export/import, choosing and sorting other finishes without extra rolls, preserving compatible manual finishes after a goal change, acquisition-guide rendering, and independent search lifecycles. Live planner validation remains pending. The existing engine's independent in-game verification of Keep Bonuses and skills remains a separate validation item.

## Ranked work

1. Validate representative Keep Bonuses and skill sequences against actual game draws, including weapon switches, filler draws, and saved G/S snapshots; retain the experimental scope until verified.
2. Measure planner responsiveness and memory on a real phone at large roll limits and multiple selected weapons; preserve cancellation and honest complexity-limit labels.
3. Continue the existing seed-search counter-range presets/additional-observation work in [the roadmap](docs/ROADMAP.md) when returning to the broader search flow.

## Pending

No requests outside the active branch. P-02 belongs to `codex/weapon-planner-ui` above.
