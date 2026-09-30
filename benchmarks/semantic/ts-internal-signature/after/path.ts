export interface InterpolateOptions {
  path: string;
  /** @internal */
  server?: boolean;
}
export function interpolatePath({ path, ...rest }: InterpolateOptions): string {
  return rest.server ? path : `/${path}`;
}
