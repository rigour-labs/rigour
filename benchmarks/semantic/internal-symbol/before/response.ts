export function getResponse(event: Record<symbol, unknown>) {
  // @ts-expect-error internal field
  return event[Symbol.for('h3.internal.event.res')];
}
