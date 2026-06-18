import { useState } from "react";

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
