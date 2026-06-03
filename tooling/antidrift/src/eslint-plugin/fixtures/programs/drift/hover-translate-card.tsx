function cn(...classes: string[]) {
  return classes.join(" ");
}

export function ProductCard() {
  return <article className={cn("rounded-md border border-border", "hover:-translate-y-1")}>Plan</article>;
}
