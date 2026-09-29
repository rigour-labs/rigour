declare function fetchJourneyImpact(key: string): Promise<{ lift: number; people: number }>;
declare function fetchStepEngagement(key: string): Promise<{ steps: Array<{ slot: string; clicks: number }> }>;
declare function loadJourneySlots(key: string): Promise<Array<{ slot: string; label: string }>>;

/** The impact of a journey on product use, with a per-step diagnosis for the drill-down. */
export async function journeyInsights(key: string) {
  const [impact, engagement, slots] = await Promise.all([
    fetchJourneyImpact(key),
    fetchStepEngagement(key),
    loadJourneySlots(key),
  ]);
  const labels = new Map(slots.map((s) => [s.slot, s.label]));
  return {
    impact,
    steps: engagement.steps.map((s) => ({ ...s, label: labels.get(s.slot) ?? s.slot })),
  };
}
