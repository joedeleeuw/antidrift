// Exported class — public methods ARE the public boundary, so explicit return types are correct
// there and trivial-looking names must not be flagged.
// Expected — both rules: 0
export class ItemApi {
  getItemsFromBag(bag: { items: number[] }): number[] { return bag.items; }
  fetchTotal(x: { a: number }): number { return x.a * 2; }
  get count(): number { return 0; }
  constructor() {}
}
