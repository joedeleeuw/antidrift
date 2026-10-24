import { integrationCorpora } from "./integration-cases.mjs";
import { sudocodeCorpora } from "./sudocode-cases.mjs";

export const coreRuleIds = new Set(["no-restricted-imports"]);

export const externalCorpora = [...sudocodeCorpora, ...integrationCorpora];
export const defaultCases = externalCorpora.flatMap((entry) => entry.cases);
