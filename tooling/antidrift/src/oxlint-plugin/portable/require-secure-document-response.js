import { isRuleFile, scopeProperties } from "./scope.js";
import {
  getImportedName,
  getPropertyName,
  isCallTo,
  isIdentifier,
} from "./ast.js";

const RAW_DOCUMENT_SECURITY_HEADERS = "RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS";

const getHeadersObject = (node) => {
  if (node.type !== "ObjectExpression") {
    return null;
  }
  const headersProperty = node.properties.find(
    (property) =>
      property.type === "Property" &&
      getPropertyName(property.key) === "headers",
  );
  if (!headersProperty || headersProperty.type !== "Property") {
    return null;
  }
  return headersProperty.value;
};
const hasAttachmentDisposition = (node) => {
  if (node.type !== "ObjectExpression") {
    return false;
  }
  const disposition = node.properties.find(
    (property) =>
      property.type === "Property" &&
      getPropertyName(property.key)?.toLowerCase() === "content-disposition",
  );
  if (!disposition || disposition.type !== "Property") {
    return false;
  }
  if (
    disposition.value.type === "Literal" &&
    typeof disposition.value.value === "string"
  ) {
    return disposition.value.value.toLowerCase().startsWith("attachment;");
  }
  return isCallTo(disposition.value, "contentDisposition");
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          allResponses: { type: "boolean" },
          headersModule: { type: "string" },
          owner: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      directResponse:
        "Use {{owner}} for raw document bytes so the " +
        "security policy, MIME type, and disposition are applied by construction.",
      manualHeaders:
        "Handler modules must not assemble raw document security headers " +
        "manually. Use {{owner}}.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const fileHandler = context.options[0]?.allResponses === true;
    const downloadHeadersIdentifiers = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== context.options[0]?.headersModule) {
          return;
        }
        const manualSecurityHeadersImport = node.specifiers.find(
          (specifier) =>
            getImportedName(specifier) === RAW_DOCUMENT_SECURITY_HEADERS,
        );
        if (manualSecurityHeadersImport) {
          context.report({
            node: manualSecurityHeadersImport,
            messageId: "manualHeaders",
            data: {
              owner:
                context.options[0]?.owner ??
                "a Response with explicit Content-Type, Content-Disposition and X-Content-Type-Options: nosniff headers",
            },
          });
        }
      },
      VariableDeclarator(node) {
        if (
          !isIdentifier(node.id) ||
          node.init?.type !== "NewExpression" ||
          !isIdentifier(node.init.callee, "Headers")
        ) {
          return;
        }
        const init = node.init.arguments.at(0);
        if (!init || init.type !== "ObjectExpression") {
          return;
        }
        if (hasAttachmentDisposition(init)) {
          downloadHeadersIdentifiers.add(node.id.name);
        }
      },
      NewExpression(node) {
        if (!isIdentifier(node.callee, "Response")) {
          return;
        }
        const body = node.arguments.at(0);
        if (!body || (body.type === "Literal" && body.value === null)) {
          return;
        }
        const init = node.arguments.at(1);
        const headers = init ? getHeadersObject(init) : null;
        const isDownloadResponse =
          fileHandler ||
          (headers?.type === "ObjectExpression" &&
            hasAttachmentDisposition(headers)) ||
          (headers?.type === "Identifier" &&
            downloadHeadersIdentifiers.has(headers.name));
        if (!isDownloadResponse) {
          return;
        }
        if (headers?.type === "ObjectExpression") {
          const names = new Map(
            headers.properties
              .filter((property) => property.type === "Property")
              .map((property) => [
                getPropertyName(property.key)?.toLowerCase(),
                property.value,
              ]),
          );
          if (
            names.has("content-type") &&
            names.has("content-disposition") &&
            names.get("x-content-type-options")?.value === "nosniff"
          ) {
            return;
          }
        }
        context.report({
          node,
          messageId: "directResponse",
          data: {
            owner:
              context.options[0]?.owner ??
              "a Response with explicit Content-Type, Content-Disposition and X-Content-Type-Options: nosniff headers",
          },
        });
      },
    };
  },
};
