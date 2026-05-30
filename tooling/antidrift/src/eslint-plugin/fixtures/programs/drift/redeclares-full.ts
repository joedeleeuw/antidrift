// Full structural redeclaration of firebase/auth UserInfo — no import from firebase.
// Expected: 1 error on UserInfo (matches firebase/auth#UserInfo shape)

export type UserInfo = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
