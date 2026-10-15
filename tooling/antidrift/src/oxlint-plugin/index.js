import noAnemicErrorsRule from "./portable/no-anemic-errors.js";
import noRelativeCrossPackageImportsRule from "./portable/no-relative-cross-package-imports.js";
import confineOwnerRule from "./portable/confine-owner.js";
import docsSourcePolicyRule from "./portable/docs-source-policy.js";
import iconButtonRequiresTooltipRule from "./portable/icon-button-requires-tooltip.js";
import noAdhocLoaderRule from "./portable/no-adhoc-loader.js";
import noAmbientHotkeyFormatRule from "./portable/no-ambient-hotkey-format.js";
import noAsyncContextEnterWithRule from "./portable/no-async-context-enter-with.js";
import noAuthTokenInWebStorageRule from "./portable/no-auth-token-in-web-storage.js";
import noAwaitedBuilderUnionRule from "./portable/no-awaited-builder-union.js";
import noCenteredScrollColumnRule from "./portable/no-centered-scroll-column.js";
import noDialogTriggerMenuItemRule from "./portable/no-dialog-trigger-menu-item.js";
import noDisabledTooltipTriggerRule from "./portable/no-disabled-tooltip-trigger.js";
import noEagerSingletonRule from "./portable/no-eager-singleton.js";
import noInlineStyleColorsRule from "./portable/no-inline-style-colors.js";
import noOmittedPropRespreadRule from "./portable/no-omitted-prop-respread.js";
import noPartialRecordSatisfiesRule from "./portable/no-partial-record-satisfies.js";
import noPathPrefixContainmentRule from "./portable/no-path-prefix-containment.js";
import noPhysicalPropertiesRule from "./portable/no-physical-properties.js";
import noRawForegroundOpacityRule from "./portable/no-raw-foreground-opacity.js";
import noRedactedLogAttributeKeyRule from "./portable/no-redacted-log-attribute-key.js";
import noSpreadInputInQueryKeyRule from "./portable/no-spread-input-in-query-key.js";
import noStaticDevtoolsImportRule from "./portable/no-static-devtools-import.js";
import noUnformattedNumberRule from "./portable/no-unformatted-number.js";
import noUnsafeInnerHtmlRule from "./portable/no-unsafe-inner-html.js";
import noPortalUnderInteractiveAncestorRule from "./portable/no-portal-under-interactive-ancestor.js";
import requireDetachedLabelShapeRule from "./portable/require-detached-label-shape.js";
import requireDirOnRenderedNameRule from "./portable/require-dir-on-rendered-name.js";
import requireExhaustivePanicRule from "./portable/require-exhaustive-panic.js";
import requireFetchTimeoutRule from "./portable/require-fetch-timeout.js";
import requireFunctionReplacerRule from "./portable/require-function-replacer.js";
import requireQueryKeyFactoryRule from "./portable/require-query-key-factory.js";
import requireQuerySignalRule from "./portable/require-query-signal.js";
import requireSafeWindowOpenRule from "./portable/require-safe-window-open.js";
import requireStableSnapshotRule from "./portable/require-stable-snapshot.js";
import requireStreamReaderDisposalRule from "./portable/require-stream-reader-disposal.js";
import noRawFilenameWriteRule from "./portable/no-raw-filename-write.js";
import noUnsanitizedHrefRule from "./portable/no-unsanitized-href.js";
import requireSecureDocumentResponseRule from "./portable/require-secure-document-response.js";
import noBunApiInSharedRule from "./portable/no-bun-api-in-shared.js";
import noDuplicateContextRule from "./portable/no-duplicate-context.js";
import noAiDebtCommentsRule from "./portable/no-ai-debt-comments.js";
import noAsNeverRule from "./portable/no-as-never.js";
import noTodoWithoutIssueRule from "./portable/no-todo-without-issue.js";
import noGenericModuleNamesRule from "./portable/no-generic-module-names.js";
import noDefaultExportInDomainRule from "./portable/no-default-export-in-domain.js";
import noTrivialPropertyHelpersRule from "./portable/no-trivial-property-helpers.js";
import noTutorialCommentsRule from "./portable/no-tutorial-comments.js";
import noDebugResidueFilenamesRule from "./portable/no-debug-residue-filenames.js";
import noPlaceholderTestsRule from "./portable/no-placeholder-tests.js";
import noUnlistedExternalImportsRule from "./portable/no-unlisted-external-imports.js";
import noDatedCommentsRule from "./portable/no-dated-comments.js";
import noElseIfChainRule from "./portable/no-else-if-chain.js";
import noFallbackToEmptyRule from "./portable/no-fallback-to-empty.js";
import noHashLiteralRule from "./portable/no-hash-literal.js";
import noHostPathLiteralRule from "./portable/no-host-path-literal.js";
import packageMetadata from "../../package.json" with { type: "json" };

