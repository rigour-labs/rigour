export interface InterpolateOptions {
  path: string;
  /** @internal */
  server?: boolean;
}
export function interpolatePath({ path, server }: InterpolateOptions): string {
  return server ? path : `/${path}`;
}
