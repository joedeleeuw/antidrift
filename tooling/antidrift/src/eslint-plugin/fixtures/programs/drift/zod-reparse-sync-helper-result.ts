import { z } from "zod";

const ModelSchema = z.object({ id: z.string(), endpoint: z.string() });
type Model = z.infer<typeof ModelSchema>;

function loadModel(): Model {
  return ModelSchema.parse({
    id: "primary",
    endpoint: "https://example.com/chat",
  });
}

export function assignedModel() {
  const model = loadModel();
  return ModelSchema.parse(model);
}

export function inlineModel() {
  return ModelSchema.parse(loadModel());
}
