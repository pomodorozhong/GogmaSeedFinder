// Local saves can contain numbers written as strings. Recover each field
// independently so one bad counter cannot hide the other stream's position.
function storedNumber(value, maximum) {
  const number = Number(value ?? NaN);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
}

const storedSource = (value) => typeof value === "string" ? value : null;

export function readSavedPosition(saved) {
  return {
    baseSeed: storedNumber(saved?.baseSeed, 99_999_999),
    bonusCounter: storedNumber(saved?.bonusCounter, 0xffffffff),
    skillCounter: storedNumber(saved?.skillCounter, 0xffffffff),
    baseSource: storedSource(saved?.baseSource),
    bonusSource: storedSource(saved?.bonusSource),
    skillSource: storedSource(saved?.skillSource),
  };
}

export function createPosition(baseSeed, bonusCounter, skillCounter, source) {
  return {
    baseSeed, bonusCounter, skillCounter,
    baseSource: source,
    bonusSource: bonusCounter === null ? null : source,
    skillSource: skillCounter === null ? null : source,
  };
}

// An import replaces the whole position or fails. A missing counter is valid.
export function readImportedPosition(saved, source) {
  const { baseSeed, bonusCounter, skillCounter } = readSavedPosition(saved);
  if (baseSeed === null || (bonusCounter === null && saved.bonusCounter != null) ||
      (skillCounter === null && saved.skillCounter != null)) return null;
  return createPosition(baseSeed, bonusCounter, skillCounter, source);
}

export function withStreamCounter(position, stream, baseSeed, counter, source, clearOther = false) {
  const next = {
    ...position, baseSeed, baseSource: source,
    [`${stream}Counter`]: counter,
    [`${stream}Source`]: source,
  };
  if (clearOther || (position.baseSeed !== null && position.baseSeed !== baseSeed)) {
    const other = stream === "bonus" ? "skill" : "bonus";
    next[`${other}Counter`] = null;
    next[`${other}Source`] = null;
  }
  return next;
}
