// Same field names as firebase UserInfo but structurally incompatible types.
// Defines the boundary: the rule must check types, not just names.
// Expected: 0 errors (field types don't match — this is not a structural duplicate)
// NOTE: a property-name-only fingerprint would incorrectly fire here.
// This case validates that the implementation uses type-checking, not just name-matching.

export type NotFirebase = {
  uid: number;
  email: boolean;
  displayName: number;
  photoURL: number;
  providerId: boolean;
  phoneNumber: number;
};
