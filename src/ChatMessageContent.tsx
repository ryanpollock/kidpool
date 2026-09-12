import { useEffect, useRef, useState } from "react";
import { BottomSheet, useKeyboard } from "./mobile";
import type { ChatMessageRow } from "./lib/supabase/database.types";
import {
  linksInText,
  REACTIONS,
  type ChatReaction,
  type ChatPreview,
} from "./lib/chat-content";

export function MessageText({ message }: { message: ChatMessageRow }) {
  const points = Array.from(message.body);
  const mentions = (message.mentions ?? []).map((m) => ({
    ...m,
    start: points.slice(0, m.start).join("").length,
    end: points.slice(0, m.end).join("").length,
  }));
  const tokens = [
    ...mentions.map((m) => ({ ...m, kind: "mention" as const, url: "" })),
    ...linksInText(message.body)
      .filter((l) => !mentions.some((m) => l.start < m.end && l.end > m.start))
      .map((l) => ({ ...l, kind: "link" as const })),
  ].sort((a, b) => a.start - b.start);
  let cursor = 0;
  const parts = tokens.flatMap((t, i) => {
    const before = message.body.slice(cursor, t.start);
    cursor = t.end;
    const label = message.body.slice(t.start, t.end);
    return [
      before,
      t.kind === "mention" ? (
        <mark className="chat-mention" key={i}>
          {label}
        </mark>
      ) : (
        <a key={i} href={t.url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ),
    ];
  });
  return (
    <>
      {parts}
      {message.body.slice(cursor)}
    </>
  );
}

export function MessageEnhancements({
  message,
  reactions,
  preview,
  myProfileId,
  onReact,
  children,
}: {
  message: ChatMessageRow;
  reactions: ChatReaction[];
  preview?: ChatPreview;
  myProfileId: string;
  onReact: (messageId: string, emoji: string | null) => Promise<void>;
  children: React.ReactNode;
}) {
  const keyboard = useKeyboard();
  const [picker, setPicker] = useState(false),
    [who, setWho] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    origin = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const open = () => {
    keyboard.hide();
    setPicker(true);
  };
  const mine = reactions.find((r) => r.profile_id === myProfileId)?.emoji;
  const react = async (emoji: string) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await onReact(message.id, mine === emoji ? null : emoji);
      setPicker(false);
    } catch {
      setError("Could not save reaction. Please try again.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="chat-message-enhancements" data-message-id={message.id}>
      <div>{children}</div>
      {preview?.status === "ready" ? (
        <a
          className="chat-link-card"
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="chat-link-preview"
        >
          {preview.image_data ? (
            <img
              src={preview.image_data}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : null}
          <span>
            <small>{new URL(preview.url).hostname}</small>
            <strong>{preview.title || new URL(preview.url).hostname}</strong>
            {preview.description ? <span>{preview.description}</span> : null}
          </span>
        </a>
      ) : null}
      {message.sender_kind === "parent" ? (
        <div className="chat-reactions">
          <button
            className="chat-quick-reaction"
            data-reacted={Boolean(mine)}
            aria-label="Thumbs up; hold to choose a reaction"
            aria-pressed={mine === "👍"}
            disabled={working}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              cancel();
              suppressClick.current = false;
              origin.current = { x: e.clientX, y: e.clientY };
              timer.current = setTimeout(() => {
                suppressClick.current = true;
                open();
              }, 500);
            }}
            onPointerMove={(e) => {
              if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 8) {
                suppressClick.current = true;
                cancel();
              }
            }}
            onPointerUp={cancel}
            onPointerCancel={() => { suppressClick.current = true; cancel(); }}
            onPointerLeave={cancel}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => {
              if (e.detail !== 0 && suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              void react("👍");
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); open(); }
            }}
          >👍</button>
          {REACTIONS.filter((emoji) =>
            reactions.some((r) => r.emoji === emoji),
          ).map((emoji) => (
            <button
              key={emoji}
              className={
                mine === emoji ? "chat-reaction is-mine" : "chat-reaction"
              }
              aria-label={`${emoji} ${reactions.filter((r) => r.emoji === emoji).length} reactions; view people`}
              onClick={() => setWho(true)}
            >
              {emoji} {reactions.filter((r) => r.emoji === emoji).length}
            </button>
          ))}
        </div>
      ) : null}
      {error && !picker ? <p role="alert">{error}</p> : null}
      <BottomSheet
        open={picker}
        onOpenChange={setPicker}
        title="React to message"
        description="Choose a reaction. Choose yours again to remove it."
      >
        <div className="chat-reaction-picker">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              aria-label={`React ${emoji}`}
              aria-pressed={mine === emoji}
              disabled={working}
              onClick={() => void react(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </BottomSheet>
      <BottomSheet open={who} onOpenChange={setWho} title="Reactions">
        {reactions.map((r) => (
          <p key={r.profile_id}>
            {r.emoji} {r.name}
            {r.profile_id === myProfileId ? " (you)" : ""}
          </p>
        ))}
        <button
          className="text-button"
          onClick={() => {
            setWho(false);
            open();
          }}
        >
          Change your reaction
        </button>
      </BottomSheet>
    </div>
  );
}
