import { t } from "./i18n.js";
import { pl } from "./planner-text.js";
import { actionName, esc, html, pairOptions, resultMarkup, skillPairsText, statName, weaponName } from "./planner-markup.js";
import { availableStats, finishSortKeys, finishOptionMatches, savedFinishId, sortFinishOptions } from "./planner-model.js";

const BOOKMARK = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 2.5h8v11l-4-3-4 3z"/></svg>`;

function sortBar(target, stream, levels, open) {
  const sortName = (key) => key === "top" ? pl("Top desired") : key === "direct" ? pl("No Reset needed") : statName(key, target);
  const unused = finishSortKeys(stream, target).filter((key) => !levels.some((level) => level.key === key));
  const chips = levels.map(({ key, dir }, index) => {
    const name = sortName(key), n = index + 1;
    const direction = pl(dir === "desc" ? "High first" : "Low first");
    return `<span class="pl-sort-chip"><button type="button" data-pl-action="sort-flip" data-index="${index}" aria-label="${html("Sort level {n}: {name}, {direction}. Click to reverse.", { n, name, direction })}">${esc(name)} ${dir === "desc" ? "↓" : "↑"}</button><button type="button" class="pl-sort-remove" data-pl-action="sort-remove" data-index="${index}" aria-label="${html("Remove sort level {n}", { n })}">×</button></span>`;
  }).join("");
  const menu = open ? `<div class="pl-sort-menu" data-browser-menu>${unused.map((key) => `<button type="button" data-pl-action="sort-pick" data-key="${key}">${esc(sortName(key))}</button>`).join("")}</div>` : "";
  const add = unused.length ? `<button type="button" class="pl-sort-add" data-pl-action="sort-menu" aria-haspopup="true" aria-expanded="${open}">＋ ${html("Sort")}</button>` : "";
  return `<div class="pl-sort"><span class="pl-sort-label">${html("Sort")}</span><div class="pl-sort-row">${chips}${add}</div>${menu}</div>`;
}

const filterNames = {
  top: "Top desired only", saved: "Saved picks only", direct: "No Reset needed", action: "Action",
  series: "Series skill", group: "Group skill", pair: "Add combination",
};
const filterName = (key, target) => Object.hasOwn(filterNames, key) ? pl(filterNames[key]) : statName(key, target);

function filterLabel(filter, target, metadata) {
  const { key, value, min, max } = filter;
  if (key === "action") return actionName(value);
  if (key === "series") return t(metadata.series[value]);
  if (key === "group") return t(metadata.groups[value]);
  if (key === "pair") return skillPairsText([filter], metadata);
  const name = filterName(key, target);
  if (["top", "saved", "direct"].includes(key)) return name;
  const bounds = [];
  if (min !== null) bounds.push(`≥ ${min}`);
  if (max !== null) bounds.push(`≤ ${max}`);
  return `${name} ${bounds.join(" · ")}`;
}

function availableFilters(row, chips, stream, target) {
  const keys = stream === "bonus" ? availableStats(target) : ["pair"];
  const experiment = stream === "bonus" ? ["action", "direct"] : ["series", "group"];
  const choices = row === "trying" ? ["top", "saved", ...experiment, ...keys] : keys;
  return choices.filter((key) => key === "pair" || !chips.some((chip) => chip.key === key));
}

function editFields(filter, target, { series, groups }) {
  const { key, value } = filter;
  if (key === "pair") return `<select data-filter-series aria-label="${html("Series skill")}">${pairOptions(series, filter.seriesIndex, "Any series skill")}</select><span>＋</span><select data-filter-group aria-label="${html("Group skill")}">${pairOptions(groups, filter.groupIndex, "Any group skill")}</select>`;
  if (["action", "series", "group"].includes(key)) {
    const choices = key === "action"
      ? [["reset", actionName("reset")], ["keep", actionName("keep")]]
      : (key === "series" ? series : groups).map((name, id) => [id, t(name)]);
    const options = choices.map(([id, label]) => `<option value="${id}"${String(id) === String(value) ? " selected" : ""}>${esc(label)}</option>`).join("");
    return `<select data-filter-value aria-label="${esc(filterName(key, target))}">${options}</select>`;
  }
  return `<span>≥</span><input type="number" min="0" step="1" data-filter-min value="${filter.min ?? ""}" aria-label="${html("Filter minimum")}"><span>≤</span><input type="number" min="0" step="1" data-filter-max value="${filter.max ?? ""}" aria-label="${html("Filter maximum")}">`;
}

function editingChip(filter, target, metadata) {
  const name = filter.key === "pair" ? pl("Skill pair") : filterName(filter.key, target);
  return `<span class="pl-sort-chip is-editing"><span class="pl-chip-name">${esc(name)}</span>${editFields(filter, target, metadata)}<button type="button" class="pl-chip-apply" data-pl-action="filter-apply" aria-label="${html("Apply")}">✓</button><button type="button" class="pl-sort-remove" data-pl-action="filter-cancel" aria-label="${html("Cancel")}">×</button></span>`;
}

