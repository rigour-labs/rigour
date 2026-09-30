interface Module { nameForCondition(): string | null; resource?: string }
const toPosix = (p: string) => p.replace(/\\/g, '/');
export function cssFor(mod: Module, byRoute: Map<string, string[]>): string[] {
  const routeFile = toPosix(mod.nameForCondition() ?? mod.resource ?? '');
  return byRoute.get(routeFile) ?? [];
}
