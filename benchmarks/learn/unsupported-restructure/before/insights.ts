declare function readImpact(key: string): Promise<number>;
declare function readSteps(key: string): Promise<string[]>;

export async function insights(key: string) {
  const [impact, steps] = await Promise.all([readImpact(key), readSteps(key)]);
  return { impact, steps };
}
