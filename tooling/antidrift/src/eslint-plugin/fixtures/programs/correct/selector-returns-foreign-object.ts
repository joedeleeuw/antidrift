type Bag = { items: string[] };
const fallback = ["missing"];

function pickItems(_bag: Bag): string[] {
  return fallback;
}

void pickItems;
