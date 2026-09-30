export function onHide(fn: () => void) {
  addEventListener('pagehide', fn);
}
