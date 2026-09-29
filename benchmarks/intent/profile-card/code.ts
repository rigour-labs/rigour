declare function loadProfile(id: string): Promise<{ id: string; displayName: string; email: string }>;
declare function loadAvatarUrl(id: string): Promise<string>;

/** A profile card. Without an avatar the card shows the person's initials. */
export async function profileCard(id: string) {
  const [profile, avatarUrl] = await Promise.all([loadProfile(id), loadAvatarUrl(id)]);
  return { ...profile, avatarUrl, initials: profile.displayName.slice(0, 2).toUpperCase() };
}
