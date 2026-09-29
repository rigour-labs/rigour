declare function getAccount(userId: string): Promise<{ name: string; plan: string; balance: number }>;
declare function getRecommendedCourses(userId: string): Promise<Array<{ id: string; title: string }>>;

/** The home dashboard: the account summary, plus a "you might like" strip underneath. */
export async function loadDashboard(userId: string) {
  const [account, recommended] = await Promise.all([getAccount(userId), getRecommendedCourses(userId)]);
  return { account, youMightLike: recommended.slice(0, 4) };
}
