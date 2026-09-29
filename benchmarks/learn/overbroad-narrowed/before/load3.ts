export function load3(url: string) {
  return fetch(url, { method: 'GET' });
}
