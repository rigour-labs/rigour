export interface Renderable {
  html: string;
}
export function render(input: string): Renderable {
  return { html: input };
}
