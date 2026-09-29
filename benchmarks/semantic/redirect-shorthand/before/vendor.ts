const VENDOR_BASE_URL = process.env.VENDOR_BASE_URL ?? 'https://vendor.example';

export async function submit(apiKey: string, text: string) {
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey };
  return fetch(`${VENDOR_BASE_URL}/task`, { method: 'POST', headers, body: JSON.stringify({ text }) });
}
