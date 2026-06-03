async function loadItems(ids: string[]) {
  return Promise.all(ids.map(async (id) => fetch(`/items/${id}`)));
}

void loadItems;
