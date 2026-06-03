type Bag = {
  items: string[];
};

function pickItems({ items }: Bag): string[] {
  return items;
}

const selectItems = ({ items: selectedItems }: Bag): string[] => selectedItems;

void pickItems;
void selectItems;
