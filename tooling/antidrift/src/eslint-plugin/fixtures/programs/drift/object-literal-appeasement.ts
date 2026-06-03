const helpers = {
  pickPoint(bag: { point: number }): number {
    return bag.point;
  },
  hasActive(value: unknown): boolean {
    return typeof value === "object"
      && value !== null
      && "user" in value
      && typeof value.user === "object"
      && value.user !== null
      && "active" in value.user
      && typeof value.user.active === "boolean";
  },
};

export const pickPoint = helpers.pickPoint;
export const hasActive = helpers.hasActive;
