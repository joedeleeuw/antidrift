async function downloadQrCode(url: string) {
  return fetch(url);
}

export function QrActionCard() {
  return <button onClick={() => void downloadQrCode("/qr.png")}>Download</button>;
}
