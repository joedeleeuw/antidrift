import { z } from "zod";

const postSchema = z.object({ id: z.string(), title: z.string() });

const contract = {
  getPost: {
    method: "GET",
    path: "/posts/:id",
    responses: { 200: postSchema },
  },
};

export function loadPost(raw: unknown) {
  const post = contract.getPost.responses[200].parse(raw);
  // redundant: the literal computed key resolves to the same canonical path
  return contract.getPost.responses[200].parse(post);
}
