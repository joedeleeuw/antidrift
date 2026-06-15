// Same shape as firebase/auth UserInfo but under a different name.
// Unaccepted installed-package authority emits inventory facts only.

export type AuthUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
