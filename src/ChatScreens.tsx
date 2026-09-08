// Chat screens: inbox (Chat tab), 1:1/group/everyone thread view, the
// new-conversation sheet, and Crew AI proposal cards.
//
// This file is app-owned UI (same boundary as Prototype.tsx — the
// mobile runtime itself stays untouched). Runtime contract compliance:
//   - Message lists live inside MobileScroll; headers/composers stay
//     outside it as fixed chrome.
//   - Text entry uses KeyboardTextarea/KeyboardInput only.
//   - The composer positions itself from useKeyboardInsets().bottomInset,
//     never from the raw viewport bottom edge or keyboard height alone.
//   - keyboard.hide() fires in the same event as closing the thread or
//     dismissing the new-conversation flow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AvatarIcon,
  BellIcon,
  CheckCircledIcon,
  ChatBubbleIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PaperPlaneIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import { BottomSheet, KeyboardInput, KeyboardTextarea, MobileScroll, useKeyboard, useKeyboardInsets } from "./mobile";
import { getSupabaseClient, type CarpoolRepository, type ChatThreadSummary } from "./lib/supabase";
import type {
  ChatMessageRow,
  ChatProposalRow,
  ChatProposalStatus,
  ChatSenderKind,
} from "./lib/supabase/database.types";

import "./chat.css";

const CHAT_PAGE_SIZE = 60;

// Merge a message into the chronological list, deduped by id and ordered by
// created_at. Realtime delivery can lag (a sender's own message appears via
// the local append while other parents' events are still in flight), so
// blind appends would misorder the thread — insert at the created_at position.
function mergeMessageChronological(
  current: ChatMessageRow[],
  incoming: ChatMessageRow,
): ChatMessageRow[] {
  if (current.some((m) => m.id === incoming.id)) return current;
  const at = new Date(incoming.created_at).getTime();
  let index = current.length;
  for (let i = current.length - 1; i >= 0; i--) {
    if (new Date(current[i].created_at).getTime() <= at) break;
    index = i;
  }
  return [...current.slice(0, index), incoming, ...current.slice(index)];
}

function readableChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (/do not have access/i.test(message)) return "You don't have access to this conversation.";
  if (/not an active member/i.test(message)) return "That parent is no longer in the carpool group.";
  if (/need a name/i.test(message)) return "Give your group conversation a name.";
  if (/at least one parent/i.test(message)) return "Select at least one parent.";
  if (/expired/i.test(message)) return "This proposal already expired.";
  if (/no longer pending/i.test(message)) return "This proposal was already handled.";
  if (/network|fetch/i.test(message)) return "We couldn't reach the carpool service. Check your connection and try again.";
  return message;
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function initialsOf(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatChatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      .toLowerCase()
      .replace(/\s/g, "");
  }
  const daysAgo = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo < 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }
  return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

function formatBubbleTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function ChatAvatar({
  url,
  name,
  size = 34,
  className,
}: {
  url: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  if (url) {
    return <img src={url} alt={name} width={size} height={size} className={`chat-avatar ${className ?? ""}`} />;
  }
  return (
    <span
      aria-label={name}
      className={`chat-avatar chat-avatar--initials ${className ?? ""}`}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }}
    >
      {initialsOf(name) || <AvatarIcon width={Math.round(size * 0.55)} height={Math.round(size * 0.55)} />}
    </span>
  );
}

function threadTitle(thread: ChatThreadSummary, myProfileId: string): string {
  if (thread.kind === "everyone") return "Everyone";
  if (thread.kind === "group") return thread.title ?? "Group conversation";
  const other = thread.participants.find((p) => p.id !== myProfileId) ?? thread.participants[0];
  return other?.name ?? "Conversation";
}

function threadSubtitle(thread: ChatThreadSummary, myProfileId: string): string {
  if (thread.kind === "everyone") {
    return `${thread.participants.length} parent${thread.participants.length === 1 ? "" : "s"}`;
  }
  const others = thread.participants.filter((p) => p.id !== myProfileId);
  if (others.length === 0) return "Just you";
  return others.map((p) => firstName(p.name)).join(", ");
}

