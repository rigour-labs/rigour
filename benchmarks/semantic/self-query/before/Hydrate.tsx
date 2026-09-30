import { onMount } from 'solid-js';
export function Hydrate(props: { id: string }) {
  onMount(() => {
    for (const el of Array.from(document.querySelectorAll('[data-hydrate]'))) {
      if (el.getAttribute('data-hydrate') === props.id) el.remove();
    }
  });
  return <div data-hydrate={props.id} />;
}