import { createSyntaxRules } from "../syntax-rules.mjs";
import ruleNoRawReactNativeTouchables from "./rules/no-raw-react-native-touchables.js";
import { noChainedTypeAssertionsRule } from "./anti-slop/rules/no-chained-type-assertions.js";
import { noUnknownTypeAliasesRule } from "./anti-slop/rules/no-unknown-type-aliases.js";

const rules = {
  "no-anemic-errors": noAnemicErrorsRule,
  "no-relative-cross-package-imports": noRelativeCrossPackageImportsRule,
  "confine-owner": confineOwnerRule,
  "docs-source-policy": docsSourcePolicyRule,
  "icon-button-requires-tooltip": iconButtonRequiresTooltipRule,
  "no-adhoc-loader": noAdhocLoaderRule,
  "no-ambient-hotkey-format": noAmbientHotkeyFormatRule,
  "no-async-context-enter-with": noAsyncContextEnterWithRule,
  "no-auth-token-in-web-storage": noAuthTokenInWebStorageRule,
  "no-awaited-builder-union": noAwaitedBuilderUnionRule,
  "no-centered-scroll-column": noCenteredScrollColumnRule,
  "no-dialog-trigger-menu-item": noDialogTriggerMenuItemRule,
  "no-disabled-tooltip-trigger": noDisabledTooltipTriggerRule,
  "no-eager-singleton": noEagerSingletonRule,
  "no-inline-style-colors": noInlineStyleColorsRule,
  "no-omitted-prop-respread": noOmittedPropRespreadRule,
  "no-partial-record-satisfies": noPartialRecordSatisfiesRule,
  "no-path-prefix-containment": noPathPrefixContainmentRule,
  "no-physical-properties": noPhysicalPropertiesRule,
  "no-raw-foreground-opacity": noRawForegroundOpacityRule,
  "no-redacted-log-attribute-key": noRedactedLogAttributeKeyRule,
  "no-spread-input-in-query-key": noSpreadInputInQueryKeyRule,
  "no-static-devtools-import": noStaticDevtoolsImportRule,
  "no-unformatted-number": noUnformattedNumberRule,
  "no-unsafe-inner-html": noUnsafeInnerHtmlRule,
  "no-portal-under-interactive-ancestor": noPortalUnderInteractiveAncestorRule,
  "require-detached-label-shape": requireDetachedLabelShapeRule,
  "require-dir-on-rendered-name": requireDirOnRenderedNameRule,
  "require-exhaustive-panic": requireExhaustivePanicRule,
  "require-fetch-timeout": requireFetchTimeoutRule,
  "require-function-replacer": requireFunctionReplacerRule,
  "require-query-key-factory": requireQueryKeyFactoryRule,
  "require-query-signal": requireQuerySignalRule,
  "require-safe-window-open": requireSafeWindowOpenRule,
  "require-stable-snapshot": requireStableSnapshotRule,
  "require-stream-reader-disposal": requireStreamReaderDisposalRule,
  "no-raw-filename-write": noRawFilenameWriteRule,
  "no-unsanitized-href": noUnsanitizedHrefRule,
  "require-secure-document-response": requireSecureDocumentResponseRule,
  "no-bun-api-in-shared": noBunApiInSharedRule,
  "no-duplicate-context": noDuplicateContextRule,
  "no-ai-debt-comments": noAiDebtCommentsRule,
  "no-as-never": noAsNeverRule,
  "no-todo-without-issue": noTodoWithoutIssueRule,
  "no-generic-module-names": noGenericModuleNamesRule,
  "no-default-export-in-domain": noDefaultExportInDomainRule,
  "no-trivial-property-helpers": noTrivialPropertyHelpersRule,
  "no-tutorial-comments": noTutorialCommentsRule,
  "no-debug-residue-filenames": noDebugResidueFilenamesRule,
  "no-placeholder-tests": noPlaceholderTestsRule,
  "no-unlisted-external-imports": noUnlistedExternalImportsRule,
  "no-dated-comments": noDatedCommentsRule,
  "no-else-if-chain": noElseIfChainRule,
  "no-fallback-to-empty": noFallbackToEmptyRule,
  "no-hash-literal": noHashLiteralRule,
  "no-host-path-literal": noHostPathLiteralRule,
  ...createSyntaxRules(),
  "no-raw-react-native-touchables": ruleNoRawReactNativeTouchables(),
  "no-unknown-type-aliases": noUnknownTypeAliasesRule,
  "no-unsafe-cast-chain": noChainedTypeAssertionsRule,
};

export default {
  meta: {
    name: "@joedeleeuw/antidrift/oxlint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
