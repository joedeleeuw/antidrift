export const userStatuses = ["active", "disabled", "invited"] as const;

export type UserStatus = (typeof userStatuses)[number];

export type User = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
};

export function isActiveUser(user: User): boolean {
  return user.status === "active";
}
