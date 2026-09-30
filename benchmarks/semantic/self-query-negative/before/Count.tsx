import { onMount } from 'solid-js';
export function Count() {
  onMount(() => console.log(document.querySelectorAll('img').length));
  return <div />;
}
