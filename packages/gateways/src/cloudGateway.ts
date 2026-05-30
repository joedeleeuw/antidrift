export type ObjectReference = {
  bucket: string;
  key: string;
};

export function formatObjectReference(reference: ObjectReference): string {
  return `${reference.bucket}/${reference.key}`;
}
