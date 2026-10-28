# Multi-weapon planner

The **Weapon planner** tab uses the existing WebAssembly predictions to build
bonus and skill instructions for up to 100 independently selected weapons.
Weapon profiles, including duplicate weapons, are shared with the advanced
forecasting tabs. Existing profiles receive editable initial goals; these are
starting points, not build recommendations. **Add weapon** opens the goal editor
on a new, unsaved weapon with the weapon type and element chosen at its top (a
different type or element restarts the goals); Cancel discards it. **Duplicate**
opens the same editor with a weapon's type, element and goals so the element can
be changed first, and **Copy goals from** fills the goal editor from another
weapon. A copy never
takes the source's current bonuses, skills or Keep layout; element goals carry
over only when the gains match, since status gains are entered per weapon.

## Goals and counters

Enter **gains from the five reinforcement slots**, not final weapon
stats. Unspecified stats, and stats with a minimum of 0, do not affect matching
and are not shown in goals or result totals. Attack uses unbloated raw;
affinity uses percentage points. Element gains depend on weapon type. Sharpness
and bowgun capacity use separate fields and units. EX counts do not rank results.

Each stat goal is a range per tier: a minimum and a maximum, where a blank side
is unbounded and a minimum of 0 reads as no bound. A maximum of 0 allows no gain
in that stat; status tiers entered as +0 can still fill slots. A tier may hold
only maximums. An unknown status value proves neither a positive minimum nor a
maximum, so a positive status bound needs the II/EX values; minimum 0 and maximum
0 do not.
Max-0 stats must leave enough valid tiers to fill five slots, and a minimum may
not exceed its maximum. Unknown current
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

Known current bonuses can prove a goal is already met. Known categories,
including partially entered layouts, can prove ranges that hold for every valid
completion without supplying exact current gains. A complete ordered category
layout can also seed Keep Bonuses predictions. Incomplete layouts require a
Reset before Keep. Adopting a row in the
forecast tabs or editing the counters by hand does not change a weapon's current
bonuses, skill or layout, so update them in the goal editor after rolling outside
the planner. Status II/EX values must be entered from the actual weapon before
using a positive status minimum or maximum; elemental deltas are not silently
applied to status weapons.

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
candidate or scheduling budget runs out before an optional weapon is checked,
it is left out as "not checked" rather than reported as a conflict, since it
may have fit. A required weapon whose feasibility remains uncertain is retained
for the final search; a required goal without a verified feasible schedule
keeps the route incomplete.

When weapons compete for the same positions, the planner explores combinations
of displaced weapons and offers up to four distinct alternative routes in a
picker before the first step is saved. Required weapons retain priority over
optional weapons. Failed or duplicate attempts do not consume the four-route
display limit. The picker warns when its display or search limits leave other
alternatives unchecked; this does not change whether a displayed route's
minimum is proven.

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
Reaching a bound can hide a shorter route or a feasible additional weapon.
Alternative discovery has a separate shared scheduling budget per stream and
route mode, plus a limit of 500 priority combinations to check. It retains
earlier choices while testing further displaced weapons, so independent
conflicts can be combined in one alternative. Reaching its budget or the
four-alternative display limit is reported separately from the minimum proof.
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

## Saving finish alternatives

Each Stage 1 weapon card owns a **Saved picks** collection, with separate
bonus and skill lists. The weapon editing modal has **Goals** and **Finishes**
tabs. The pencil opens Goals; **Browse finishes** on a card or guide opens
Finishes in the same modal. The cards retain their existing summaries.

Both tabs share a draft. Goals contains the existing stat bounds, skill pairs,
and current-weapon fields. Finishes searches using those draft goals and lets
the player choose the bonus or skill stream, an inclusive From/To roll range,
filter chips, and ordered sorting chips. Roll positions are relative to the
current saved stream counter. The range limits finish positions; Keep
acquisitions before the range are still considered and displayed. Browsing
ranges do not change Stage 2's route limits.

Each result shows its roll, action, gains or skill pair, and any Reset needed
for a Keep layout. A bookmark **Save pick** control toggles it in the draft
(the gold star still means only top desired). A **Saved picks** section
retains every saved option, including those hidden by the current range or
filters, each with the same warnings as the weapon card. A result the current
route finishes on is marked **Used in current route**, separately from whether
it is saved. Filter chips can narrow by top desired, saved picks, action,
whether an earlier Reset is needed, stat bounds, or series/group skills.
These filters never rewrite the weapon's goals or remove hidden saved picks.
The draft goal's own stat bounds (and a series or group every acceptable
skill pair shares) start as filter chips, using the loosest bound the
acceptable tiers share so they hide nothing the goal allows. Narrow or remove
them to inspect results; a later goal edit resets only the chips whose goal
bound changed. Because the search itself covers only results meeting the
goal, widening a chip beyond the goal shows nothing more.
Changed goals or a changed saved position mark old search results as stale;
search again before adding picks from those results.

