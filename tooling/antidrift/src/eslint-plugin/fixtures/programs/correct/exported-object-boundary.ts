export const api = {
  pickPoint(bag: { point: number }): number {
    return bag.point;
  },
};

const defaultApi = {
  pickPoint(bag: { point: number }): number {
    return bag.point;
  },
};

export default defaultApi;
