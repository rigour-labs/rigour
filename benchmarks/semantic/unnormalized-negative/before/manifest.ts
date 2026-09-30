interface Module { nameForCondition(): string | null }
export function first(modules: Module[], routes: Map<string, string>): string | undefined {
  const file = modules[0]?.nameForCondition() ?? '';
  return routes.get(file);
}
