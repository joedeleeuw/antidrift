import { PHASES } from "./owner";

export type Phase = (typeof PHASES)[number];
export const phases = PHASES;
