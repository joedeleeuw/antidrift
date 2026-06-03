// Internal (non-exported) class — its methods are NOT a public boundary, so inference-appeasement
// helpers should be flagged exactly as free functions are.
// Expected — no-trivial-selector-wrapper: 3 (getItemsFromBag, pickItems, firstItem)
class ItemStore {
  #items: number[] = [];
  getItemsFromBag(bag: { items: number[] }): number[] { return bag.items; }   // trivial selector wrapper
  pickItems(bag: { items: number[] }): number[] { return bag.items; }         // same wrapper, no name fingerprint
  private computeTotal(x: { a: number }): number { return x.a * 2; }           // private helper, explicit return
  private firstItem = (xs: number[]): number => xs[0];                         // private field arrow, explicit return
  get count(): number { return this.#items.length; }                          // getter — idiomatic, must NOT fire
  constructor() {}                                                            // constructor — must NOT fire
}
