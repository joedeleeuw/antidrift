// Separate file in the same project that redeclares firebase shapes without importing.
// The rule must catch this even though correct-import.ts exists in the same directory.
// Expected: 1 error on UserData

export type UserData = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
