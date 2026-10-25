export function mergeVisitors(...visitors) {
  const handlers = new Map();
  for (const visitor of visitors) {
    for (const [selector, handler] of Object.entries(visitor)) {
      const selectorHandlers = handlers.get(selector) ?? [];
      selectorHandlers.push(handler);
      handlers.set(selector, selectorHandlers);
    }
  }
  return Object.fromEntries(
    [...handlers].map(([selector, selectorHandlers]) => [
      selector,
      (node) => {
        for (const handler of selectorHandlers) handler(node);
      },
    ])
  );
}
