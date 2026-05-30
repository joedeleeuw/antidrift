// Pure alias of an imported canonical type. The local name resolves to firebase's own type
// (its symbol is declared in node_modules), so it is a reference — not a hand-written fork.
// Expected: 0 errors.
import type { UserInfo } from "firebase/auth";

export type AccountInfo = UserInfo;
