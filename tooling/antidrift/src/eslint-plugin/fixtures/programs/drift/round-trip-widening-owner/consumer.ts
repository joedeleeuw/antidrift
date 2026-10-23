import type { LooseEvent } from "./contract";

type ClickEvent = { readonly kind: "click"; readonly payload: { x: number } };

function payloadX(event: LooseEvent): number {
  const payload = event.payload as { x: number };
  return payload.x;
}

export function onClick(click: ClickEvent) {
  return payloadX(click);
}
