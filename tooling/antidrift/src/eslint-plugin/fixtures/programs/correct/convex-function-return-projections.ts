// FunctionReturnType references and Pick/Omit projections of the generated api owner are
// derivations, not hand-written copies. Expected: 0 errors.
import type { FunctionReturnType } from "convex/server";

import { api } from "../convex/_generated/api";

export type MachineSummary = FunctionReturnType<typeof api.machines.get>;

export type MachineListing = Pick<
  FunctionReturnType<typeof api.machines.get>,
  "id" | "name"
>;
