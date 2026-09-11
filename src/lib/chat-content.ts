import type { ChatMention } from "./supabase/database.types";

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
export type ChatReaction = {
  message_id: string;
  profile_id: string;
  emoji: string;
  name: string;
};
export type ChatPreview = {
  message_id: string;
  url: string;
  status: "pending" | "ready" | "failed";
  title: string | null;
  description: string | null;
  image_data: string | null;
};
export type ChatExtras = { reactions: ChatReaction[]; previews: ChatPreview[] };
export function linksInText(
  text: string,
): { start: number; end: number; url: string }[] {
  return [...text.matchAll(/https?:\/\/[^\s<>]+/gi)].flatMap((m) => {
    const url = m[0].replace(/[.,!?;:)\]}]+$/, "");
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.username || parsed.password) return [];
    } catch {
      return [];
    }
    return [{ start: m.index!, end: m.index! + url.length, url }];
  });
}
// Retain only mentions untouched by a text edit, shifting those after it.
export function editMentions(
  oldText: string,
  newText: string,
  mentions: ChatMention[],
): ChatMention[] {
  const a = Array.from(oldText),
    b = Array.from(newText);
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return mentions.flatMap((m) => {
    if (m.end <= start) return [m];
    if (m.start >= endA)
      return [{ ...m, start: m.start + endB - endA, end: m.end + endB - endA }];
    return [];
  });
}
export function trimMentionDraft(body: string, mentions: ChatMention[]) {
  const leading = Array.from(body).length - Array.from(body.trimStart()).length;
  return {
    body: body.trim(),
    mentions: mentions.map((m) => ({
      ...m,
      start: m.start - leading,
      end: m.end - leading,
    })),
  };
}
