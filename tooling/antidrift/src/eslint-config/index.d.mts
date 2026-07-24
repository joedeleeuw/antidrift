import type { Linter } from "eslint";
import type { SemanticFact, SemanticFactSink } from "../policy/index.mjs";

export type SemanticFactSetting =
  | SemanticFactSink
  | ((fact: SemanticFact) => void)
  | {
      repoRoot?: string;
      sink?: SemanticFactSink | ((fact: SemanticFact) => void);
    };

export interface AntidriftConfigOptions {
  tsconfigRootDir?: string;
  policyDir?: string;
  semanticFacts?: SemanticFactSetting;
}

export function createConfig(options?: AntidriftConfigOptions): Linter.Config[];

export default createConfig;
