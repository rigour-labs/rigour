import { Show } from 'solid-js';
export function Head(props: { dev: boolean }) {
  return <div><Show when={props.dev}><span>dev</span></Show></div>;
}
