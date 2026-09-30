export function setupScroll(onHide: () => void) {
  window.addEventListener('scroll', onHide);
  window.addEventListener('pagehide', onHide);
}
