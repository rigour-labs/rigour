import template from '@babel/template';
export const prelude = template.statement(
  `globalThis.__refresh?.()`,
)();
