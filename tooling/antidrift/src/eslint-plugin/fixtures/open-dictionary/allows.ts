interface Message {
  title: string;
}

export function receive(input: Message): string {
  return input.title;
}
