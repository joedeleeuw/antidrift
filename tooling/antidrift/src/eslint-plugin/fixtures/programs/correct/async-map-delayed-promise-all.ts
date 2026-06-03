async function loadItems(ids: string[]) {
  const pendingItems = ids.map(async (id) => fetch(`/items/${id}`));
  return Promise.all(pendingItems);
}

void loadItems;
