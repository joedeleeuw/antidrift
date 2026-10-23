export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function translate(bounds: Bounds, dx: number, dy: number): Bounds {
  return { ...bounds, left: bounds.left + dx, top: bounds.top + dy };
}
