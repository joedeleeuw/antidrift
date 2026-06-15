// Loosened redeclaration of firebase/auth UserInfo — same shape, every field made optional.
// Agents commonly relax types this way; the `?` only appends `| undefined`.
// Unaccepted installed-package authority emits inventory facts only.

export type UserAttrs = {
  uid?: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  providerId?: string;
  phoneNumber?: string | null;
};
