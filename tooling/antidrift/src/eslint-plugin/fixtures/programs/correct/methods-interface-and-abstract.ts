// Type-level and abstract method signatures MUST carry explicit return types — they have no body to
// infer from. Neither should ever be flagged.
// Expected — both rules: 0
interface ItemRepo {
  getItemsFromBag(bag: { items: number[] }): number[];
}
abstract class BaseStore {
  abstract getItemsFromBag(bag: { items: number[] }): number[];
}
