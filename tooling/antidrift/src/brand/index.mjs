export function brand(name, check) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("brand(name, check) requires a non-empty brand name.");
  }
  if (typeof check !== "function") {
    throw new TypeError(`brand(${name}) requires a validation function.`);
  }

  const api = {
    name,
    make(value) {
      if (check(value)) return value;
      throw new TypeError(`Invalid ${name} value.`);
    },
    safe(value) {
      try {
        return { ok: true, value: api.make(value) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    is(value) {
      return check(value);
    },
  };

  return Object.freeze(api);
}
