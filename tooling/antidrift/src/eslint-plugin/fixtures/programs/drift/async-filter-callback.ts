async function keepExisting(ids: string[]) {
  return ids.filter(async (id) => (await fetch(`/items/${id}`)).ok);
}

void keepExisting;
