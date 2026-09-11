export function chatRecipients(
  participants: {
    profile_id: string;
    notification_mode?: string;
    notifications_muted?: boolean;
  }[],
  activeIds: Set<string>,
  senderId: string,
  mentions: { profile_id: string }[],
) {
  const mentioned = new Set(mentions.map((m) => m.profile_id));
  return participants
    .filter((p) => {
      const mode =
        p.notification_mode ?? (p.notifications_muted ? "muted" : "all");
      return (
        p.profile_id !== senderId &&
        activeIds.has(p.profile_id) &&
        (mode === "all" || (mode === "mentions" && mentioned.has(p.profile_id)))
      );
    })
    .map((p) => p.profile_id);
}
