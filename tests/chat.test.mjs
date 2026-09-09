import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatMigrationUrl = new URL(
  "../supabase/migrations/202609070001_chat_1_foundation.sql",
  import.meta.url,
);
const chatUnreadMigrationUrl = new URL(
  "../supabase/migrations/202609090001_chat_unread_count.sql",
  import.meta.url,
);
const swUrl = new URL("../public/sw.js", import.meta.url);
const typesUrl = new URL("../src/lib/supabase/database.types.ts", import.meta.url);
const repoUrl = new URL("../src/lib/supabase/carpool-repository.ts", import.meta.url);
const prototypeUrl = new URL("../src/Prototype.tsx", import.meta.url);
const chatScreensUrl = new URL("../src/ChatScreens.tsx", import.meta.url);
const chatCssUrl = new URL("../src/chat.css", import.meta.url);
const prototypeUrl2 = new URL("../src/prototype.css", import.meta.url);
const sendPushUrl = new URL("../supabase/functions/send-push/index.ts", import.meta.url);
const dbTruncateUrl = new URL("../tests/lib/db.ts", import.meta.url);

const chatTables = [
  "chat_threads",
  "chat_participants",
  "chat_messages",
  "chat_proposals",
];

test("chat migration defines every chat table and enables RLS", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  for (const table of chatTables) {
    assert.match(
      sql,
      new RegExp(`create table public\\.${table}\\b`, "i"),
      `missing table ${table}`,
    );
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      `RLS is not enabled for ${table}`,
    );
  }
});

test("chat tables grant only the access the app needs", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  // Threads: select only (creation via RPCs). Participants: select + own-row
  // update. Messages: select + insert (immutable). Proposals: select only
  // (confirm/decline RPCs do the writes).
  assert.match(sql, /grant select on public\.chat_threads to authenticated/i);
  assert.match(sql, /grant select, update on public\.chat_participants to authenticated/i);
  assert.match(sql, /grant select, insert on public\.chat_messages to authenticated/i);
  assert.match(sql, /grant select on public\.chat_proposals to authenticated/i);

  // No accidental DELETE/ALL grants on chat tables
  for (const table of chatTables) {
    assert.doesNotMatch(
      sql,
      new RegExp(`grant delete on public\\.${table}`, "i"),
      `chat table ${table} must not be deletable by clients`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`grant all on public\\.${table}`, "i"),
      `chat table ${table} must not have ALL grants`,
    );
  }
});

test("DM threads are one per parent pair per group; everyone threads one per group", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /create unique index chat_threads_dm_pair_unique[\s\S]*?where kind = 'dm'/i);
  assert.match(sql, /create unique index chat_threads_everyone_unique[\s\S]*?where kind = 'everyone'/i);
  assert.match(sql, /dm_a_id < dm_b_id/i, "DM pair ids must be canonicalized by the check constraint");
});

test("thread visibility helper enforces participant or coordinator-with-flag access", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.can_read_chat_thread\(\w+ uuid\)/i);
  // Participant branch requires active group membership (removed members lose access)
  assert.match(
    sql,
    /is_group_member\(t\.group_id\)[\s\S]*?chat_participants[\s\S]*?profile_id = auth\.uid\(\)/i,
  );
  // Coordinator branch is gated on the group's oversight flag
  assert.match(
    sql,
    /is_group_coordinator\(t\.group_id\)[\s\S]*?coordinator_chat_access/i,
  );
  assert.match(sql, /alter table public\.groups[\s\S]*?add column if not exists coordinator_chat_access boolean not null default true/i);
  assert.match(sql, /revoke all on function public\.can_read_chat_thread\(uuid\) from public/i);
});

test("message insert policy requires self sender, participant thread, and parent kind", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(
    sql,
    /create policy chat_messages_insert_participant[\s\S]*?sender_kind = 'parent'[\s\S]*?sender_profile_id = auth\.uid\(\)/i,
  );
  assert.match(sql, /chat_messages_insert_participant[\s\S]*?coordinator_chat_access/i);
  // Messages are immutable: no update/delete policies
  assert.doesNotMatch(sql, /create policy chat_messages_update/i);
  assert.doesNotMatch(sql, /create policy chat_messages_delete/i);
  // Body length guard
  assert.match(sql, /body text not null check \(char_length\(trim\(body\)\) between 1 and 4000\)/i);
});

