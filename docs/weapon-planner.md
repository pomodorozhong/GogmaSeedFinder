# Multi-weapon planner

The **Weapon planner** tab uses the existing WebAssembly predictions to build
bonus and skill instructions for up to 100 independently selected weapons.
Weapon profiles, including duplicate weapons, are shared with the advanced
forecasting tabs. Existing profiles receive editable initial goals; these are
starting points, not build recommendations. **Duplicate** opens the add form with
a weapon's type, element and goals so the element can be changed first, and
**Copy goals from** fills the goal editor from another weapon. A copy never
takes the source's current bonuses, skills or Keep layout; element goals carry
over only when the gains match, since status gains are entered per weapon.

## Goals and counters

Enter **gains from the five reinforcement slots**, not final weapon
stats. Unspecified stats, and stats with a minimum of 0, do not affect matching
and are not shown in goals or result totals. Attack uses unbloated raw;
affinity uses percentage points. Element gains depend on weapon type. Sharpness
and bowgun capacity use separate fields and units. EX counts do not rank results.

Each stat goal is a range per tier: a minimum and a maximum, where a blank side
is unbounded and a minimum of 0 reads as no bound. A maximum of 0 excludes the
stat, leaving the five slots to the others. A tier may hold only maximums. An
unknown status value proves neither bound, so a status maximum above 0 needs
the II/EX values; max 0 does not. Max-0 stats must leave enough categories to
fill five slots, and a minimum may not exceed its maximum. Unknown current
bonuses need no roll only when every valid result meets the goal. This includes
maximums at the physical stat limits, ranges guaranteed by known categories,
and alternative tiers that together accept every possible result. Keep layouts
are pruned only when no tier choice within the fixed categories could fit the
range. Saves from an earlier draft that excluded stats load as max 0 in both
tiers. Each stat row lists the gain of every roll tier and the most five slots
can reach (no bonus repeats more than twice; sharpness and capacity fill at most
two slots), and inputs are capped at that maximum.

Each weapon has acceptable and top-desired stat ranges and alternative skill
pairs. Every specified stat in a tier must lie within its range; any skill pair in a
tier can match. Each reroll gives one series and one group skill, and a pair
matches only when both match; either side can be **Any** to accept one skill on
its own. An **Any series / Any group** goal needs no skill roll, even when the
current skills are unknown; alternatives covering every pair work the same way.
A top-desired result also satisfies the acceptable route. An
empty top-desired tier falls back to the acceptable tier. Disable bonuses or
skills when that part of a weapon does not need more work.

Known current bonuses can prove a goal is already met. An ordered category
layout can seed Keep Bonuses predictions and prove ranges that hold for every
valid choice of tiers, without supplying exact current gains. Unknown layouts
require a Reset before Keep. Adopting a row in the
forecast tabs or editing the counters by hand does not change a weapon's current
bonuses, skill or layout, so update them in the goal editor after rolling outside
the planner. Status II/EX values must be
entered from the actual weapon before using a status minimum or a status maximum
above 0; elemental deltas
are not silently applied to status weapons.

The bonus and skill roll limits are independent windows of 0–10,000 draws from
the saved G and S counters. A shared base seed is required. A counter may remain
unknown when that entire stream is disabled. Counter overflow is rejected.

## Optional weapons and conflicts

A weapon marked **Optional** is left out of a route when its goal cannot be
reached within the roll limits or when it needs roll positions that other
weapons use. Required weapons always take priority over optional ones; within
each group, weapons earlier in the list keep their place. A left-out weapon is
removed from both streams, so each weapon is checked against both streams
together before it is left out; the route names it with the reason. If the
search budget runs out before an optional weapon is checked, it is left out as
"not checked" rather than reported as a conflict, since it may have fit. A required
weapon that cannot reach its goal at all still makes the route incomplete.

When weapons compete for the same positions, the planner also builds up to four
alternative routes, each giving priority to one displaced weapon, and offers
them as a picker before the first step is saved.

## Search and replay

The worker considers direct Reset finishes, Keep finishes from a known ordered
layout, and a Reset acquisition followed by a Keep finish. For a weapon's final
bonus result, all actions before its last category-changing Reset are fillers;
later Keep draws do not change its categories. Consequently, at most an
acquisition event and a finish event per weapon need reserved positions. This
reduction retains every ordered layout found in the requested Reset window,
without imposing a fixed category composition as a goal.

