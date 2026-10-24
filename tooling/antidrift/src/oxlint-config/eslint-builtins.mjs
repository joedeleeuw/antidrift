import { builtinRules } from "eslint/use-at-your-own-risk";

const restrictedSyntax = builtinRules.get("no-restricted-syntax");
if (!restrictedSyntax) {
  throw new Error(
    "The installed ESLint does not provide no-restricted-syntax; install a compatible ESLint peer."
  );
}

export default {
  meta: { name: "governance-eslint" },
  rules: { "no-restricted-syntax": restrictedSyntax },
};
