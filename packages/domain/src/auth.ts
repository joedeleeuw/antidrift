export const roles = ["admin", "owner", "member", "viewer"] as const;

export type Role = (typeof roles)[number];

export type Principal = {
  id: string;
  role: Role;
  tenantId: string;
};

export function canManageProject(principal: Principal): boolean {
  return principal.role === "admin" || principal.role === "owner";
}
