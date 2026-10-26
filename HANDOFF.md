# Handoff

## In progress

### codex/weapon-planner-ui

- Task: replace manual table comparison with a guided multi-weapon bonus/skill planner. Local task; no primary issue yet (see P-02).
- PR: none. No open, closed, or merged PR exists for this branch on the fork or upstream.
- Code checkpoint: `6b16af7` — `refactor(web): leave planner weapon state alone when forecast rows are adopted`.
- Base: local `main` and `origin/main` (upstream `apeshinzo78/GogmaSeedFinder`) are `65789e9`, freshly fetched at wrap-up. `fork` is `pomodorozhong/GogmaSeedFinder`.
- Publication: the branch is pushed to `fork` with this handoff. Opening a PR needs separate authorization and a choice of base repository.
- State: implementation complete and awaiting user review. The latest work fixed three planner correctness bugs from a code review (cross-stream weapon exclusion, keeping earlier top-desired finishes during upgrades, per-tier zero-roll proof; `2c4e699`, `4cbc37c`, `6804dff`). It also limited the branch to the planner page (`450b407`, `3004382`, `6b16af7`):
  - Skill Forecast (tab 05) is back to upstream. The earlier local per-weapon combination editor, editable cards, targets-only view and CSV export were removed.
  - The planner is tab **08**, after 07. The app opens on 01 Guide again; `#planner` links still work.
  - Adopting a Bonus/Skill Forecast row no longer touches planner state or stored Keep layouts. Users update a weapon's current state in the planner goal editor after rolling elsewhere (documented in `docs/weapon-planner.md`).
  - Outside the planner, shared files only add the tab button/view and stylesheet link, the 8-column tab bar, the tab label translation, per-weapon skill presets stored as target data (the planner's default skill goals), page 2's "この構成でEX厳選へ" recording that weapon's bonuses, and a state-change event.
- Verification at `6b16af7`: `npm run check`, `npm test` (50 JavaScript/WASM tests), `npm run build`, and `git diff --check` passed. Each of the three fix commits passed the same checks on its own in a detached worktree. Browser: tab order 01–08 with Guide as default, upstream page 5 layout, page 4 and the planner load with no console errors.
- Checks not run: Rust tests/clippy (`cargo` not installed; Rust and `web/pkg` unchanged). No fresh full planner walk-through in the browser after the scope reduction; only load/render checks. Independent in-game verification of Keep Bonuses and skill predictions remains an inherited limitation.
- Resume: `npm install`, then `npm run serve`; open `http://127.0.0.1:4341/#planner`. Browser-origin weapons, seed/counters and progress are local data, not source defaults.
- Next action: review the live planner (tab 08) with the user's desired weapons, then decide whether to open a PR and against which repository.
- Durable design/algorithm details: [weapon planner](docs/weapon-planner.md); [documentation index](docs/README.md).
- Preservation: stash `pre-planner-ui local weapon and skill changes` still holds the original local per-weapon skill editor, which is now removed from this branch. The old `codex/fix-dynamic-status-i18n` branch was not deleted. Keep both until the user decides whether that editor should return as separate work.
- Avoid: changing non-planner tabs on this branch; syncing planner state from forecast-tab adoption (the user rejected both a page-4 layout clear and a planner-side "unconfirmed layout" prompt as confusing); ranking or matching by EX count (a stat maximum, including max 0, is allowed); collapsing distinct weapon instances; marking a matched result as saved; updating counters on previews; claiming optimality after the complexity budget is exhausted; mixing base Artian counters with Gogma G/S counters.

Pending requests for this branch:

- **P-02 — Choose an issue destination and file the draft below.** The fork has issues disabled; this is a repository setting, not an authentication or network failure. Choose either an issue-enabled fork or the upstream repository, then authorize filing. Proposed label: `enhancement`; milestone: none. Blocks: issue-backed tracking/branch linkage only; review and testing can proceed. Do not enable issues, file upstream, or create labels without the necessary authorization.

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
  > Status: implemented on `codex/weapon-planner-ui` (fork), based on upstream `65789e9`, with 50 passing JavaScript/WASM tests. Awaiting user review. The existing engine's independent in-game verification of Keep Bonuses and skills remains a separate validation item.

## Ranked work

1. Validate representative Keep Bonuses and skill sequences against actual game draws, including weapon switches, filler draws, and saved G/S snapshots; retain the experimental scope until verified.
2. Measure planner responsiveness and memory on a real phone at large roll limits and multiple selected weapons; preserve cancellation and honest complexity-limit labels.
3. Continue the existing seed-search counter-range presets/additional-observation work in [the roadmap](docs/ROADMAP.md) when returning to the broader search flow.

## Pending

No requests outside the active branch. P-02 belongs to `codex/weapon-planner-ui` above.
