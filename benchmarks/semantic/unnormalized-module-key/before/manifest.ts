interface Module { nameForCondition(): string | null }
export function routeCss(modules: Module[], routes: Map<string, string[]>): string[] {
  const css: string[] = [];
  for (const mod of modules) {
    const file = mod.nameForCondition() ?? '';
    const found = routes.get(file);
    if (found) css.push(...found);
  }
  return css;
}
