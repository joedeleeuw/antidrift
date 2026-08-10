declare const someObservable: {
  transform<T>(callback: (value: { a: string }) => T): T;
};

export const transformed = someObservable.transform((record) => ({
  a: record.a,
}));
