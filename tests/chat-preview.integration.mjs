import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "./lib/chat-fixture.ts";
test("preview function authenticates, enforces conversation access, fetches public metadata and blocks internal URLs", async () => {
  const f = await chatFixture();
  try {
    const [a, , c] = f.people;
    const send = async (body) =>
      f.must(
        await a.client
          .from("chat_messages")
          .insert({ thread_id: f.dm, sender_profile_id: a.id, body })
          .select()
          .single(),
      );
    const message = await send("https://example.com/");
    const outsider = await c.client.functions.invoke("chat-link-preview", {
      body: { message_id: message.id },
    });
    assert.ok(outsider.error);
    const { error, data } = await a.client.functions.invoke(
      "chat-link-preview",
      { body: { message_id: message.id } },
    );
    assert.ifError(error);
    assert.equal(data.status, "ready");
    const preview = f.must(
      await a.client
        .from("chat_link_previews")
        .select()
        .eq("message_id", message.id)
        .single(),
    );
    assert.match(preview.title, /Example Domain/i);
    const illustrated = await send("https://ogp.me/");
    const illustratedResult = await a.client.functions.invoke(
      "chat-link-preview",
      { body: { message_id: illustrated.id } },
    );
    assert.ifError(illustratedResult.error);
    assert.equal(illustratedResult.data.status, "ready");
    const card = f.must(
      await a.client
        .from("chat_link_previews")
        .select()
        .eq("message_id", illustrated.id)
        .single(),
    );
    assert.match(card.image_data, /^data:image\/(png|jpeg|webp);base64,/);
    const blocked = await send("http://127.0.0.1/private");
    const result = await a.client.functions.invoke("chat-link-preview", {
      body: { message_id: blocked.id },
    });
    assert.ifError(result.error);
    assert.equal(result.data.status, "failed");
    const noAuth = await fetch(
      `${f.env.supabaseUrl}/functions/v1/chat-link-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: message.id }),
      },
    );
    assert.equal(noAuth.status, 401);
  } finally {
    await f.cleanup();
  }
});
