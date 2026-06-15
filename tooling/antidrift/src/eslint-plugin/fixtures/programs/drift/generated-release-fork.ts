export type ReleaseRow = {
  id: string;
  appId: string;
  version: string;
  status: "draft" | "submitted" | "released";
  createdAt: number;
};
