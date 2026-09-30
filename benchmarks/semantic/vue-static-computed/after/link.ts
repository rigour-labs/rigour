import { computed } from 'vue';
export function useLink(props: { href: string }) {
  return computed(() => ({ href: props.href }));
}
