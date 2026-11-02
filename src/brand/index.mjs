export function brand(name, check) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("brand(name, check) requires a non-empty brand name.");
  }
  if (typeof check !== "function") {
    throw new TypeError(`brand(${name}) requires a validation function.`);
  }

  const api = {
    name,
    make(candidate) {
      if (check(candidate)) return candidate;
      throw new TypeError(`Invalid ${name} value.`);
    },
    safe(candidate) {
      try {
        return { ok: true, value: api.make(candidate) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    is(candidate) {
      return check(candidate);
    },
  };

  return Object.freeze(api);
}