Scheduling reserves distinct positions across weapons, including acquisition
events. It searches the smallest feasible bonus horizon. Skills use bipartite
matching between weapons and distinct matching positions to find their smallest
horizon. The streams are independent, so the sum of their minima minimizes the
total number of rerolls. Weapon switches and material costs are not weighted.
Unused positions are filled on a weapon whose corresponding stream is still
unfinished. A finished bonus or skill is never overwritten in that stream.

Among schedules of the minimum length, the acceptable route prefers top-desired
finishes: positions up to the horizon are rolled anyway, so such an upgrade is
free. Weapons are upgraded greedily in list order, on a separate budget that
never changes the total or whether the minimum is proven. A weapon that already
finishes top desired keeps that finish when later weapons are upgraded. A weapon that already
meets its acceptable goal can be upgraded the same way.

The scheduling search has a 200,000-node complexity budget per route, plus a
cap on candidates scanned so that large selections stay bounded in time. Candidate
collection retains at most 200,000 finishes per bonus tier and weapon. A feasible
route is marked **Best found** if either budget prevents proving the minimum;
an unsuccessful incomplete search is not reported as proof that no route exists.
Roll limits remain the user-facing search bounds. Cancellation terminates the
worker; any completed alternative remains available.

Every chosen action is replayed through the real predictor, using the exact
current ordered layout for Keep. Replay verifies final goal matches and produces
every intermediate result plus the before/after counters for each block. The UI
only offers execution controls for a complete route.

## Following the guide

Bonus (G) and skill (S) steps are shown as two tables because they use separate
counters; step numbers stay in route order. Each table keeps its own progress,
so bonus and skill steps can be saved in either order: saving a step checks and
advances only its own counter. The guide sits to the left of the tables on
desktop. Clicking a route row
previews its full repeat block; the attached chevron points to that row. On narrow
screens the guide stacks above the horizontally scrollable tables.

Click the expected result that matches the game to record progress within a
block. This only marks a place in the reference list. It does not complete the
step or change saved counters. Future previews have a **Back to current step**
control; only each table's current row has a checkbox. Saved rows have a
checkmark.

Upgrading a weapon to Gogma uses exactly one roll of the shared skill counter.
If every weapon in the route is upgraded during the session, the upgrades take
S1 through S<N>, where N is the number of weapons the route finishes. When a
skill target falls in that range, the skill table and guide warn to do it
before upgrading.

Use the specified weapon and menu action, accept each result, and save in game
after the block. **Done & saved** explicitly confirms that work and applies the
predicted G/S snapshot to the shared app state. The saved weapon's known result
and ordered layout are updated too. The tool does not interact with the game or
independently verify that the player performed these actions.

Goals, routes, matches and confirmed progress persist in browser storage. A
changed seed, counters, selected weapon, goal, or known layout blocks further
confirmations on an incompatible route. When goals, weapons or limits change
after a build, the old route is hidden behind a warning, even after a reload,
so it cannot be mistaken for a current result. Build new guides from the current saved
state to change a route already in progress. State-code formats are unchanged.

## Validation and data

`npm test` covers stat equivalence, separate units, stat ranges and exclusion,
Keep-layout pruning, Any skill pairs, ordered layout scheduling, conflicting
acquisitions, duplicate weapons, optional weapons and alternative routes, free
top-desired upgrades, zero limits, budget exhaustion, goal preservation, and real
WASM replay. Short-stream minimum proofs are also
compared against independent exhaustive Reset/Keep/weapon action simulation.
All planner copy has Japanese, English, and Traditional Chinese coverage.

Attack, affinity, sharpness and capacity values are documented in Masuku's
[Gogmazios weapon investigation](https://lescarnetsdelawycademie.fr/gogmazios-weapons/).
The weapon-specific elemental II/EX table is recorded in the
[Gogma Artian weapon data](https://www.monsterhunterwiki.org/wiki/Gogma_Artian_Weapons_(MHWilds)#Gogma_Artian_weapons).
Prediction probabilities and category/tier caps remain owned by `rng-core` and
its existing in-game fixtures. No RNG tables from the visual mockup are used.

Serve the static app with `npm install` followed by `npm run serve`
(`http://127.0.0.1:4341`). `npm run build` produces a static `dist/` directory,
using the same module layout as the existing Pages deployment. No Rust rebuild
is needed for these UI modules; the tracked WASM package is used directly.
