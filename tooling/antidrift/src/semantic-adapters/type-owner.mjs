export {
  MIN_PROPS,
  collectAcceptedPackageCanonicalTypes,
  collectCanonicalTypes,
  collectDomainCanonicalTypes,
  collectGeneratedCanonicalTypes,
  isObjectType,
  resolvesToDomainCanonicalType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typeProps,
  typePropsDetailed,
} from "../policy/lib/type-index.mjs";
export {
  canonicalStatusLiteralOwner,
  isStatusContextName,
  isStatusLiteralContext,
  nodeKeyName,
  normalizedContextName,
} from "./status-literal.mjs";
