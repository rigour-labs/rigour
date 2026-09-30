import { onMount } from 'solid-js';
export function Hydrate(props: { id: string }) {
  let marker: HTMLDivElement | undefined;
  onMount(() => marker?.remove());
  return <div ref={marker} data-hydrate={props.id} />;
}
