import packageMetadata from "../../package.json" with { type: "json" };
import { unknownInputMustBeDecodedRule } from "./portable/boundary-schema.js";
import { noBranchTreeRule } from "./portable/branch-and-ternary-checks.js";
import confineOwnerRule from "./portable/confine-owner.js";
import {
  noExplicitTypeArgumentsOnOwnedApiRule,
  noSqlStringConcatRule,
  requireConvexReturnValidatorRule,
} from "./portable/convex-and-sql.js";
import docsSourcePolicyRule from "./portable/docs-source-policy.js";
import {
  noArgumentMutationSideEffectRule,
  noClosedStringParameterRule,
  noPassThroughParametersRule,
  noServiceConstructorImportsRule,
  noWrappingFunctionsRule,
} from "./portable/function-boundaries.js";
import iconButtonRequiresTooltipRule from "./portable/icon-button-requires-tooltip.js";
import noAdhocLoaderRule from "./portable/no-adhoc-loader.js";
import noAmbientHotkeyFormatRule from "./portable/no-ambient-hotkey-format.js";
import noAnemicErrorsRule from "./portable/no-anemic-errors.js";
import noAsyncArrayMethodRule from "./portable/no-async-array-method.js";
import noAuthTokenInWebStorageRule from "./portable/no-auth-token-in-web-storage.js";
import noAwaitedBuilderUnionRule from "./portable/no-awaited-builder-union.js";
import noBunApiInSharedRule from "./portable/no-bun-api-in-shared.js";
import noCenteredScrollColumnRule from "./portable/no-centered-scroll-column.js";
import noCompatNamesRule from "./portable/no-compat-names.js";
import noDebugResidueFilenamesRule from "./portable/no-debug-residue-filenames.js";
import noDialogTriggerMenuItemRule from "./portable/no-dialog-trigger-menu-item.js";
import noDisabledTooltipTriggerRule from "./portable/no-disabled-tooltip-trigger.js";
import noEagerSingletonRule from "./portable/no-eager-singleton.js";
import noHandrolledResourceLifecycleCellsRule from "./portable/no-handrolled-resource-lifecycle-cells.js";
import noHostPathLiteralRule from "./portable/no-host-path-literal.js";
import noInlineStyleColorsRule from "./portable/no-inline-style-colors.js";
import noOmittedPropRespreadRule from "./portable/no-omitted-prop-respread.js";
import noPartialRecordSatisfiesRule from "./portable/no-partial-record-satisfies.js";
import noPathPrefixContainmentRule from "./portable/no-path-prefix-containment.js";
import noPhysicalPropertiesRule from "./portable/no-physical-properties.js";
import noPortalUnderInteractiveAncestorRule from "./portable/no-portal-under-interactive-ancestor.js";
import noRawFilenameWriteRule from "./portable/no-raw-filename-write.js";
import noRawForegroundOpacityRule from "./portable/no-raw-foreground-opacity.js";
import noRawTouchablesRule from "./portable/no-raw-touchables.js";
import noRedactedLogAttributeKeyRule from "./portable/no-redacted-log-attribute-key.js";
import noRelativeCrossPackageImportsRule from "./portable/no-relative-cross-package-imports.js";
import noStaticDevtoolsImportRule from "./portable/no-static-devtools-import.js";
import noTodoWithoutIssueRule from "./portable/no-todo-without-issue.js";
import noTutorialCommentsRule from "./portable/no-tutorial-comments.js";
import noUnboundWidgetCaptureRule from "./portable/no-unbound-widget-capture.js";
import noUnformattedNumberRule from "./portable/no-unformatted-number.js";
import noUnlistedExternalImportsRule from "./portable/no-unlisted-external-imports.js";
import noUnsafeInnerHtmlRule from "./portable/no-unsafe-inner-html.js";
import noUnsanitizedHrefRule from "./portable/no-unsanitized-href.js";
import noVagueNamesRule from "./portable/no-vague-names.js";
import {
  noQueryEnvelopeLeakRule,
  noQueryJoinOrTreeReshapeRule,
} from "./portable/query-join-checks.js";
import {
  noExternalDecodeInTsxRule,
  noHooklessUseFunctionRule,
  noImpureRenderCallRule,
} from "./portable/react-render-hygiene.js";
import requireAuthzCheckRule from "./portable/require-authz-check.js";
import requireDetachedLabelShapeRule from "./portable/require-detached-label-shape.js";
import requireDirOnRenderedNameRule from "./portable/require-dir-on-rendered-name.js";
import requireExhaustivePanicRule from "./portable/require-exhaustive-panic.js";
import requireFetchTimeoutRule from "./portable/require-fetch-timeout.js";
import requireFunctionReplacerRule from "./portable/require-function-replacer.js";
import requireQueryKeyFactoryRule from "./portable/require-query-key-factory.js";
import requireQuerySignalRule from "./portable/require-query-signal.js";
import requireSafeWindowOpenRule from "./portable/require-safe-window-open.js";
import requireSecureDocumentResponseRule from "./portable/require-secure-document-response.js";
import requireStableSnapshotRule from "./portable/require-stable-snapshot.js";
import requireStreamReaderDisposalRule from "./portable/require-stream-reader-disposal.js";
import {
  noMutableLetAliasRule,
  noReexportOnlyModuleRule,
  reactMaxComponentPropsRule,
} from "./portable/simplicity-and-caps.js";
import { noAppeasementErasureRule } from "./portable/no-known-value-widening.js";
import { noRedundantSchemaParseRule } from "./portable/schema-reparse-checks.js";
import {
  noAppeasementCastRule,
  noContractAppeasementProjectionRule,
  noRedundantTypePredicateRule,
  noUndercheckedTypePredicateRule,
} from "./portable/type-contracts.js";
import {
  noHypotheticalSeamRule,
  noUnresolvedDependencyTypesRule,
} from "./portable/type-fork-checks.js";
import { noStructuralTypeForkRule } from "./portable/type-forks.js";
import ruleNoCallingComponentsAsFunctions from "./portable/no-calling-components-as-functions.js";
import ruleNoDuplicatedConditionalClassnames from "./portable/no-duplicated-conditional-classnames.js";
import ruleNoFallbackChain from "./portable/no-fallback-chain.js";
import ruleNoSentinelAbsenceFallback from "./portable/no-sentinel-absence-fallback.js";
import requireEffectDepsRule from "./portable/require-effect-deps.js";
import { isRuleFile, scopeProperties } from "./shared/rule-scope.js";

