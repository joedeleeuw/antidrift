import { z } from "zod";

const ChatModelEndpointSchema = z.object({
  id: z.string(),
  endpoint: z.string(),
});
type ChatModelEndpoint = z.infer<typeof ChatModelEndpointSchema>;

const models: ChatModelEndpoint[] = [
  { id: "primary", endpoint: "https://example.com/chat" },
];

export function modelById(id: string) {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`Unknown model: ${id}`);
  }
  return ChatModelEndpointSchema.parse(model);
}
