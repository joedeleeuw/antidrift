import YAML from "yaml";

// Same provenance shape with a non-schema receiver: a doubly encoded document
// is a real second decode, so the module-origin veto must keep this silent.
export function decodeNested(raw: string) {
  const document = YAML.parse(raw);
  return YAML.parse(document);
}