function inboxPreview(thread: ChatThreadSummary): string {
  if (!thread.last_message_body) return "No messages yet";
  const body = thread.last_message_body.length > 90
    ? `${thread.last_message_body.slice(0, 90)}…`
    : thread.last_message_body;
  if (thread.last_message_sender_kind === "system") return body;
  if (thread.last_message_sender_kind === "agent") return `Crew AI: ${body}`;
  return body;
}

const PROPOSAL_LABELS: Record<string, string> = {
  cancel_ride: "Cancel a ride",
  switch_slot: "Change pickup time",
  swap_drive: "Swap a drive",
  coverage_fill: "Cover a drive",
};

const PROPOSAL_STATUS_LABELS: Record<ChatProposalStatus, string> = {
  pending: "Waiting for OK",
  confirmed: "Confirmed",
  executed: "Done",
  declined: "Declined",
  expired: "Expired",
  failed: "Failed",
};

function ProposalCard({
  proposal,
  myProfileId,
  working,
  error,
  onConfirm,
  onDecline,
}: {
  proposal: ChatProposalRow;
  myProfileId: string;
  working: boolean;
  error: string | null;
  onConfirm: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  const expired = proposal.status === "pending" && new Date(proposal.expires_at).getTime() <= Date.now();
  const status: ChatProposalStatus = expired ? "expired" : proposal.status;
  const canAct =
    proposal.status === "pending" &&
    !expired &&
    (!proposal.required_confirmer_profile_id || proposal.required_confirmer_profile_id === myProfileId);

  return (
    <div className={`chat-proposal chat-proposal--${status}`} data-testid="chat-proposal-card">
      <div className="chat-proposal-head">
        <span className="chat-proposal-kinds"><CheckCircledIcon width="16" height="16" /></span>
        <div>
          <span className="chat-proposal-kind">{PROPOSAL_LABELS[proposal.kind] ?? "Proposal"}</span>
          <p className="chat-proposal-summary">{proposal.summary}</p>
        </div>
      </div>
      {error ? <div className="chat-proposal-error" role="alert">{error}</div> : null}
      {canAct ? (
        <div className="chat-proposal-actions">
          <button
            className="chat-proposal-confirm"
            disabled={working}
            onClick={() => onConfirm(proposal.id)}
            data-testid="chat-proposal-confirm"
          >
            Confirm
          </button>
          <button
            className="chat-proposal-decline"
            disabled={working}
            onClick={() => onDecline(proposal.id)}
            data-testid="chat-proposal-decline"
          >
            Not now
          </button>
        </div>
      ) : (
        <span className={`chat-proposal-status chat-proposal-status--${status}`}>
          {PROPOSAL_STATUS_LABELS[status]}
        </span>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  mine,
  showName,
  proposal,
  myProfileId,
  proposalWorking,
  proposalError,
  onConfirmProposal,
  onDeclineProposal,
}: {
  message: ChatMessageRow;
  mine: boolean;
  showName: boolean;
  proposal: ChatProposalRow | null;
  myProfileId: string;
  proposalWorking: boolean;
  proposalError: string | null;
  onConfirmProposal: (id: string) => void;
  onDeclineProposal: (id: string) => void;
}) {
  if (message.sender_kind === "system") {
    return (
      <div className="chat-system-note" data-testid="chat-system-note">
        <p>{message.body}</p>
      </div>
    );
  }

  const isAgent = message.sender_kind === "agent";

  return (
    <div className={mine ? "chat-bubble-row chat-bubble-row--mine" : "chat-bubble-row"}>
      {!mine ? (
        <ChatAvatar
          url={isAgent ? null : message.sender_avatar_url}
          name={isAgent ? "Crew AI" : message.sender_name}
          size={28}
          className={isAgent ? "chat-avatar--agent" : undefined}
        />
      ) : null}
      <div className={mine ? "chat-bubble chat-bubble--mine" : isAgent ? "chat-bubble chat-bubble--agent" : "chat-bubble"}>
        {showName && !mine ? (
          <span className={`chat-bubble-name ${isAgent ? "chat-bubble-name--agent" : ""}`}>
            {isAgent ? <><ChatBubbleIcon width="11" height="11" /> Crew AI</> : message.sender_name}
          </span>
        ) : null}
        <p className="chat-bubble-body">{message.body}</p>
        <span className="chat-bubble-time">{formatBubbleTime(message.created_at)}</span>
      </div>
      {proposal ? (
        <div className="chat-proposal-wrap">
          <ProposalCard
            proposal={proposal}
            myProfileId={myProfileId}
            working={proposalWorking}
            error={proposalError}
            onConfirm={onConfirmProposal}
            onDecline={onDeclineProposal}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── New conversation sheet ─────────────────────────────────────

export type ChatDirectoryEntry = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  household_id: string;
  household_name: string;
  role: string;
};

export function NewChatSheet({
  open,
  onOpenChange,
  directory,
  myProfileId,
  loading,
  working,
  error,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: ChatDirectoryEntry[];
  myProfileId: string;
  loading: boolean;
  working: boolean;
  error: string | null;
  onCreate: (profileIds: string[], title: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setSelected([]);
      setTitle("");
      setSheetError(null);
    }
  }, [open]);

  const candidates = useMemo(() => {
    const term = search.trim().toLowerCase();
    return directory
      .filter((m) => m.id !== myProfileId)
      .filter((m) => !term || m.full_name.toLowerCase().includes(term) || m.household_name.toLowerCase().includes(term));
  }, [directory, search, myProfileId]);

  const byId = useMemo(() => new Map(directory.map((m) => [m.id, m])), [directory]);
  const selectedCount = selected.length;

  const toggle = (id: string) => {
    setSheetError(null);
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  };

  const start = () => {
    if (selectedCount === 0) {
      setSheetError("Select at least one parent.");
      return;
    }
    if (selectedCount >= 2 && !title.trim()) {
      setSheetError("Give your group conversation a name.");
      return;
    }
    onCreate(selected, title.trim());
  };

  const startLabel =
    selectedCount === 0
      ? "Select parents"
      : selectedCount === 1
        ? `Message ${firstName(byId.get(selected[0])?.full_name ?? "parent")}`
        : `Start group (${selectedCount})`;

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="New conversation">
      <div className="chat-newchat" data-testid="chat-new-chat">
        <div className="chat-newchat-search">
          <MagnifyingGlassIcon width="16" height="16" />
          <KeyboardInput
            placeholder="Search parents"
            value={search}
            autoComplete="off"
            onChange={(e) => setSearch(e.target.value)}
            data-testid="chat-new-chat-search"
          />
        </div>

        {selectedCount >= 2 ? (
          <div className="chat-newchat-title">
            <KeyboardInput
              placeholder="Group name (required)"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="chat-new-chat-title"
            />
          </div>
        ) : null}

        <div className="chat-newchat-list">
          {loading ? (
            <p className="helper-copy">Loading parents…</p>
          ) : candidates.length === 0 ? (
            <p className="helper-copy">No parents match “{search}”.</p>
          ) : (
            candidates.map((m) => {
              const isSelected = selected.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={isSelected ? "chat-newchat-row chat-newchat-row--selected" : "chat-newchat-row"}
                  onClick={() => toggle(m.id)}
                  data-testid={`chat-new-chat-member-${m.id}`}
                >
                  <ChatAvatar url={m.avatar_url} name={m.full_name} size={34} />
                  <span className="chat-newchat-row-info">
                    <strong>{m.full_name}</strong>
                    <small>{m.household_name}</small>
                  </span>
                  <span className={isSelected ? "chat-newchat-check chat-newchat-check--on" : "chat-newchat-check"}>
                    <CheckCircledIcon width="18" height="18" />
                  </span>
                </button>
              );
            })
          )}
        </div>

        {sheetError ? <div className="chat-newchat-error" role="alert">{sheetError}</div> : null}
        {error ? <div className="chat-newchat-error" role="alert">{error}</div> : null}

        <button
          className="primary-button chat-newchat-start"
          disabled={working || selectedCount === 0}
          onClick={start}
          data-testid="chat-new-chat-start"
        >
          {startLabel}
        </button>
      </div>
    </BottomSheet>
  );
}

// ── Chat tab: inbox ──────────────────────────────────────────

export function ChatInboxScreen({
  repository,
  groupId,
  myProfileId,
  avatarUrl,
  onAccount,
  onOpenThread,
  onUnreadCount,
}: {
  repository: CarpoolRepository;
  groupId: string;
  myProfileId: string;
  avatarUrl: string | null;
  onAccount: () => void;
  onOpenThread: (threadId: string) => void;
  onUnreadCount: (count: number) => void;
}) {
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [directory, setDirectory] = useState<ChatDirectoryEntry[] | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [newChatWorking, setNewChatWorking] = useState(false);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await repository.ensureEveryoneThread(groupId);
      const rows = await repository.listChatThreads();
      setThreads(rows);
      setError(null);
      onUnreadCount(rows.reduce((sum, t) => sum + (t.notifications_muted ? 0 : t.unread_count), 0));
    } catch (e) {
      setError(readableChatError(e));
    } finally {
      setLoading(false);
    }
  }, [repository, groupId, onUnreadCount]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live inbox: any thread mutation in this group (new message bumps
  // last_message_at, new threads appear) refreshes the list, debounced.
  useEffect(() => {
    const client = getSupabaseClient();
    const channel = client
      .channel(`chat-inbox:${groupId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_threads", filter: `group_id=eq.${groupId}` },
        () => {
          if (reloadTimer.current) clearTimeout(reloadTimer.current);
          reloadTimer.current = setTimeout(() => void load(), 300);
        },
      )
      .subscribe();
    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      client.removeChannel(channel);
    };
  }, [groupId, load]);

  const openNewChat = async () => {
    setNewChatOpen(true);
    if (!directory) {
      setDirectoryLoading(true);
      try {
        const rows = (await repository.listGroupDirectory(groupId)) as ChatDirectoryEntry[];
        setDirectory(rows);
        setNewChatError(null);
      } catch (e) {
        setNewChatError(readableChatError(e));
      } finally {
        setDirectoryLoading(false);
      }
    }
  };

  const createConversation = async (profileIds: string[], title: string) => {
    setNewChatWorking(true);
    setNewChatError(null);
    try {
      const threadId =
        profileIds.length === 1
          ? await repository.createDmThread(profileIds[0])
          : await repository.createGroupThread(profileIds, title);
      setNewChatOpen(false);
      onOpenThread(threadId);
    } catch (e) {
      setNewChatError(readableChatError(e));
    } finally {
      setNewChatWorking(false);
    }
  };

  const everyone = threads.find((t) => t.kind === "everyone");
  const rest = threads.filter((t) => t.kind !== "everyone");

  const renderRow = (thread: ChatThreadSummary) => {
    const unread = thread.unread_count > 0;
    return (
      <button
        key={thread.thread_id}
        className={unread ? "chat-thread-row chat-thread-row--unread" : "chat-thread-row"}
        onClick={() => onOpenThread(thread.thread_id)}
        data-testid="chat-thread-row"
      >
        <span className="chat-thread-avatars">
          {thread.kind === "everyone" ? (
            <span className="chat-avatar chat-avatar--everyone" aria-label="Everyone">
              <ChatBubbleIcon width="16" height="16" />
            </span>
          ) : (
            thread.participants
              .filter((p) => p.id !== myProfileId)
              .slice(0, 2)
              .map((p, i) => (
                <ChatAvatar
                  key={p.id}
                  url={p.avatar_url}
                  name={p.name}
                  size={i === 0 ? 34 : 26}
                  className={i === 1 ? "chat-avatar--second" : undefined}
                />
              ))
          )}
        </span>
        <span className="chat-thread-info">
          <span className="chat-thread-name">
            {threadTitle(thread, myProfileId)}
            {thread.notifications_muted ? (
              <span className="chat-mute-icon chat-mute-icon--muted">
                <BellIcon width="13" height="13" />
              </span>
            ) : null}
            {thread.kind === "everyone" ? <span className="chat-thread-badge">All parents</span> : null}
          </span>
          <span className="chat-thread-preview">{inboxPreview(thread)}</span>
        </span>
        <span className="chat-thread-meta">
          <span className="chat-thread-time">
            {thread.last_message_created_at ? formatChatTimestamp(thread.last_message_created_at) : ""}
          </span>
          {unread ? (
            <span className="chat-thread-unread" data-testid="chat-unread-badge">{thread.unread_count}</span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <div className="screen-content chat-screen" data-testid="chat-inbox-screen">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><ChatBubbleIcon width="18" height="18" /></span>
          <span>
            <strong>Carpool Crew</strong>
            <small>Presidio Middle School</small>
          </span>
        </div>
        <button className="avatar-button" aria-label="Open household profile" onClick={onAccount}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <AvatarIcon width="19" height="19" />}
        </button>
      </header>

      <div className="chat-title-row">
        <header className="page-title">
          <span className="eyebrow">Messages</span>
          <h1>Chat</h1>
        </header>
        <button
          className="chat-new-button"
          onClick={() => void openNewChat()}
          aria-label="New conversation"
          data-testid="chat-new-button"
        >
          <PlusIcon width="18" height="18" />
        </button>
      </div>

      {loading ? (
        <p className="helper-copy">Loading conversations…</p>
      ) : error ? (
        <div className="auth-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>Try again</button>
        </div>
      ) : threads.length === 0 ? (
        <div className="empty-state">
          <p>No conversations yet. Message a parent from the directory, or start one here.</p>
        </div>
      ) : (
        <div className="chat-thread-list">
          {everyone ? renderRow(everyone) : null}
          {rest.map(renderRow)}
        </div>
      )}

      <NewChatSheet
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        directory={directory ?? []}
        myProfileId={myProfileId}
        loading={directoryLoading}
        working={newChatWorking}
        error={newChatError}
        onCreate={(ids, title) => void createConversation(ids, title)}
      />
    </div>
  );
}

// ── Thread view ──────────────────────────────────────────────

export function ChatThreadScreen({
  repository,
  threadId,
  myProfileId,
  onBack,
  onThreadOpened,
}: {
  repository: CarpoolRepository;
  threadId: string;
  myProfileId: string;
  onBack: () => void;
  onThreadOpened?: () => void;
}) {
  const keyboard = useKeyboard();
  const { bottomInset } = useKeyboardInsets();
  const [thread, setThread] = useState<ChatThreadSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [proposals, setProposals] = useState<ChatProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [proposalWorking, setProposalWorking] = useState(false);
  const [proposalError, setProposalError] = useState<{ proposalId: string; message: string } | null>(null);
  const [muting, setMuting] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);

  const markRead = useCallback(async () => {
    try {
      await repository.markThreadRead(threadId);
    } catch {
      // best-effort — unread state self-corrects on next open
    }
  }, [repository, threadId]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      repository.listChatThreads(),
      repository.listThreadMessages(threadId),
      repository.listThreadProposals(threadId),
    ])
      .then(async ([threads, initialMessages, initialProposals]) => {
        if (!mounted) return;
        const found = threads.find((t) => t.thread_id === threadId);
        if (!found) throw new Error("You do not have access to this conversation.");
        setThread(found);
        setMessages(initialMessages);
        setProposals(initialProposals);
        setHasOlder(initialMessages.length >= CHAT_PAGE_SIZE);
        setError(null);
        await markRead();
        if (!mounted) return;
        onThreadOpened?.();
      })
      .catch((e) => {
        if (mounted) setError(readableChatError(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [repository, threadId, markRead, onThreadOpened]);

  // Realtime: append incoming messages, flip proposal cards on change.
  useEffect(() => {
    const client = getSupabaseClient();
    const channel = client
      .channel(`chat-thread:${threadId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const incoming = payload.new as ChatMessageRow;
          setMessages((current) => mergeMessageChronological(current, incoming));
          void markRead();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_proposals", filter: `thread_id=eq.${threadId}` },
        () => {
          repository
            .listThreadProposals(threadId)
            .then((rows) => setProposals(rows))
            .catch(() => { /* best-effort refresh */ });
        },
      )
      .subscribe();
    return () => { client.removeChannel(channel); };
  }, [repository, threadId, markRead]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, loading]);

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await repository.listThreadMessages(threadId, oldest.created_at);
      const existingIds = new Set(messages.map((m) => m.id));
      setMessages((current) => [...older.filter((m) => !existingIds.has(m.id)), ...current]);
      setHasOlder(older.length >= CHAT_PAGE_SIZE);
      topRef.current?.scrollIntoView({ block: "start" });
    } catch (e) {
      setError(readableChatError(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const sent = await repository.sendChatMessage(threadId, body);
      setDraft("");
      setMessages((current) => mergeMessageChronological(current, sent));
      setThread((current) =>
        current
          ? {
              ...current,
              last_message_body: sent.body,
              last_message_sender_kind: sent.sender_kind,
              last_message_created_at: sent.created_at,
            }
          : current,
      );
    } catch (e) {
      setError(readableChatError(e));
    } finally {
      setSending(false);
    }
  };

  const goBack = () => {
    keyboard.hide();
    onBack();
  };

  const toggleMute = async () => {
    if (!thread || muting) return;
    setMuting(true);
    try {
      await repository.setThreadNotificationsMuted(threadId, !thread.notifications_muted);
      setThread({ ...thread, notifications_muted: !thread.notifications_muted });
    } catch (e) {
      setError(readableChatError(e));
    } finally {
      setMuting(false);
    }
  };

  const confirmProposal = async (proposalId: string) => {
    setProposalWorking(true);
    setProposalError(null);
    try {
      await repository.confirmChatProposal(proposalId);
      setProposals((current) => current.map((p) => (p.id === proposalId ? { ...p, status: "executed" } : p)));
    } catch (e) {
      setProposalError({ proposalId, message: readableChatError(e) });
    } finally {
      setProposalWorking(false);
    }
  };

  const declineProposal = async (proposalId: string) => {
    setProposalWorking(true);
    setProposalError(null);
    try {
      await repository.declineChatProposal(proposalId);
      setProposals((current) => current.map((p) => (p.id === proposalId ? { ...p, status: "declined" } : p)));
    } catch (e) {
      setProposalError({ proposalId, message: readableChatError(e) });
    } finally {
      setProposalWorking(false);
    }
  };

  const proposalById = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);
  const firstMessageByProposal = useMemo(() => {
    const first = new Map<string, string>();
    for (const message of messages) {
      if (!message.proposal_id) continue;
      if (!first.has(message.proposal_id)) first.set(message.proposal_id, message.id);
    }
    return first;
  }, [messages]);
  const isGroupish = thread ? thread.kind !== "dm" : false;

  // Composer auto-grow: textareas do not size to content, so the height set
  // in onChange is cleared whenever the draft empties (send or manual delete).
  useEffect(() => {
    if (draft !== "") return;
    const el = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="chat-composer-input"]');
    if (el) el.style.height = "";
  }, [draft]);

  return (
    <div className="chat-thread-screen" data-testid="chat-thread-screen">
      <header className="subpage-header chat-thread-header">
        <button className="icon-button" onClick={goBack} aria-label="Back" data-testid="chat-thread-back">
          <Cross2Icon />
        </button>
        <div className="chat-thread-header-info">
          <ChatAvatar
            url={
              thread && thread.kind === "dm"
                ? (thread.participants.find((p) => p.id !== myProfileId)?.avatar_url ?? null)
                : null
            }
            name={thread ? threadTitle(thread, myProfileId) : "Conversation"}
            size={30}
            className={thread && thread.kind !== "dm" ? "chat-avatar--group" : undefined}
          />
          <div>
            <h1>{thread ? threadTitle(thread, myProfileId) : "Conversation"}</h1>
            <small>
              <span className="chat-header-sub">
                {thread ? threadSubtitle(thread, myProfileId) : ""}
                {thread?.kind === "everyone" ? " · Crew AI is in this chat" : ""}
                {thread?.kind !== "everyone" && thread ? " · Crew AI will join to help" : ""}
              </span>
              {thread?.notifications_muted ? <span className="chat-muted-flag">Muted</span> : null}
            </small>
          </div>
        </div>
        <button
          className="icon-button chat-mute-button"
          onClick={() => void toggleMute()}
          disabled={muting || !thread}
          aria-label={thread?.notifications_muted ? "Unmute notifications" : "Mute notifications"}
          data-testid="chat-mute-button"
        >
          <span className={thread?.notifications_muted ? "chat-mute-icon chat-mute-icon--muted" : "chat-mute-icon"}>
            <BellIcon />
          </span>
        </button>
      </header>

      {error ? (
        <div className="chat-thread-error" role="alert">
          <ExclamationTriangleIcon width="16" height="16" />
          <span>{error}</span>
          <button className="text-button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}

      <MobileScroll className="chat-thread-scroll">
        <div className="chat-thread-content">
          {loading ? (
            <p className="helper-copy">Loading messages…</p>
          ) : (
            <>
              <div ref={topRef} />
              {hasOlder ? (
                <button className="text-button chat-load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              ) : null}
              {messages.map((message) => {
                // A proposal can be referenced by several messages (the
                // agent's offer + its post-confirm "Done" note) — render the
                // card only on the proposal's first message so it never
                // appears twice in one thread.
                const proposal = message.proposal_id ? proposalById.get(message.proposal_id) ?? null : null;
                const firstProposalMessageId = proposal ? firstMessageByProposal.get(proposal.id) : undefined;
                const renderProposal = proposal && firstProposalMessageId === message.id ? proposal : null;
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    mine={message.sender_profile_id === myProfileId && message.sender_kind === "parent"}
                    showName={isGroupish}
                    proposal={renderProposal}
                    myProfileId={myProfileId}
                    proposalWorking={proposalWorking}
                    proposalError={
                      proposal && proposalError?.proposalId === proposal.id ? proposalError.message : null
                    }
                    onConfirmProposal={(id) => void confirmProposal(id)}
                    onDeclineProposal={(id) => void declineProposal(id)}
                  />
                );
              })}
              {messages.length === 0 ? (
                <div className="chat-system-note">
                  <p>No messages yet — say hi, or ask Crew AI about the schedule.</p>
                </div>
              ) : null}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </MobileScroll>

      <div
        className="chat-composer"
        style={{ paddingBottom: `calc(${bottomInset}px + 10px)` }}
      >
        {/* Enter sends, Shift+Enter inserts a newline (product decision).
            The isComposing guard keeps IME/emoji-picker confirmation
            presses from sending mid-composition. */}
        <KeyboardTextarea
          placeholder="Message…"
          value={draft}
          maxLength={4000}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="chat-composer-input"
        />
        <button
          className="chat-send-button"
          onClick={() => void send()}
          disabled={sending || draft.trim().length === 0}
          aria-label="Send"
          data-testid="chat-send-button"
        >
          <PaperPlaneIcon width="18" height="18" />
        </button>
      </div>
    </div>
  );
}