function withRuleScope(rule) {
  const existingSchema = Array.isArray(rule.meta?.schema)
    ? rule.meta.schema
    : [];
  const firstSchema = existingSchema[0];
  const mergedSchema =
    firstSchema && typeof firstSchema === "object"
      ? [
          {
            ...firstSchema,
            properties: {
              ...scopeProperties,
              ...firstSchema.properties,
            },
          },
          ...existingSchema.slice(1),
        ]
      : [
          {
            type: "object",
            properties: scopeProperties,
            additionalProperties: false,
          },
        ];

  return {
    ...rule,
    meta: {
      ...rule.meta,
      schema: mergedSchema,
    },
    create(context) {
      if (!isRuleFile(context)) return {};
      return rule.create(context);
    },
  };
}

const rawRules = {
  "confine-owner": confineOwnerRule,
  "docs-source-policy": docsSourcePolicyRule,
  "icon-button-requires-tooltip": iconButtonRequiresTooltipRule,
  "no-adhoc-loader": noAdhocLoaderRule,
  "no-ambient-hotkey-format": noAmbientHotkeyFormatRule,
  "no-anemic-errors": noAnemicErrorsRule,
  "no-appeasement-cast": noAppeasementCastRule,
  "no-appeasement-erasure": noAppeasementErasureRule,
  "no-argument-mutation-side-effect": noArgumentMutationSideEffectRule,
  "no-async-array-method": noAsyncArrayMethodRule,
  "no-auth-token-in-web-storage": noAuthTokenInWebStorageRule,
  "no-awaited-builder-union": noAwaitedBuilderUnionRule,
  "no-branch-tree": noBranchTreeRule,
  "no-bun-api-in-shared": noBunApiInSharedRule,
  "no-calling-components-as-functions": ruleNoCallingComponentsAsFunctions(),
  "no-centered-scroll-column": noCenteredScrollColumnRule,
  "no-closed-string-parameter": noClosedStringParameterRule,
  "no-compat-names": noCompatNamesRule,
  "no-contract-appeasement-projection": noContractAppeasementProjectionRule,
  "no-debug-residue-filenames": noDebugResidueFilenamesRule,
  "no-dialog-trigger-menu-item": noDialogTriggerMenuItemRule,
  "no-disabled-tooltip-trigger": noDisabledTooltipTriggerRule,
  "no-duplicated-conditional-classnames":
    ruleNoDuplicatedConditionalClassnames(),
  "no-eager-singleton": noEagerSingletonRule,
  "no-explicit-type-arguments-on-owned-api":
    noExplicitTypeArgumentsOnOwnedApiRule,
  "no-external-decode-in-tsx": noExternalDecodeInTsxRule,
  "no-fallback-chain": ruleNoFallbackChain(),
  "no-handrolled-resource-lifecycle-cells":
    noHandrolledResourceLifecycleCellsRule,
  "no-hookless-use-function": noHooklessUseFunctionRule,
  "no-host-path-literal": noHostPathLiteralRule,
  "no-hypothetical-seam": noHypotheticalSeamRule,
  "no-impure-render-call": noImpureRenderCallRule,
  "no-inline-style-colors": noInlineStyleColorsRule,
  "no-mutable-let-alias": noMutableLetAliasRule,
  "no-omitted-prop-respread": noOmittedPropRespreadRule,
  "no-partial-record-satisfies": noPartialRecordSatisfiesRule,
  "no-pass-through-parameters": noPassThroughParametersRule,
  "no-path-prefix-containment": noPathPrefixContainmentRule,
  "no-physical-properties": noPhysicalPropertiesRule,
  "no-portal-under-interactive-ancestor": noPortalUnderInteractiveAncestorRule,
  "no-query-envelope-leak": noQueryEnvelopeLeakRule,
  "no-query-join-or-tree-reshape": noQueryJoinOrTreeReshapeRule,
  "no-raw-filename-write": noRawFilenameWriteRule,
  "no-raw-foreground-opacity": noRawForegroundOpacityRule,
  "no-raw-touchables": noRawTouchablesRule,
  "no-redacted-log-attribute-key": noRedactedLogAttributeKeyRule,
  "no-redundant-schema-parse": noRedundantSchemaParseRule,
  "no-redundant-type-predicate": noRedundantTypePredicateRule,
  "no-reexport-only-module": noReexportOnlyModuleRule,
  "no-relative-cross-package-imports": noRelativeCrossPackageImportsRule,
  "no-sentinel-absence-fallback": ruleNoSentinelAbsenceFallback(),
  "no-service-constructor-imports": noServiceConstructorImportsRule,
  "no-sql-string-concat": noSqlStringConcatRule,
  "no-static-devtools-import": noStaticDevtoolsImportRule,
  "no-structural-type-fork": noStructuralTypeForkRule,
  "no-todo-without-issue": noTodoWithoutIssueRule,
  "no-tutorial-comments": noTutorialCommentsRule,
  "no-unbound-widget-capture": noUnboundWidgetCaptureRule,
  "no-underchecked-type-predicate": noUndercheckedTypePredicateRule,
  "no-unformatted-number": noUnformattedNumberRule,
  "no-unlisted-external-imports": noUnlistedExternalImportsRule,
  "no-unresolved-dependency-types": noUnresolvedDependencyTypesRule,
  "no-unsafe-inner-html": noUnsafeInnerHtmlRule,
  "no-unsanitized-href": noUnsanitizedHrefRule,
  "no-vague-names": noVagueNamesRule,
  "no-wrapping-functions": noWrappingFunctionsRule,
  "react-max-component-props": reactMaxComponentPropsRule,
  "require-authz-check": requireAuthzCheckRule,
  "require-convex-return-validator": requireConvexReturnValidatorRule,
  "require-detached-label-shape": requireDetachedLabelShapeRule,
  "require-dir-on-rendered-name": requireDirOnRenderedNameRule,
  "require-effect-deps": requireEffectDepsRule,
  "require-exhaustive-panic": requireExhaustivePanicRule,
  "require-fetch-timeout": requireFetchTimeoutRule,
  "require-function-replacer": requireFunctionReplacerRule,
  "require-query-key-factory": requireQueryKeyFactoryRule,
  "require-query-signal": requireQuerySignalRule,
  "require-safe-window-open": requireSafeWindowOpenRule,
  "require-secure-document-response": requireSecureDocumentResponseRule,
  "require-stable-snapshot": requireStableSnapshotRule,
  "require-stream-reader-disposal": requireStreamReaderDisposalRule,
  "unknown-input-must-be-decoded": unknownInputMustBeDecodedRule,
};

export const rules = Object.fromEntries(
  Object.entries(rawRules).map(([name, rule]) => [name, withRuleScope(rule)])
);

export const antidriftPlugin = {
  meta: {
    name: "antidrift",
    version: packageMetadata.version,
  },
  rules,
};

export default antidriftPlugin;
