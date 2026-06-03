declare function useState<T>(value: T): [T, (value: T) => void];

function First() {
  const [count, setCount] = useState(0);
  return () => setCount(count + 1);
}

function Second() {
  const [name, setName] = useState("");
  return () => setName(name.trim());
}

void First;
void Second;
