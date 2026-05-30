// Correctly extends firebase User via intersection — adds fields, doesn't restate them.
import type { User } from "firebase/auth";

export type AppUser = User & {
  tenantId: string;
  role: "admin" | "member" | "viewer";
};

export type AdminUser = AppUser & {
  managedTenants: string[];
};
