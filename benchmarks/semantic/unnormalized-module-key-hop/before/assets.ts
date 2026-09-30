interface Module { nameForCondition(): string | null; resource?: string }
export function cssFor(mod: Module, byRoute: Map<string, string[]>): string[] {
  const name = mod.nameForCondition();
  const routeFile = name ?? mod.resource ?? '';
  return byRoute.get(routeFile) ?? [];
}
