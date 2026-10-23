type Created = { kind: "created"; id: string };
type Deleted = { kind: "deleted"; id: string; reason: string };
type ChangeEvent = Created | Deleted;

// Every caller passes a Created event; the comparison re-derives it.
function describeChange(change: ChangeEvent): string {
  if (change.kind === "created") {
    return change.id;
  }
  return change.reason;
}
export function describeCreated(created: Created) {
  return describeChange(created);
}

// Every caller passes a string; the typeof re-derives it.
function labelOf(input: unknown): string {
  return typeof input === "string" ? input : String(input);
}
export const labels = [labelOf("draft"), labelOf("final")];

type User = { id: string; name: string };
declare function loadUser(): User;
declare function saveUser(user: User): void;

// The loaded user is widened to any and forwarded into a slot that demands User.
export function syncUser() {
  const loaded: any = loadUser();
  saveUser(loaded);
}

type ServerConfig = { port: number; host: string };

// Every caller passes a config with a port; the in check re-derives the key.
function portLabel(config: object) {
  return "port" in config ? "port set" : "no port";
}
export const portText = portLabel({
  port: 8080,
  host: "localhost",
} satisfies ServerConfig);

class HttpFailure extends Error {
  readonly status = 500;
}

// The error is widened to Error and the instanceof re-derives the subclass.
export function failureStatus() {
  const failure: Error = new HttpFailure("boom");
  return failure instanceof HttpFailure ? failure.status : 0;
}

function isUser(candidate: unknown): candidate is User {
  return (
    typeof candidate === "object" && candidate !== null && "id" in candidate
  );
}

// Every caller passes a User; the guard call re-derives it.
function userName(candidate: unknown): string {
  return isUser(candidate) ? candidate.name : "";
}
export const userNameText = userName(loadUser());
