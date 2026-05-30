// Loosened redeclaration of firebase/auth UserInfo — same shape, every field made optional.
// Agents commonly relax types this way; the `?` only appends `| undefined`, so this is still a
// structural fork of the canonical required shape.
// Expected: 1 error on UserAttrs

export type UserAttrs = {
  uid?: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  providerId?: string;
  phoneNumber?: string | null;
};
