function query(config: { handler: () => string }) {
  return config.handler();
}

export function readLocal() {
  return query({ handler: () => "local" });
}
