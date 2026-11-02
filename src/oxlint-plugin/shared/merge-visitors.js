export function mergeVisitors(...visitors) {
  const merged = {};
  for (const visitor of visitors) {
    for (const [selector, handler] of Object.entries(visitor)) {
      if (typeof handler !== "function") continue;
      const previous = merged[selector];
      merged[selector] = previous
        ? function mergedVisitor(node) {
            previous(node);
            handler(node);
          }
        : handler;
    }
  }
  return merged;
}
