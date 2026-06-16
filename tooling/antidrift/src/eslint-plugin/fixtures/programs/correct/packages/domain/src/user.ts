export type UserStatus = "active" | "disabled";

export type User = {
  id: string;
  displayName: string;
  status: UserStatus;
};
