declare const isServer: boolean;
export function setup(onHide: () => void) {
  if (isServer) return;
  window.history.scrollRestoration = 'manual';
}
