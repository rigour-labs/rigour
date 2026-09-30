import { Show } from 'solid-js';
export function Head(props: { dev: boolean }) {
  return <div>{props.dev && <span>dev</span>}</div>;
}
