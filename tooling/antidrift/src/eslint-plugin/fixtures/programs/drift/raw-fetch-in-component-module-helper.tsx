async function downloadFile(url: string) {
  return fetch(url);
}

export function FileActionCard() {
  return (
    <button onClick={() => void downloadFile("/file.png")}>Download</button>
  );
}
