import { desktopContract } from "../support/desktop-contract";

// Two different slots of the same contract are different schemas.
export function roundTrip(raw: unknown) {
  const request = desktopContract.getRuntimeInfo.requestSchema.parse(raw);
  return desktopContract.getRuntimeInfo.resultSchema.parse(request);
}
