declare function readImpact(key: string): Promise<number>;
declare function readSteps(key: string): Promise<string[]>;

async function optionalSteps(key: string): Promise<string[] | null> {
  try {
    return await readSteps(key);
  } catch {
    return null;
  }
}

export async function insights(key: string) {
  const [impact, steps] = await Promise.all([readImpact(key), optionalSteps(key)]);
  return { impact, steps: steps ?? [], stepsAvailable: steps !== null };
}
