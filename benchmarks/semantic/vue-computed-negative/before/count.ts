import { computed, ref } from 'vue';
export function useCount() {
  const count = ref(0);
  return computed(() => count);
}
