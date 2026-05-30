// 4 fields that are all present in firebase UserInfo — above threshold but a proper subset.
// Defines the boundary for partial-match sensitivity.
// Expected: 1 error — subset with correct types should still be flagged.
// Rationale: an agent that redeclared 4 of 6 firebase fields still has semantic drift.

export type PartialUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
};
