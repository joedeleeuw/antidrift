// A first-party contract that forgets the event's kind.
export interface LooseEvent {
  readonly kind: string;
  readonly payload: unknown;
}
