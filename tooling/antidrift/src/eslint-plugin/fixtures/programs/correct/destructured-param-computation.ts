type Bag = {
  items: string[];
};

function countItems({ items }: Bag): number {
  return items.length;
}

export function pickItemsBoundary({ items }: Bag): string[] {
  return items;
}

void countItems;
