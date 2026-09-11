import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchPublic, metadata, imageData } from "../_shared/preview-fetch.ts";
const respond = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "POST required" }, 405);
  const authorization = req.headers.get("Authorization");
  if (!authorization) return respond({ error: "Sign in required" }, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: auth, error: authError } = await user.auth.getUser();
  if (authError || !auth.user)
    return respond({ error: "Sign in required" }, 401);
  let id: string;
  try {
    id = (await req.json()).message_id;
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error();
  } catch {
    return respond({ error: "Invalid message" }, 400);
  }
  const { data: message } = await user
    .from("chat_messages")
    .select("id,thread_id,body")
    .eq("id", id)
    .single();
  if (!message) return respond({ error: "Message unavailable" }, 404);
  const link = message.body
    .match(/https?:\/\/[^\s<>]+/i)?.[0]
    .replace(/[.,!?;:)\]}]+$/, "");
  if (!link) return respond({ status: "no_link" });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cached } = await admin
    .from("chat_link_previews")
    .select("status,updated_at")
    .eq("message_id", id)
    .maybeSingle();
  if (
    cached &&
    (cached.status !== "pending" ||
      Date.now() - new Date(cached.updated_at).getTime() < 60_000)
  )
    return respond({ status: cached.status });
  // Claim once per immutable message. A stale worker may be retried after one minute.
  if (!cached) {
    const { error } = await admin
      .from("chat_link_previews")
      .insert({ message_id: id, thread_id: message.thread_id, url: link });
    if (error) return respond({ status: "pending" });
  } else {
    const { data: claim } = await admin
      .from("chat_link_previews")
      .update({ updated_at: new Date().toISOString() })
      .eq("message_id", id)
      .eq("updated_at", cached.updated_at)
      .select("message_id");
    if (!claim?.length) return respond({ status: "pending" });
  }
  try {
    const page = await fetchPublic(link);
    if (!page.type.toLowerCase().includes("text/html"))
      throw new Error("Not HTML");
    const meta = metadata(page.bytes.toString("utf8"));
    let image: string | null = null;
    if (meta.image)
      try {
        const img = await fetchPublic(
          new URL(meta.image, page.url).href,
          300_000,
        );
        image = imageData(img.bytes);
      } catch {
        /* The text card remains usable. */
      }
    const { error } = await admin
      .from("chat_link_previews")
      .update({
        status: "ready",
        title: meta.title,
        description: meta.description,
        image_data: image,
        updated_at: new Date().toISOString(),
      })
      .eq("message_id", id);
    if (error) throw error;
    return respond({ status: "ready" });
  } catch {
    await admin
      .from("chat_link_previews")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("message_id", id);
    return respond({ status: "failed" });
  }
});
