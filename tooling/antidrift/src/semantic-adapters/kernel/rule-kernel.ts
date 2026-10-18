import type { Rule } from "eslint";
import ts from "typescript";

import {
  declaresGenerated,
  isDeclaredGeneratedSource,
} from "./generated-source.ts";
import { isRuleFile } from "./rule-scope.ts";

type ReportedSyntax = Extract<
  Parameters<Rule.RuleContext["report"]>[0],
  { node: unknown }
>["node"];

export type TypeServices = {
  readonly program: ts.Program;
  readonly esTreeNodeToTSNodeMap: { get(node: unknown): ts.Node | undefined };
  readonly tsNodeToESTreeNodeMap?: {
    get(node: ts.Node): ReportedSyntax | undefined;
  };
};

export type TypeScriptParserServices = Pick<
  TypeServices,
  "esTreeNodeToTSNodeMap"
>;

type TypeScriptReport = Rule.ReportDescriptorOptions &
  Rule.ReportDescriptorMessage;

type SyntaxKindVisitors = {
  readonly [kind in ts.SyntaxKind]?: (node: ts.Node) => void;
};

type SyntaxKindListeners = SyntaxKindVisitors & {
  readonly exit?: SyntaxKindVisitors;
};

type TypeScriptRuleEnvironment = {
  readonly context: Rule.RuleContext;
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly services: TypeServices;
  readonly options: readonly unknown[];
  readonly cwd: string;
  readonly filename: string;
};

type SourceFileRuleEnvironment = TypeScriptRuleEnvironment & {
  readonly sourceFile: ts.SourceFile;
  readonly reportNode: (target: ts.Node, report: TypeScriptReport) => void;
};

type TypeScriptRuleListeners =
  | {
      readonly visitors: (
        environment: TypeScriptRuleEnvironment
      ) => Rule.RuleListener;
    }
  | {
      readonly run: (
        environment: SourceFileRuleEnvironment
      ) => SyntaxKindListeners | undefined;
    };

type TypeScriptRuleDefinition = TypeScriptRuleListeners & {
  readonly ruleName: string;
  readonly meta: Rule.RuleMetaData;
  readonly skipGenerated?: boolean;
  readonly skipNonRuleFile?: boolean;
  readonly documentVisitors?: (context: Rule.RuleContext) => Rule.RuleListener;
};

function isTypeServices(candidate: unknown): candidate is TypeServices {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Boolean(Reflect.get(candidate, "program")) &&
    Boolean(Reflect.get(candidate, "esTreeNodeToTSNodeMap"))
  );
}

export function requireTypeServices(
  context: Pick<Rule.RuleContext, "sourceCode">
): TypeServices | null {
  const services: unknown = context.sourceCode.parserServices;
  return isTypeServices(services) ? services : null;
}

function tsNodeLocation(sourceFile: ts.SourceFile, tsNode: ts.Node) {
  const start = sourceFile.getLineAndCharacterOfPosition(
    tsNode.getStart(sourceFile)
  );
  const end = sourceFile.getLineAndCharacterOfPosition(tsNode.getEnd());
  return {
    start: { line: start.line + 1, column: start.character },
    end: { line: end.line + 1, column: end.character },
  };
}

function walkTypeScriptAst(
  currentNode: ts.Node,
  listeners: SyntaxKindListeners
): void {
  listeners[currentNode.kind]?.(currentNode);
  ts.forEachChild(currentNode, (childNode) => {
    walkTypeScriptAst(childNode, listeners);
  });
  listeners.exit?.[currentNode.kind]?.(currentNode);
}

function sourceFileListeners(
  definition: Extract<TypeScriptRuleListeners, { run: unknown }>,
  environment: TypeScriptRuleEnvironment,
  skipGenerated: boolean
): Rule.RuleListener {
  const { context, services, program } = environment;
  return {
    Program(programNode) {
      const mapped = services.esTreeNodeToTSNodeMap.get(programNode);
      const sourceFile =
        mapped && ts.isSourceFile(mapped)
          ? mapped
          : program.getSourceFile(context.filename);
      if (!sourceFile || (skipGenerated && declaresGenerated(sourceFile))) {
        return;
      }
      const reportNode = (target: ts.Node, report: TypeScriptReport): void => {
        const reportedSyntax = services.tsNodeToESTreeNodeMap?.get(target);
        if (reportedSyntax) {
          context.report({ node: reportedSyntax, ...report });
          return;
        }
        context.report({ loc: tsNodeLocation(sourceFile, target), ...report });
      };
      const listeners = definition.run({
        ...environment,
        sourceFile,
        reportNode,
      });
      if (listeners) {
        walkTypeScriptAst(sourceFile, listeners);
      }
    },
  };
}

export function defineTypeScriptRule(
  definition: TypeScriptRuleDefinition
): Rule.RuleModule {
  const skipGenerated = definition.skipGenerated ?? true;
  const missingServicesMessage = `antidrift/${definition.ruleName} requires TypeScript parser services. Use @joedeleeuw/antidrift createConfig(...) or configure @typescript-eslint/parser with projectService/project.`;
  return {
    meta: definition.meta,
    create(context) {
      const rootType: string = context.sourceCode.ast.type;
      if (definition.documentVisitors && rootType === "Document") {
        return definition.documentVisitors(context);
      }
      if (
        (definition.skipNonRuleFile && !isRuleFile(context)) ||
        (skipGenerated && isDeclaredGeneratedSource(context.sourceCode.text))
      ) {
        return {};
      }
      const services = requireTypeServices(context);
      if (!services) {
        return {
          Program(programNode) {
            context.report({
              node: programNode,
              message: missingServicesMessage,
            });
          },
        };
      }
      const environment = {
        context,
        checker: services.program.getTypeChecker(),
        program: services.program,
        services,
        options: context.options,
        cwd: context.cwd,
        filename: context.filename,
      } satisfies TypeScriptRuleEnvironment;
      if ("visitors" in definition) {
        return definition.visitors(environment);
      }
      return sourceFileListeners(definition, environment, skipGenerated);
    },
  };
}
