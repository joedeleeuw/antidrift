export interface Panel {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function panelArea(panel: Panel): number {
  return panel.width * panel.height;
}