test("sender identity is denormalized and agent/system messages are never push-triggered", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.fill_chat_message_sender\(\)/i);
  assert.match(sql, /sender_profile_id is null then[\s\S]*?Parent messages require a sender profile/i);
  assert.match(sql, /Agent and system messages require a sender name/i);
  assert.match(sql, /new\.sender_kind <> 'parent'[\s\S]*?return new/i, "notify trigger must skip agent/system messages");
});

test("chat push trigger is fail-soft and mirrors the no_rides_requested vault pattern", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.notify_chat_message_push\(\)/i);
  assert.match(sql, /No cron_secret found in vault/);
  assert.match(sql, /No cron_edge_base_url found in vault/);
  assert.match(sql, /'type', 'chat_message'/);
  assert.match(sql, /timeout_milliseconds := 120000/);
});

test("everyone thread auto-enrolls on membership insert and via ensure RPC", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.enroll_member_in_everyone_thread\(\)/i);
  assert.match(sql, /create trigger memberships_enroll_everyone_thread[\s\S]*?after insert on public\.memberships/i);
  assert.match(sql, /create or replace function public\.ensure_everyone_thread\(\w+ uuid\)/i);
  assert.match(sql, /on conflict do nothing[\s\S]*?enroll the caller/i);
});

test("proposal confirmation executes only through the existing schedule RPCs", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /create or replace function public\.confirm_chat_proposal\(\w+ uuid\)/i);
  assert.match(sql, /perform public\.cancel_ride_for_child\(v_child_id, v_driver_assignment_id\)/);
  assert.match(sql, /v_switch_result := public\.switch_child_afternoon_trip\(v_child_id, v_driver_assignment_id\)/);
  assert.match(sql, /not supported yet/i, "swap_drive/coverage_fill stay M2 scope");
  assert.match(sql, /Only the requested parent can confirm this proposal/i);
  assert.match(sql, /This proposal has expired/i);
  assert.match(sql, /create or replace function public\.decline_chat_proposal\(\w+ uuid\)/i);

  // Confirm writes audit + an agent completion message
  assert.match(sql, /'chat_proposal_confirmed'/);
  assert.match(sql, /'Done — ' \|\| v_proposal\.summary/i);
});

test("chat messages and proposals are realtime-published with RLS-enforced delivery", async () => {
  const sql = await readFile(chatMigrationUrl, "utf8");

  assert.match(sql, /alter publication supabase_realtime add table public\.chat_messages/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.chat_proposals/i);
  assert.match(sql, /alter table public\.chat_messages replica identity full/i);
  assert.match(sql, /alter table public\.chat_proposals replica identity full/i);
});

test("every chat table has a TypeScript contract and the chat RPCs are typed", async () => {
  const types = await readFile(typesUrl, "utf8");

  for (const table of chatTables) {
    assert.match(
      types,
      new RegExp(`\\b${table}: Table<`),
      `missing TypeScript table contract for ${table}`,
    );
  }

  for (const fn of [
    "ensure_everyone_thread",
    "create_dm_thread",
    "create_group_thread",
    "mark_thread_read",
    "set_thread_notifications_muted",
    "list_chat_threads",
    "confirm_chat_proposal",
    "decline_chat_proposal",
    "can_read_chat_thread",
  ]) {
    assert.match(types, new RegExp(`\\b${fn}: \\{`), `missing RPC typing for ${fn}`);
  }

  assert.match(types, /ChatThreadSummary/);
  assert.match(types, /coordinator_chat_access: boolean/);
});

test("repository exposes the chat methods", async () => {
  const source = await readFile(repoUrl, "utf8");

  for (const method of [
    "listChatThreads",
    "ensureEveryoneThread",
    "createDmThread",
    "createGroupThread",
    "listThreadMessages",
    "listThreadProposals",
    "sendChatMessage",
    "markThreadRead",
    "setThreadNotificationsMuted",
    "confirmChatProposal",
    "declineChatProposal",
  ]) {
    assert.match(source, new RegExp(`async ${method}\\(`), `missing repository method ${method}`);
  }

  // Message page fetches newest-first then reverse (chronological render)
  assert.match(source, /\.order\("created_at", \{ ascending: false \}\)[\s\S]*?\[\.\.\.rows\]\.reverse\(\)/);
});

