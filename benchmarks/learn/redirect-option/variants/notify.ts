export async function notify(hook: string, token: string) {
  return fetch(hook, { method: 'POST', headers: { 'x-hook-token': token } });
}

export async function notifySafely(hook: string, token: string) {
  return fetch(hook, { method: 'POST', redirect: 'error', headers: { 'x-hook-token': token } });
}
