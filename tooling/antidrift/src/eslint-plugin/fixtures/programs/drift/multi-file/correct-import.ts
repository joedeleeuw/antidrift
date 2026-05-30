// This file imports correctly. Its existence must NOT suppress errors in sibling files.
import type { User } from "firebase/auth";

export type AppUser = User & { tenantId: string };
