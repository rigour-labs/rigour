import template from '@babel/template';
export const a = template.statement`import { x } from './local';`;
export const b = template.statement`import { y } from 'my-plugin/runtime';`;
export const docs = "import { z } from 'undeclared-pkg';";
