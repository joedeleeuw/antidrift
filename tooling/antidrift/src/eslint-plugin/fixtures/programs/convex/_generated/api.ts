import type { FunctionReference } from "convex/server";

export type MachineSummary = {
  id: string;
  name: string;
  address: string;
  online: boolean;
};

export declare const api: {
  machines: {
    list: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      { machines: MachineSummary[] }
    >;
    get: FunctionReference<"query", "public", { id: string }, MachineSummary>;
    register: FunctionReference<"mutation", "public", { name: string }, string>;
  };
};
export declare const internal: any;
