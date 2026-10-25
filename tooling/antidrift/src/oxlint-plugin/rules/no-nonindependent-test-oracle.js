import { createIndependentTestOracleListeners } from "../independent-test-oracle/visitors.js";

export default function ruleNoNonindependentTestOracle() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Require test assertions to prove behavior independently of arranged inputs, validators, static shapes, or mocked outputs.",
      },
      schema: [],
      messages: {
        noBareMembership:
          "Do not make bare membership or key existence the test. Assert behavior, full output, or a real artifact instead.",
        inputEcho:
          "This assertion restates the arranged input, so it only proves the dependency echoed data back. Assert transformed output, a captured artifact, or boundary behavior instead.",
        lengthEcho:
          "This length assertion restates the arranged collection size and proves no project transform or filter. Assert transformed contents or an independently derived count instead.",
        outcomeEcho:
          "This assertion only inspects the outcome or error of an act on input the test arranged to fail. Assert the parsed value on the success path, or a downstream consumer's behavior — inspecting the validator's own error/flag proves nothing the arrangement didn't.",
        errorShapeEcho:
          "This assertion only inspects the outcome or error of an act on input the test arranged to fail. Assert the parsed value on the success path, or a downstream consumer's behavior — inspecting the validator's own error/flag proves nothing the arrangement didn't.",
        existenceEcho:
          "This existence check is satisfied by the arranged value's construction and cannot fail. Assert real output instead.",
        mockCallEcho:
          "This test only proves the mock received the argument the test itself passed. Assert output, state, or an effect beyond the mocked call.",
        mockedResponseBodyOracle:
          "This test asserts a response-body object shape supplied by a mock. Object-shape checks are candidates for deleting the entire test block, not for swapping schema.parse with direct equality. Keep the test only if it proves an independently owned effect. Tip: checking response-body or payload shapes is often a sign of a low-value test; assert behavior not supplied by the mock or remove the test.",
        staticPropertyEcho:
          "This loop restates hardcoded properties of one precomputed object. Exercise behavior for each case or assert a generated/public artifact instead.",
        validatorOutputOracle:
          "This assertion checks validator output without an independent expected value. Assert application behavior against a value that does not come from the input or output.",
        validatorThrowOracle:
          "This assertion only checks whether a validator accepts input. Assert application behavior or remove the test.",
      },
    },
    create: createIndependentTestOracleListeners,
  };
}
