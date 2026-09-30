export function load(id: string) {
  if (id === 'virtual:mock') return { code: 'export default {}', syntheticNamedExports: true };
  return null;
}
