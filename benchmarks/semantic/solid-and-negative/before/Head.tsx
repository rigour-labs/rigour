import { useState } from 'react';
export function Head(props: { dev: boolean }) {
  return <div>{props.dev && <span>dev</span>}</div>;
}
