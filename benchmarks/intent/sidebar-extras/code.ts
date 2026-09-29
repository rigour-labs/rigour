declare function fetchTipOfTheDay(): Promise<string>;
declare function fetchCommunityHighlights(): Promise<string[]>;

/** Optional sidebar extras. The page renders without them. */
export async function sidebarExtras() {
  const [tip, highlights] = await Promise.all([fetchTipOfTheDay(), fetchCommunityHighlights()]);
  return { tip, highlights };
}
