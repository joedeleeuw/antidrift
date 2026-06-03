function isWebviewRoute(pathname: string): boolean {
  return pathname.includes("/reports/weekly-digest");
}

function hasRoutePrefix(pathname: string): boolean {
  return pathname.startsWith("/reports");
}

type RouteLike = { pathname?: unknown };

function isRouteLike(value: unknown): value is RouteLike {
  return typeof value === "object" && value !== null && "pathname" in value;
}

export function shouldProxy(pathname: string): boolean {
  return isWebviewRoute(pathname) || hasRoutePrefix(pathname);
}
