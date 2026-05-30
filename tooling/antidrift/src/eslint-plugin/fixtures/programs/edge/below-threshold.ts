// Only 2-3 fields — too small to be a meaningful structural duplicate.
// Expected: 0 errors (below the minimum field threshold)

export type TinyUser = {
  uid: string;
  email: string;
};

export type ThreeFields = {
  uid: string;
  email: string | null;
  displayName: string | null;
};
