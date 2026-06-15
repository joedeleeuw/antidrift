// 4 fields that are all present in firebase UserInfo, above threshold but a proper subset.
// Unaccepted installed-package authority emits inventory facts only.

export type PartialUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
};
