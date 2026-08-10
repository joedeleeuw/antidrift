// Exact structural redeclaration of firebase/auth UserInfo, including its
// readonly modifiers. Accepted package authority blocks on exact copies.

export type UserInfo = {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly providerId: string;
  readonly phoneNumber: string | null;
};
