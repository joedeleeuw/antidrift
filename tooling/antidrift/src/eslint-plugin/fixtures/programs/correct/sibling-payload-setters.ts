declare function useState<T>(value: T): [T, (value: T) => void];

export function Dashboard() {
  const [left, setDataOne] = useState<string[]>([]);
  const [right, setDataTwo] = useState<string[]>([]);

  function update(nextLeft: string[], nextRight: string[]) {
    setDataOne(nextLeft);
    setDataTwo(nextRight);
  }

  return { left, right, update };
}
