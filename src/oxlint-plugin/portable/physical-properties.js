const PHYSICAL_REPLACEMENTS = [
  (classNames) =>
    classNames.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)ml-/gu, "$1$2$3ms-"),
  (classNames) =>
    classNames.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)mr-/gu, "$1$2$3me-"),
  (classNames) =>
    classNames.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)pl-/gu, "$1$2$3ps-"),
  (classNames) =>
    classNames.replace(/(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)pr-/gu, "$1$2$3pe-"),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)text-left(?=["'\s`})]|$)/gu,
      "$1$2text-start"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)text-right(?=["'\s`})]|$)/gu,
      "$1$2text-end"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)border-l(?=[-\s"'`})]|$)/gu,
      "$1$2border-s"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)border-r(?=[-\s"'`})]|$)/gu,
      "$1$2border-e"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-tl(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-ss"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-tr(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-se"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-bl(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-es"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-br(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-ee"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-l(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-s"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)rounded-r(?=[-\s"'`})]|$)/gu,
      "$1$2rounded-e"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)left-/gu,
      "$1$2$3start-"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])(-?)((?:[\w[\]:]*:)?)right-/gu,
      "$1$2$3end-"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-ml-/gu,
      "$1$2scroll-ms-"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-mr-/gu,
      "$1$2scroll-me-"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-pl-/gu,
      "$1$2scroll-ps-"
    ),
  (classNames) =>
    classNames.replace(
      /(^|[\s"'`{(])((?:[\w[\]:]*:)?)scroll-pr-/gu,
      "$1$2scroll-pe-"
    ),
];
const replaceOutsideArbitraryBrackets = (classNames, replace) => {
  let replacedSegments = "";
  let segmentStart = 0;
  let bracketStart = 0;
  let depth = 0;
  let escaped = false;
  let quote = null;
  for (let index = 0; index < classNames.length; index += 1) {
    const character = classNames[index];
    if (character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (depth > 0 && quote !== null) {
      if (!escaped && character === quote) {
        quote = null;
      }
      escaped = false;
      continue;
    }
    if (
      !escaped &&
      depth > 0 &&
      (character === '"' || character === "'" || character === "`")
    ) {
      quote = character;
      continue;
    }
    if (!escaped && character === "[") {
      if (depth === 0) {
        replacedSegments += replace(classNames.slice(segmentStart, index));
        bracketStart = index;
      }
      depth += 1;
    } else if (!escaped && character === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        replacedSegments += classNames.slice(bracketStart, index + 1);
        segmentStart = index + 1;
      }
    }
    escaped = false;
  }
  if (depth > 0) {
    return replacedSegments + classNames.slice(bracketStart);
  }
  return replacedSegments + replace(classNames.slice(segmentStart));
};
export const replacePhysicalProperties = (classNames) => {
  let replaced = classNames;
  for (const replace of PHYSICAL_REPLACEMENTS) {
    replaced = replaceOutsideArbitraryBrackets(replaced, replace);
  }
  return replaced;
};
export const hasPhysicalProperty = (classNames) =>
  PHYSICAL_REPLACEMENTS.some((replace) => replace(classNames) !== classNames);
