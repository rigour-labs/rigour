export function setupScroll(onHide: () => void) {
  window.addEventListener('scroll', onHide);
  addEventListener('pagehide', onHide);
}
