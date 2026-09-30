import * as Solid from 'solid-js';
export function Hydrate(props: { id: string }) {
  let marker: HTMLDivElement | undefined;
  Solid.onMount(() => marker?.remove());
  return <div ref={marker} data-hydrate={props.id} />;
}
