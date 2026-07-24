function severity(ruleValue) {
  return Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
}

it("enables every custom TypeChecker rule", () => {
  const rules = collectRules(createConfig());
  for (const ruleId of [
    "antidrift/no-appeasement-cast",
    "antidrift/no-canonical-model-fork",
  ]) {
    expect(severity(rules[ruleId])).toBe("error");
  }
});
