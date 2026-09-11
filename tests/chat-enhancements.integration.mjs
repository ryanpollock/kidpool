import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "./lib/chat-fixture.ts";

test("chat storage: reactions, validated mentions, permissions, preferences and unread attention", async () => {
  const f = await chatFixture();
  try {
    const [a, b, c] = f.people;
    const send = async (thread, body, mentions = []) =>
      f.must(
        await a.client
          .from("chat_messages")
          .insert({
            thread_id: thread,
            sender_profile_id: a.id,
            body,
            mentions,
          })
          .select()
          .single(),
      );
    const message = await send(f.dm, "Hi there");
    f.must(
      await b.client.rpc("set_chat_reaction", {
        p_message_id: message.id,
        p_emoji: "👍",
      }),
    );
    f.must(
      await b.client.rpc("set_chat_reaction", {
        p_message_id: message.id,
        p_emoji: "😂",
      }),
    );
    let extras = f.must(
      await a.client.rpc("list_chat_extras", { p_message_ids: [message.id] }),
    );
    assert.equal(extras.reactions.length, 1);
    assert.equal(extras.reactions[0].emoji, "😂");
    assert.ok(
      (
        await c.client.rpc("set_chat_reaction", {
          p_message_id: message.id,
          p_emoji: "👍",
        })
      ).error,
    );
    assert.deepEqual(
      f.must(
        await c.client.rpc("list_chat_extras", { p_message_ids: [message.id] }),
      ).reactions,
      [],
    );
    assert.ok(
      (
        await b.client.rpc("set_chat_reaction", {
          p_message_id: message.id,
          p_emoji: "invalid",
        })
      ).error,
    );
    f.must(
      await b.client.rpc("set_chat_reaction", {
        p_message_id: message.id,
        p_emoji: null,
      }),
    );
    assert.equal(
      f.must(
        await a.client.rpc("list_chat_extras", { p_message_ids: [message.id] }),
      ).reactions.length,
      0,
    );
    const label = `@${b.name}`,
      body = `😀 ${label} hello`,
      mention = {
        profile_id: b.id,
        label,
        start: 2,
        end: 2 + Array.from(label).length,
      };
    const saved = await send(f.dm, body, [mention]);
    assert.deepEqual(saved.mentions, [mention]);
    assert.ok(
      (
        await a.client
          .from("chat_messages")
          .insert({
            thread_id: f.dm,
            sender_profile_id: a.id,
            body,
            mentions: [{ ...mention, profile_id: c.id }],
          })
      ).error,
    );
    assert.ok(
      (
        await a.client
          .from("chat_messages")
          .insert({
            thread_id: f.dm,
            sender_profile_id: a.id,
            body,
            mentions: [{ ...mention, start: 0 }],
          })
      ).error,
    );
    assert.ok(
      (await c.client.from("chat_messages").select().eq("id", message.id)).data
        .length === 0,
    );
    assert.ok(
      (
        await b.client.rpc("set_thread_notification_mode", {
          target_thread_id: f.dm,
          p_mode: "mentions",
        })
      ).error,
    );
    f.must(
      await b.client.rpc("set_thread_notification_mode", {
        target_thread_id: f.everyone,
        p_mode: "mentions",
      }),
    );
    f.must(
      await b.client.rpc("mark_thread_read", { target_thread_id: f.everyone }),
    );
    await send(f.everyone, "ordinary message");
    await send(f.everyone, body, [mention]);
    let row = f
      .must(await b.client.rpc("list_chat_threads_v2"))
      .find((t) => t.thread_id === f.everyone);
    assert.equal(row.notification_mode, "mentions");
    assert.equal(row.unread_count, 2);
    assert.equal(row.attention_count, 1);
    f.must(
      await b.client.rpc("set_thread_notifications_muted", {
        target_thread_id: f.everyone,
        p_muted: true,
      }),
    );
    row = f
      .must(await b.client.rpc("list_chat_threads_v2"))
      .find((t) => t.thread_id === f.everyone);
    assert.equal(row.notification_mode, "muted");
    assert.equal(row.attention_count, 0);
    f.must(
      await b.client.rpc("set_thread_notifications_muted", {
        target_thread_id: f.everyone,
        p_muted: false,
      }),
    );
    row = f
      .must(await b.client.rpc("list_chat_threads_v2"))
      .find((t) => t.thread_id === f.everyone);
    assert.equal(row.notification_mode, "all");
    assert.equal(row.attention_count, 2);
    // A parent cannot query another parent's badge totals.
    assert.equal(
      f.must(
        await a.client.rpc("count_unread_chat", { target_profile_id: b.id }),
      ),
      0,
    );
  } finally {
    await f.cleanup();
  }
});
