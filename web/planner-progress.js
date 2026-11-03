// Rows keep their global route index, but each table advances independently.
export function routeProgress(steps, completed) {
  const tables = { bonus: [], skill: [] };
  const lastByWeapon = { bonus: new Map(), skill: new Map() };
  const rows = steps.map((step, index) => {
    const row = { step, index, current: false, saved: false };
    if (!Object.hasOwn(tables, step.stream)) return row;
    const table = tables[step.stream];
    row.saved = table.length < completed[step.stream];
    row.current = table.length === completed[step.stream];
    table.push(row);
    lastByWeapon[step.stream].set(step.targetId, row);
    return row;
  });

  return {
    rows,
    tables,
    finishedIn: (stream, id) => lastByWeapon[stream].get(id)?.saved ?? false,
    nextIndex(stream = "bonus") {
      const other = stream === "bonus" ? "skill" : "bonus";
      return tables[stream]?.[completed[stream]]?.index
        ?? tables[other][completed[other]]?.index
        ?? Math.max(0, rows.length - 1);
    },
  };
}
