import ts from "typescript";

import type { BoundaryObserver } from "./boundary-observations.ts";
import { CarrierPaths } from "./carrier-paths.ts";
import { DeclarationFacts, rowMatchesOwner } from "./declaration-facts.ts";
import { excluded } from "./decision-cases.ts";
import { DecoderForms } from "./decoder-forms.ts";
import { DecoderImplementationProof } from "./decoder-proof.ts";
import { rootCases } from "./source-cases.ts";

export function boundaryDeclarations(
  program: ts.Program,
  observer: BoundaryObserver
) {
  const { checker } = observer;
  const facts = new DeclarationFacts(program, checker);
  const carriers = new CarrierPaths(checker, facts);
  const forms = new DecoderForms(checker, carriers);
  const proof = new DecoderImplementationProof({
    checker,
    carriers,
    facts,
    observer,
    decode,
  });

  function signatureDecode(signature: ts.Signature | undefined, use: ts.Node) {
    const evidence = forms.signatureForm(signature);
    const declaration = signature?.declaration;
    if (!evidence || !declaration) {
      return null;
    }
    const source = declaration.getSourceFile();
    const ownerName = facts.packageAt(source.fileName)?.name;
    const platform =
      program.isSourceFileDefaultLibrary(source) ||
      rootCases.some((row) => row.platform && rowMatchesOwner(row, ownerName));
    const platformProjection = platform && evidence.kind !== "predicate";
    const unprovedDecoder =
      !platform &&
      facts.origin(declaration, use) !== "dependency" &&
      !proof.prove(declaration, evidence);
    if (excluded({ platformProjection, unprovedDecoder })) {
      return null;
    }
    return evidence;
  }

  function decode(call: ts.Node) {
    if (!ts.isCallExpression(call)) {
      return null;
    }
    const evidence = signatureDecode(checker.getResolvedSignature(call), call);
    const input =
      evidence?.parameter === undefined
        ? undefined
        : call.arguments[evidence.parameter];
    if (!evidence || !input) {
      return null;
    }
    return { ...evidence, call, input };
  }

  return {
    origin: facts.origin.bind(facts),
    platformSource: facts.platformSource.bind(facts),
    exported: facts.exported.bind(facts),
    callsInSource: facts.callsInSource.bind(facts),
    carrierPath: carriers.carrierPath.bind(carriers),
    passesAssertion: carriers.passesAssertion.bind(carriers),
    narrowedToSuccess: carriers.narrowedToSuccess.bind(carriers),
    signatureForm: forms.signatureForm.bind(forms),
    unprovedNarrowing: proof.unprovedNarrowing.bind(proof),
    signatureDecode,
    decode,
  };
}