**Save weapon** (or **Add weapon**) commits the goals and saved picks together.
Switching tabs preserves their draft; Cancel, Escape, or closing the modal
discards its edits. Merely browsing or changing sorting without changing the
weapon keeps an existing built route. A separate **Build guides** applies
saved changes; editing, saving picks, and saving the weapon never automatically reroute or
advance the saved counters.

For each weapon and enabled stream, a nonempty saved collection restricts the
route to one of those alternatives that meets the route's goal. With no saved
picks for that stream, the planner searches automatic results as before.
The scheduler can switch between the saved alternatives to avoid conflicts
with other weapons. It does not require every saved result to be performed.
A proven minimum under these constraints is labelled **Minimum proven with
saved picks**. Top-desired mode still requires its own goal, so an
acceptable-only collection may produce a complete acceptable route and an
incomplete top-desired route.

The card shows the saved results and marks the one **Used in current route**,
with any earlier Reset the route takes for it.
Goal edits and adding or removing other weapons keep the collections.
Incompatible picks remain visible with their reason, such as a changed seed,
an unmet goal, a passed roll, or a roll beyond the limit. A build that cannot
use a saved collection names the affected weapon and stream. It never
silently substitutes an automatic result or deletes the collection. Add more
options, adjust the goals or limits, or explicitly remove picks; removing the
last pick restores automatic selection. Existing weapon-selection and
optional-weapon rules still apply, and any omitted weapon is named.

Collections are stored in `target.planner.savedFinishes` alongside the goals,
independently of generated routes, and are included in plan exports. Each pick
records the seed, original stream counter and relative roll, weapon kind,
action, ordered Keep layout, and exact result. The engine rebases its roll to
the current stream counter on rebuild. A passed pick counts as already met
only when the weapon's known current result is that saved result; matching a
preview alone cannot establish this. Copying goals and duplicating weapons
keep the destination's own collection. Old route-only pins migrate once into
the owning weapon's collection on load or import, without reviving picks
explicitly cleared afterward.

The browser lists 50 results at a time with **Show more finishes**. Equal
results at different rolls or with different required layouts remain separate
options because their scheduling constraints differ. Candidate-budget
exhaustion is reported and does not prove that no other finishes exist.

The list's default sort follows the weapon's bonus goal: top desired first,
then each stat with a minimum from high to low (top-desired tier first), then
each stat with a maximum above 0 from low to high. A stat either goal excludes
(max 0) is left out; skill lists sort by top desired. Roll position is not a
sort option: it always applies last, so finishes that tie on every sort level
appear in order of their earliest roll. Sort levels show as chips in one row:
**＋ Sort** opens a menu of the unused fields (any stat, top desired, "No Reset
needed") and adds a chip, clicking a chip reverses its order, and × removes it.
A changed sort is remembered for that weapon in this browser.

## Moving a plan to another computer

**Export plan** in the saved-position strip downloads a JSON file
(`gogma-planner-B<seed>-G<bonus>-S<skill>.json`) holding the base seed and both
Gogma counters, every registered weapon with its goals, saved finish alternatives, known current results
and Keep layout, and the planner's selection, roll limits, built routes, chosen
route, matches and saved-step progress. **Import plan** on another browser asks
for confirmation, then replaces that browser's weapons, saved position and
planner progress, so the guide resumes at the same step. A file that is not a
planner export (format `gogma-weapon-planner`, version 1) is rejected without
changing anything. Base Artian counters and forecast-tab settings are not
included.

## Validation and data

`npm test` covers stat equivalence, separate units, stat ranges and exclusion,
Keep-layout pruning, Any skill pairs, ordered layout scheduling, conflicting
acquisitions, duplicate weapons, optional weapons and alternative routes, free
top-desired upgrades, zero limits, budget exhaustion, goal preservation, and real
WASM replay. Regressions cover large candidate merges, uncertain exclusions
after candidate truncation, zero Status minimums with unknown gains, partially
known layouts, zero-gain status slots, and combined conflict alternatives.
Short-stream minimum proofs are also
compared against independent exhaustive Reset/Keep/weapon action simulation.
Deterministic mixed-event cases check minimum horizons and free upgrades against
every event assignment. Dual-stream WASM cases enumerate every weapon subset
and its actions to check both route minima and the full set of conflict alternatives
within the display limit.
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
