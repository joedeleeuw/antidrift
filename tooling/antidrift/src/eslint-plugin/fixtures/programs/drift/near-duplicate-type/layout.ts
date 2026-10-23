import { translate } from "./geometry";

export interface StateBoxBounds {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function moveBox(box: StateBoxBounds): StateBoxBounds {
  return { ...box, ...translate(box, 8, 8) };
}
