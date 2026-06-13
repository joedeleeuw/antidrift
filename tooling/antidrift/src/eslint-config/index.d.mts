import type { Linter } from "eslint";

export interface AntidriftConfigOptions {
  tsconfigRootDir?: string;
  policyDir?: string;
}

export function createConfig(options?: AntidriftConfigOptions): Linter.Config[];
