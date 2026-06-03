type UserId = string & { readonly __brand: "UserId" };

const raw = "user-1";
const userId = raw as unknown as UserId;

void userId;
