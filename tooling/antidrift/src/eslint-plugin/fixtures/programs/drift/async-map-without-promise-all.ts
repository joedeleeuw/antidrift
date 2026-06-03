async function loadItems(ids: string[]) {
  return ids.map(async (id) => fetch(`/items/${id}`));
}

void loadItems;