function filterActions(row, trying) {
  if (row === "trying") return `<button type="button" class="pl-sort-add" data-pl-action="trying-apply" data-tier="acceptable">${html("Apply to OK")}</button><button type="button" class="pl-sort-add" data-pl-action="trying-apply" data-tier="preferred">${html("Apply to Top")}</button><button type="button" class="pl-sort-add" data-pl-action="trying-discard">${html("Discard")}</button>`;
  return trying ? "" : `<button type="button" class="pl-sort-add" data-pl-action="trying-start" data-tier="${row}">${html("Try changes")}</button>`;
}

function filterRow(row, target, list, { filterEditing, filterMenuOpen, rowChips, metadata }) {
  const label = row === "preferred" ? `★ ${pl("Top")}` : row === "acceptable" ? `✓ ${pl("OK")}` : pl("Trying");
  const chips = rowChips(row), keys = availableFilters(row, chips, list.stream, target);
  const editing = filterEditing?.row === row ? filterEditing : null;
  const buttons = chips.map((chip, index) => {
    if (editing?.index === index) return editingChip(editing, target, metadata);
    const name = filterLabel(chip, target, metadata);
    return `<span class="pl-sort-chip"><button type="button" data-pl-action="filter-edit" data-row="${row}" data-index="${index}">${esc(name)}</button><button type="button" class="pl-sort-remove" data-pl-action="filter-remove" data-row="${row}" data-index="${index}" aria-label="${html("Remove filter {name}", { name })}">×</button></span>`;
  });
  if (editing?.index === null) buttons.push(editingChip(editing, target, metadata));
  const chipMarkup = buttons.join(list.stream === "skill" && row !== "trying" ? `<span class="pl-filter-or">${html("or")}</span>` : "");
  const open = filterMenuOpen === row, active = list.active === row;
  const add = keys.length ? `<button type="button" class="pl-sort-add" data-pl-action="filter-menu" data-row="${row}" aria-haspopup="true" aria-expanded="${open}">＋</button>` : "";
  const menu = open ? `<div class="pl-sort-menu" data-browser-menu>${keys.map((key) => `<button type="button" data-pl-action="filter-pick" data-row="${row}" data-key="${key}">${esc(filterName(key, target))}</button>`).join("")}</div>` : "";
  return `<div class="pl-sort pl-filter-row is-${row}${active ? " is-active" : ""}"><div class="pl-sort-row"><button type="button" class="pl-filter-row-name" data-pl-action="filter-row" data-row="${row}" aria-pressed="${active}" title="${html("Filter the list by this row")}">${esc(label)}</button>${chipMarkup}${add}${filterActions(row, list.trying)}</div>${menu}</div>`;
}

function searchBar(list) {
  const streams = ["bonus", "skill"].map((value) => `<option value="${value}"${list.stream === value ? " selected" : ""}>${html(value === "bonus" ? "Bonus rolls" : "Skill rolls")}</option>`).join("");
  const bound = (key, text) => `<label>${html(text)}<input type="number" min="1" max="10000" step="1" data-browser-range="${key}" value="${list[key]}"></label>`;
  const cancel = list.loading ? `<button type="button" class="text-button" data-pl-action="cancel-finish-search">${html("Cancel search")}</button>` : "";
  return `<div class="pl-browser-search"><label>${html("Stream")}<select data-pl-finish-stream>${streams}</select></label><div class="pl-browser-range">${bound("from", "From roll")}<span>–</span>${bound("to", "To roll")}</div><button type="button" class="secondary" data-pl-action="search-finishes">${html("Search")}</button>${cancel}</div><p class="pl-fine">${html("Roll numbers start at the current saved position. A Keep finish may need an earlier Reset.")}</p>`;
}

// A search can return 50,000 finishes. Re-sort only when the options or sort change.
const sortCache = new WeakMap();
function sortedRows(options, levels) {
  if (!options) return [];
  const signature = JSON.stringify(levels);
  const cached = sortCache.get(options);
  if (cached?.signature === signature) return cached.rows;
  const rows = sortFinishOptions(options, levels);
  sortCache.set(options, { signature, rows });
  return rows;
}

