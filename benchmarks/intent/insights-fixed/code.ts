declare function fetchJourneyImpact(key: string): Promise<{ lift: number }>;
declare function fetchStepEngagement(key: string): Promise<{ steps: string[] }>;

async function optionalDiagnosis(key: string): Promise<{ steps: string[] } | null> {
  try {
    return await fetchStepEngagement(key);
  } catch {
    return null;
  }
}

export async function journeyInsights(key: string) {
  const [impact, diagnosis] = await Promise.all([fetchJourneyImpact(key), optionalDiagnosis(key)]);
  return { impact, steps: diagnosis?.steps ?? [], stepsAvailable: diagnosis !== null };
}
