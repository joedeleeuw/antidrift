// Same shape as firebase/auth UserInfo but under a different name — classic agent drift.
// Expected: 1 error on AuthUser

export type AuthUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
