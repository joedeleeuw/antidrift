import { z } from "zod";

const authSnapshotSchema = z.object({
  userId: z.string(),
  signedIn: z.boolean(),
});

const storedUserSchema = z.object({ id: z.string(), name: z.string() });
const inputUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  draftNote: z.string(),
});
type InputUser = z.infer<typeof inputUserSchema>;

const projectIdSchema = z.string().min(1);

const astFactsSchema = z
  .object({ decisionPointCount: z.number().int().nonnegative() })
  .strict();
type AstFactsInput = z.input<typeof astFactsSchema>;

export function parseUnknownBoundary(payload: unknown) {
  return authSnapshotSchema.parse(payload);
}

export function parseAnyBoundary(payload: any) {
  return authSnapshotSchema.parse(payload);
}

export function narrowRicherInput(user: InputUser) {
  return storedUserSchema.parse(user);
}

// Refinement-carrying schema: the declared type is plain `string`, so `.min(1)`
// is a real runtime check the type system cannot express.
export function validateProjectId(projectId: string) {
  return projectIdSchema.parse(projectId);
}

// `z.input` is the pre-validation contract; parsing it is the boundary, not a cast.
export function validateAstFacts(astFacts: AstFactsInput) {
  return astFactsSchema.parse(astFacts);
}