test("send-push chat_message branch is push-only, mutes-aware, and deep-links", async () => {
  const source = await readFile(sendPushUrl, "utf8");

  assert.match(source, /type === "chat_message" && thread_id/i);
  // Skip the sender, muted participants, and non-active members
  assert.match(source, /p\.profile_id !== sender_profile_id && !p\.notifications_muted && activeIds\.has\(p\.profile_id\)/);
  // Deep link to the thread (sw.js notificationclick navigates to data.url)
  assert.match(source, /\/#thread=\$\{thread_id\}/);
  assert.match(source, /push_only: true/);
  // No email for chat messages: the branch must return before the shared email path
  const branch = source.slice(
    source.indexOf('type === "chat_message" && thread_id'),
    source.indexOf("push_only: true"),
  );
  assert.doesNotMatch(branch, /api\.resend\.com/, "chat_message must be push-only");
  assert.doesNotMatch(branch, /RESEND_API_KEY/, "chat_message must not read email config");
});

test("composer: Enter sends, Shift+Enter is a newline, IME is respected", async () => {
  const source = await readFile(chatScreensUrl, "utf8");

  // Product decision: Enter submits, Shift+Enter forces a newline
  assert.match(source, /e\.key === "Enter" && !e\.shiftKey/);
  assert.match(source, /e\.nativeEvent\.isComposing/, "IME composition Enter must not send");
  assert.match(source, /e\.preventDefault\(\);\s*void send\(\);/);

  // Composer grows with content and resets when the draft empties
  assert.match(source, /Math\.min\(el\.scrollHeight, 96\)/);
  assert.match(source, /el\.style\.height = "";/);
});

test("mute control: slash renders on an HTML wrapper with a visible Muted flag", async () => {
  const source = await readFile(chatScreensUrl, "utf8");

  // Pseudo-elements don't render on SVG — the muted slash must live on a
  // span wrapper, never on the BellIcon itself (the original dead-looking
  // toggle). A visible "Muted" flag pins the state next to the subtitle.
  assert.match(source, /<span className=\{thread\?\.notifications_muted \? "chat-mute-icon chat-mute-icon--muted" : "chat-mute-icon"\}>/);
  assert.match(source, /chat-muted-flag/);
  assert.doesNotMatch(source, /<BellIcon className="chat-mute-icon--muted"/);

  const css = await readFile(chatCssUrl, "utf8");
  assert.match(css, /\.chat-mute-icon--muted::after/);
  assert.match(css, /\.chat-muted-flag \{/);
});

test("thread header beats prototype.css subpage-header collisions by specificity", async () => {
  const css = await readFile(chatCssUrl, "utf8");

  // prototype.css's `.subpage-header { grid-template-columns: 36px 1fr }`
  // and `.subpage-header h1 { font-size: 34px; Georgia }` are same-or-higher
  // specificity with load-order-dependent winners. Without the boost the
  // bell wraps onto a second grid row and overlays the message list, and
  // the title renders at 34px (the production overlap report). Never rely
  // on CSS load order across files.
  assert.match(css, /\.subpage-header\.chat-thread-header \{/);
  assert.match(css, /\.subpage-header\.chat-thread-header \.chat-thread-header-info h1 \{/);
  assert.match(css, /grid-template-columns: 36px 1fr 36px;/);
  assert.match(css, /font-family: inherit;/);
  assert.match(css, /\.chat-header-sub \{/);
});

test("every text-entry control meets the iOS 16px no-auto-zoom threshold", async () => {
  // iOS Safari (and iOS installed PWAs) zoom the whole page when an input
  // with a computed font-size under 16px gains focus — and KEEP the zoom
  // after the keyboard closes, so the app renders "too wide" with the right
  // side clipped (the production iPhone report on the chat composer, which
  // shipped at 14px). maximum-scale=1 is deliberately not used — it's an
  // accessibility anti-pattern. This scans every input/textarea rule in the
  // app stylesheets and enforces the threshold.
  for (const url of [chatCssUrl, prototypeUrl2]) {
    const css = await readFile(url, "utf8");
    const ruleRe = /([^{}]+)\{([^}]*)\}/g;
    let rule;
    while ((rule = ruleRe.exec(css)) !== null) {
      const selector = rule[1];
      const body = rule[2];
      const isEntryControl = /(^|[,]\s*)(textarea|input)\b/.test(selector) ||
        /(^|[,]\s*)\.chat-composer textarea/.test(selector) ||
        /\binput\[/.test(selector);
      if (!isEntryControl) continue;
      const sizeMatch = body.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
      if (!sizeMatch) continue;
      const size = Number(sizeMatch[1]);
      assert.ok(
        size >= 16,
        `${url.toString().split("/").pop()}: text-entry rule "${selector.trim().slice(0, 60)}" has font-size ${size}px — below the iOS 16px no-auto-zoom threshold`,
      );
    }
  }
});

test("ChatScreens follows the mobile runtime contract", async () => {
  const source = await readFile(chatScreensUrl, "utf8");

  // Composer uses the runtime textarea, positioned from keyboard insets
  assert.match(source, /<KeyboardTextarea/);
  assert.match(source, /useKeyboardInsets\(\)/);
  assert.match(source, /bottomInset/);
  assert.doesNotMatch(source, /bottom: 0/);

  // Back navigation hides the keyboard in the same event
  assert.match(source, /keyboard\.hide\(\);[\s\S]*?onBack\(\)/);

  // Message list scrolls inside MobileScroll; composer stays outside it
  assert.match(source, /<MobileScroll className="chat-thread-scroll">/);

  // No raw inputs (runtime rule)
  assert.doesNotMatch(source, /<textarea/);
  assert.doesNotMatch(source, /<input/);

  // Realtime follows the PlanScreen postgres_changes pattern
  assert.match(source, /"postgres_changes"/);
  assert.match(source, /filter: `thread_id=eq\.\$\{threadId\}`/);
  assert.match(source, /client\.removeChannel\(channel\)/);

  // Proposal cards gate actions on the required confirmer
  assert.match(source, /required_confirmer_profile_id \|\| proposal\.required_confirmer_profile_id === myProfileId/);
});

test("Prototype integrates the chat tab, thread layer, and entry points", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  assert.match(source, /type AppTab = "home" \| "plan" \| "week" \| "chat" \| "coordinate"/);
  assert.match(source, /data-testid=\{`nav-\$\{id\}`\}/);
  assert.match(source, /id === "chat" && chatUnreadCount > 0/);
  assert.match(source, /className="chat-thread-layer"/);
  assert.match(source, /setChatThreadId\(null\)/);

  // Entry points: directory parent detail + drive detail driver messaging
  assert.match(source, /data-testid="parent-detail-message"/);
  assert.match(source, /data-testid="drive-message-driver"/);

  // Deep link from push notifications (#thread=, parsed on load)
  assert.match(source, /hash\.get\("thread"\)/);
  assert.match(source, /setActiveTab\("chat"\)/);

  // Thread open hides the bottom nav like the other overlays
  assert.match(source, /!reviewOpen && !accountOpen && !directoryOpen && !directoryParentId && !driveDetailId && !faqOpen && !chatThreadId/);
});

test("nav badge is fed at the app level, not only from the inbox", async () => {
  const source = await readFile(prototypeUrl, "utf8");

  // Unread count refreshes once identity resolves, so the badge is present
  // at sign-in before the Chat tab is ever opened.
  assert.match(source, /refreshChatUnread/);
  assert.match(source, /if \(!identity\?\.membership\) return;\s*void refreshChatUnread\(\);/);

  // Nav-level realtime channel: every message bumps chat_threads.last_message_at,
  // so one subscription covers badge updates from any tab. Delivery is
  // RLS-enforced; bursts are debounced into a single re-count.
  assert.match(source, /channel\(`chat-threads-nav:\$\{identity\.group\.id\}`\)/);
  assert.match(source, /table: "chat_threads", filter: `group_id=eq\.\$\{identity\.group\.id\}`/);
  assert.match(source, /setTimeout\(\(\) => void refreshChatUnread\(\), 1500\)/);
  assert.match(source, /client\.removeChannel\(channel\)/);

  // Muted threads never contribute to the badge total, and thread opens
  // re-sync the count.
  assert.match(source, /t\.notifications_muted \? 0 : t\.unread_count/);
  assert.match(source, /handleChatThreadOpened = useCallback\(async \(\) => \{\s*await refreshChatUnread\(\);/);
});

test("test data cleanup truncates chat tables in FK-safe order", async () => {
  const dbSource = await readFile(dbTruncateUrl, "utf8");

  // Chat tables must be truncated BEFORE their referenced tables.
  const chatIdx = dbSource.indexOf('"chat_messages"');
  const riderIdx = dbSource.indexOf('"rider_assignments"');
  assert.ok(chatIdx !== -1, "chat tables missing from truncation list");
  assert.ok(riderIdx !== -1, "rider_assignments missing from truncation list");
  assert.ok(chatIdx < riderIdx, "chat tables must come before schedule tables in FK order");

  // drive_status and reassignment_requests reference driver_assignments and
  // MUST be truncated in the same statement (pre-existing gap fixed with chat).
  assert.ok(dbSource.includes('"drive_status"'), "drive_status must be in the truncation list");
  assert.ok(dbSource.includes('"reassignment_requests"'), "reassignment_requests must be in the truncation list");
});
test("app icon badge: push carries per-recipient unread and every layer syncs it", async () => {
  // count_unread_chat mirrors the in-app badge definition exactly
  const migration = await readFile(chatUnreadMigrationUrl, "utf8");
  assert.match(migration, /create or replace function public\.count_unread_chat\(\w+ uuid\)/i);
  assert.match(migration, /language sql\s+stable\s+security definer/i);
  assert.match(migration, /msg\.created_at > cp\.last_read_at/i, "read cursor respected");
  assert.match(migration, /cp\.notifications_muted = false/i, "muted threads excluded");
  assert.match(migration, /m\.status = 'active'/i, "removed members excluded");
  assert.match(migration, /revoke all on function public\.count_unread_chat\(uuid\) from public/i);
  assert.match(migration, /grant execute on function public\.count_unread_chat\(uuid\) to authenticated/i);

  // typed for the client
  const types = await readFile(typesUrl, "utf8");
  assert.match(types, /count_unread_chat:/);

  // send-push computes the per-recipient total and ships it in the payload
  const push = await readFile(sendPushUrl, "utf8");
  assert.match(push, /rpc\/count_unread_chat/);
  assert.match(push, /unreadByProfile/);
  const branch = push.slice(
    push.indexOf('type === "chat_message" && thread_id'),
    push.indexOf("push_only: true"),
  );
  assert.match(branch, /payload\.badge = badge/, "chat_message payload must carry the badge count");
  assert.doesNotMatch(branch, /api\.resend\.com/, "badge work stays push-only");

  // the service worker sets the icon badge from the payload, fail-soft
  const sw = await readFile(swUrl, "utf8");
  assert.match(sw, /typeof payload\.badge === "number"/);
  assert.match(sw, /navigator\.setAppBadge\(payload\.badge\)/);

  // the app keeps the icon badge synced with the in-app total, and clears
  // it on sign-out
  const proto = await readFile(prototypeUrl, "utf8");
  assert.match(proto, /function syncAppIconBadge\(unreadTotal: number\)/);
  assert.match(proto, /setAppBadge\?\.\(unreadTotal\)/);
  assert.match(proto, /clearAppBadge\?\./);
  assert.match(proto, /syncAppIconBadge\(total\)/, "refreshChatUnread must sync the icon badge");
  assert.match(proto, /syncAppIconBadge\(0\)/, "sign-out must clear the icon badge");

  // and the deep link that a badge/notification tap lands on is intact
  assert.match(sw, /event\.notification\.data\?\.url/);
  assert.match(sw, /client\.navigate\(targetUrl\)|openWindow\(targetUrl\)/);
  assert.match(push, /\/#thread=\$\{thread_id\}/);
  assert.match(proto, /hash\.get\("thread"\)/);
});
