// Generic container with 4+ fields. Its property types reference the type parameter, so it does
// not structurally match any concrete canonical package type.
// Expected: 0 errors.
export type Result<T> = {
  data: T;
  error: string | null;
  loading: boolean;
  status: number;
};
