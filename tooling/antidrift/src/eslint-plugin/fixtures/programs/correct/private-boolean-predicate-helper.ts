function isSummaryRoute(pathname: string): boolean {
  return pathname.includes("/reports/summary");
}

function hasRoutePrefix(pathname: string): boolean {
  return pathname.startsWith("/reports");
}

type RouteLike = { pathname?: unknown };

function isRouteLike(value: unknown): value is RouteLike {
  return typeof value === "object" && value !== null && "pathname" in value;
}

export function shouldProxy(pathname: string): boolean {
  return isSummaryRoute(pathname) || hasRoutePrefix(pathname);
}
