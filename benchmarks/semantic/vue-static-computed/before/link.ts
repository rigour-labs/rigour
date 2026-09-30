import { computed } from 'vue';
export function useLink(props: { href: string }) {
  const attrs = { href: props.href };
  return computed(() => attrs);
}
