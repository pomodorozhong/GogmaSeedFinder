# Gogma Seed Finder

This is a static browser app backed by a Rust/WASM RNG engine. Browser modules,
styles, and translations live in `web/`; Rust sources and golden fixtures live
in `crates/` and `tests/fixtures/`. Start with `docs/README.md` for architecture
and the planner's behavior.

## Development checks

- Use `npm install` to install local web tooling, then `npm run check`, `npm test`, and `npm run build` for UI changes.
- Run `npm run serve` for the loopback-only preview at `http://127.0.0.1:4341`. The app needs HTTP for modules, workers, and WASM.
- UI-only changes use the tracked `web/pkg` package. Rebuild WASM only when Rust APIs change.
- For Rust changes, run `cargo test --workspace --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`; report an unavailable toolchain rather than claiming these ran.
- Keep build output, browser state, screenshots, and dependency folders out of commits.
- Preserve independent Gogma bonus/skill counters and separate base Artian counters. A reference-result match must never update saved counters; only explicit confirmation of a saved game step may do so.

<!-- handoff:start (from the handoff skill; edit the skill's template, not this copy) -->
## Handoff

`HANDOFF.md` at the repository root is how sessions resume. It has three sections: `In progress` (one `### <branch>` subsection per active branch, holding its state and its own approval requests), `Ranked work`, and `Pending` (approval requests not tied to a branch). A pending entry, such as `P-01`, records a request, not approval.

- **Start of a session:** read `HANDOFF.md` and the subsection for `git branch --show-current`; none means this branch has no work in progress. Compare its code checkpoint with `git log`, re-check verification made stale by later commits, and run the documented checks before building on it. If this branch's PR merged or closed, follow the `commit` skill's branch-safety rules before committing or pushing. Before recommending or starting work, show each unresolved request that existing authorization doesn't cover, from every branch subsection and `Pending` (marking any a merged or closed PR made obsolete), and each blocking decision in `Ranked work`, and ask the user about them. Pick new work from the default branch's `Ranked work`.
- **Edit only this branch's subsection,** plus `Ranked work` and `Pending` when they actually change. Keep it current rather than a log, and never write secrets.
- **Commit `HANDOFF.md`** only before a push and at wrap-up, as a `docs:` commit on the work branch. Never commit it on the default branch.
- **PRs:** use the `open-pr` skill, and keep its unanswered approval requests in this branch's subsection until they are resolved. **End of a session:** use the `handoff` skill.
- **Before creating a branch, editing `HANDOFF.md`, or resolving a conflict in it,** read the `handoff` skill's working rules (`references/working-rules.md` in that skill).
<!-- handoff:end -->