function resultButton({ option, index }, saved, target, list, { current, inRoute, metadata }) {
  const used = inRoute?.key === option.key;
  const acquire = used ? inRoute.acquire : option.acquire;
  const prefix = list.stream === "bonus" ? "G" : "S";
  const reset = acquire ? ` · ${html("Reset at {at} first", { at: `${prefix}${acquire}` })}` : "";
  const where = `${option.top ? `<span class="pl-gold">★</span>` : ""}<strong class="pl-finish-roll">${prefix}${option.finish}</strong><span class="pl-finish-how">${esc(actionName(option.action))}${reset}</span>`;
  const route = used ? `<span class="pl-pick-used">${html("Used in current route")}</span>` : "";
  const below = option.meets ? "" : `<span class="pl-below-goal">${html("Below goal")}</span>`;
  const bookmark = `<span class="pl-save-toggle${saved ? " is-saved" : ""}">${BOOKMARK}${html(saved ? "Saved pick" : "Save pick")}</span>`;
  return `<button type="button" class="pl-finish-option${saved ? " is-current" : ""}" data-pl-save-pick="${index}" aria-pressed="${saved}"${!current || list.loading ? " disabled" : ""}${option.meets ? "" : " data-below-goal"}><span class="pl-finish-where">${where}${route}${below}${bookmark}</span><span class="pl-finish-result">${resultMarkup(option, list.stream, target, metadata)}</span></button>`;
}

function resultList(target, list, view, picks) {
  const savedIds = new Set(picks.map(savedFinishId));
  const isSaved = (option) => savedIds.size > 0 && savedIds.has(savedFinishId({ ...option, baseSeed: list.origin.baseSeed,
    originCounter: list.origin[`${list.stream}Counter`], weaponType: target.weaponType, attributeForce: target.attributeForce }));
  const filters = view.filters;
  const savedOnly = filters.some(({ key }) => key === "saved");
  const rows = sortedRows(list.options, view.levels).filter(({ option }) => finishOptionMatches(option, filters, savedOnly && isSaved(option)));
  const items = rows.slice(0, list.visible).map((row) => resultButton(row, isSaved(row.option), target, list, view)).join("");
  const empty = !list.loading && list.options && !items ? `<p class="pl-fine">${html("No finishes match these filters. Your saved picks are kept.")}</p>` : "";
  const more = rows.length > list.visible ? `<button type="button" class="secondary" data-pl-action="more-finishes">${html("Show more finishes")}</button>` : "";
  return { count: rows.length, markup: `<div class="pl-finish-list">${items}${empty}</div>${more}` };
}

function searchStatus(target, list, { current, metadata }, count, saved) {
  let message = html("Search every finish in the roll range, filtered by the chosen row.");
  if (list.loading) message = html("Checking other finishes for {name}…", { name: weaponName(target, metadata) });
  else if (list.options) message = html("{shown} matching finishes · searched {from}–{to} · {saved} saved", { shown: count, from: list.loadedFrom, to: list.loadedTo, saved });
  if (list.complete === false) message += ` · ${html("Showing the best {cap} of {total} by this sort. Narrow the range or add filters to see the rest.", { cap: list.options.length, total: list.total })}`;
  const error = list.error ? `<p class="error" role="alert">${esc(list.error)}</p>` : "";
  const stale = list.options && !current ? `<p class="pl-browser-warning">${html("Goals or saved position changed. Search again to refresh these finishes. Your saved picks are kept.")}</p>` : "";
  return `<p class="pl-fine" role="status">${message}</p>${error}${stale}`;
}

export function finishBrowserMarkup(target, list, view) {
  if (!list || !target) return "";
  const picks = target.planner.savedFinishes?.[list.stream] ?? [];
  const savedRows = picks.map((pick) => view.savedPickRow(target, list.stream, pick, 'data-pl-action="draft-remove-pick"', 'data-pl-action="draft-route-pick"')).join("");
  const favorites = picks.length ? `<details class="pl-browser-favorites"><summary>${html("Saved picks ({n})", { n: picks.length })}</summary><ul class="pl-saved-picks">${savedRows}</ul></details>` : "";
  const tiers = list.trying ? ["preferred", "acceptable", "trying"] : ["preferred", "acceptable"];
  const filters = `<div class="pl-filter-rows"><span class="pl-sort-label">${html("Filter")}</span>${tiers.map((row) => filterRow(row, target, list, view)).join("")}</div>`;
  const sort = sortBar(target, list.stream, view.levels, view.sortMenuOpen);
  const hint = `<p class="pl-fine">${html("Top and OK filters edit this weapon’s goals. Choose a row’s name to filter the list by it, or Try changes to explore without changing a goal.")}</p>`;
  const notice = list.notice ? `<p class="pl-fine pl-filter-notice">${esc(list.notice)}</p>` : "";
  const results = resultList(target, list, view, picks);
  return `${searchBar(list)}${favorites}<div class="pl-browser-controls">${filters}${sort}</div>${hint}${notice}${searchStatus(target, list, view, results.count, picks.length)}${results.markup}<p class="pl-fine pl-browser-save-note">${html("Save weapon to keep your goals and saved picks. Build guides separately when you are ready.")}</p>`;
}
