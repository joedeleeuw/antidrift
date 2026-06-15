// Full structural redeclaration of firebase/auth UserInfo.
// Unaccepted installed-package authority emits inventory facts only.

export type UserInfo = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
