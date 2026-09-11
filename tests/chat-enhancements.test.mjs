import assert from "node:assert/strict";
import test from "node:test";
import {
  editMentions,
  trimMentionDraft,
  linksInText,
} from "../src/lib/chat-content.ts";
import { chatRecipients } from "../supabase/functions/_shared/chat-notifications.ts";
import {
  publicIPv4,
  safeUrl,
  metadata,
  imageData,
} from "../supabase/functions/_shared/preview-fetch.ts";

test("mention edits preserve identity only while the complete mention survives, including emoji offsets", () => {
  const body = "😀 @Jane Doe hello";
  const m = { profile_id: "j", label: "@Jane Doe", start: 2, end: 11 };
  assert.deepEqual(editMentions(body, "😀 @Jane Doe hello!", [m]), [m]);
  assert.deepEqual(editMentions(body, "hi 😀 @Jane Doe hello", [m]), [
    { ...m, start: 5, end: 14 },
  ]);
  assert.deepEqual(editMentions(body, "😀 @Jan Doe hello", [m]), []);
  assert.deepEqual(editMentions(body, "😀 hello", [m]), []);
  assert.deepEqual(
    trimMentionDraft("  " + body + " ", [{ ...m, start: 4, end: 13 }]),
    { body, mentions: [m] },
  );
});
test("URLs exclude trailing punctuation and credentials", () => {
  assert.deepEqual(
    linksInText("See https://example.com/test. And https://two.example/!").map(
      (x) => x.url,
    ),
    ["https://example.com/test", "https://two.example/"],
  );
  assert.equal(
    linksInText("javascript:alert(1) https://user:pass@example.com").length,
    0,
  );
});
test("recipient matrix: all, mentions-only, mute, sender and inactive", () => {
  const p = [
    { profile_id: "all", notification_mode: "all" },
    { profile_id: "tag", notification_mode: "mentions" },
    { profile_id: "muted", notification_mode: "muted" },
    { profile_id: "sender", notification_mode: "all" },
    { profile_id: "inactive", notification_mode: "all" },
  ];
  const active = new Set(["all", "tag", "muted", "sender"]);
  assert.deepEqual(chatRecipients(p, active, "sender", []), ["all"]);
  assert.deepEqual(
    chatRecipients(p, active, "sender", [
      { profile_id: "tag" },
      { profile_id: "tag" },
      { profile_id: "muted" },
    ]),
    ["all", "tag"],
  );
});
test("preview destination validation rejects internal, reserved, credential and non-web URLs", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4("93.184.216.34"), true);
  for (const u of [
    "file:///etc/passwd",
    "http://localhost",
    "http://[::1]",
    "https://a:b@example.com",
    "https://example.com:444",
  ])
    assert.throws(() => safeUrl(u));
  assert.equal(safeUrl("https://example.com/path").hostname, "example.com");
});
test("metadata respects quoted attributes, entities, fallback titles and text limits", () => {
  assert.deepEqual(
    metadata(
      `<title>Fallback</title><meta content='School &amp; &quot;Friends&quot;' property="og:title"><meta name='description' content='Text > more'><meta property='og:image' content='/photo.png'>`,
    ),
    {
      title: 'School & "Friends"',
      description: "Text > more",
      image: "/photo.png",
    },
  );
  assert.equal(metadata("<title>Plain page</title>").title, "Plain page");
  assert.equal(imageData(Buffer.from('<svg onload="alert(1)"></svg>')), null);
});
