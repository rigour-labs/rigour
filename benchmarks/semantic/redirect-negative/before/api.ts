export async function getProfile(base: string, token: string) {
  return fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
}
