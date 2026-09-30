export function load(id: string) {
  if (id === 'virtual:mock') return { code: 'export const a = 1;\nexport default {}' };
  return null;
}
