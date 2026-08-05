import { z } from "zod";

const sceneStateSchema = z.object({
  tokens: z.array(z.string()),
  revision: z.number(),
});
type SceneState = z.infer<typeof sceneStateSchema>;

declare function adaptGameState(): SceneState;

// A contract oracle: the test asserts the adapter's output is schema-valid.
// The parameter is typed as the schema output, and re-parsing it is the point.
export function assertSceneContract(sceneState: SceneState): void {
  sceneStateSchema.parse(sceneState);
}

export function run(): void {
  assertSceneContract(adaptGameState());
}
