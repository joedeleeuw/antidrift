import { apiContract } from "./api-contract";

export function reload(raw: unknown) {
  const user = apiContract.getUser.responses[200].parse(raw);
  // redundant: same imported root binding, same segments
  return apiContract.getUser.responses[200].parse(user);
}
