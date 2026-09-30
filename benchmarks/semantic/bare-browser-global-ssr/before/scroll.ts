declare const isServer: boolean;
export function setup(onHide: () => void) {
  if (isServer) return;
  history.scrollRestoration = 'manual';
}
