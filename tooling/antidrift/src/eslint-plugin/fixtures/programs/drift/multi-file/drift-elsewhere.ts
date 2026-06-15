// Separate file in the same project that redeclares firebase shapes without importing.
// The rule should emit an installed-package inventory fact even though a sibling imports correctly.

export type UserData = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
