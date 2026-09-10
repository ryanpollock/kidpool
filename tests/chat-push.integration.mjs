import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "./lib/chat-fixture.ts";
test("chat push endpoint uses saved messages and only accepts server triggers", async () => {
  assert.equal(
    process.env.TEST_DB_TARGET,
    "local",
    "This delivery test runs only locally",
  );
  const f = await chatFixture();
  try {
    const [a, b] = f.people;
    const message = f.must(
      await a.client
        .from("chat_messages")
        .insert({ thread_id: f.dm, sender_profile_id: a.id, body: "Push test" })
        .select()
        .single(),
    );
    const payload = {
      type: "chat_message",
      thread_id: f.dm,
      message_id: message.id,
      sender_profile_id: b.id,
      body: "Forged body",
    };
    const forbidden = await a.client.functions.invoke("send-push", {
      body: payload,
    });
    assert.equal(forbidden.error?.context.status, 403);
    const call = async () => {
      const response = await fetch(
        `${f.env.supabaseUrl}/functions/v1/send-push`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${f.env.serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    let result = await call();
    assert.equal(result.reason, "no_vapid_keys");
    assert.equal(result.skipped, 1);
    f.must(
      await b.client.rpc("set_thread_notification_mode", {
        target_thread_id: f.dm,
        p_mode: "muted",
      }),
    );
    result = await call();
    assert.equal(result.reason, "no_recipients");
  } finally {
    await f.cleanup();
  }
});
