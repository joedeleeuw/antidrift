export interface AntidriftRuleModule {
  readonly meta: {
    readonly type: "problem" | "suggestion" | "layout";
    readonly docs?: {
      readonly description: string;
    };
    readonly messages?: Readonly<Record<string, string>>;
    readonly schema?: readonly unknown[];
  };
  create(
    context: unknown
  ): Readonly<Record<string, (...args: never[]) => void>>;
}

export declare const rules: Readonly<Record<string, AntidriftRuleModule>>;

export declare const antidriftPlugin: {
  readonly meta: {
    readonly name: "antidrift";
    readonly version: string;
  };
  readonly rules: typeof rules;
};

export default antidriftPlugin;
