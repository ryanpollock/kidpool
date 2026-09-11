import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  getSpecEnv,
  TEST_PASSWORD,
  PILOT_GROUP_ID,
} from "./playwright-helpers.ts";
export async function chatFixture() {
  const env = getSpecEnv();
  if (!env.serviceKey || !env.anonKey)
    throw new Error("Chat tests require credentials; refusing to skip");
  const admin = createClient(env.supabaseUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const run = randomUUID().slice(0, 8);
  const people: {
    id: string;
    email: string;
    name: string;
    household: string;
    client: ReturnType<typeof createClient>;
  }[] = [];
  const threads: string[] = [];
  const must = <T>(result: { data: T; error: unknown }) => {
    if (result.error) throw result.error;
    return result.data;
  };
  const cleanup = async () => {
    for (const id of threads)
      must(await admin.from("chat_threads").delete().eq("id", id));
    for (const p of people) {
      must(
        await admin
          .from("chat_messages")
          .delete()
          .eq("sender_profile_id", p.id),
      );
      must(await admin.from("households").delete().eq("id", p.household));
      must(await admin.from("profiles").delete().eq("id", p.id));
      const { error } = await admin.auth.admin.deleteUser(p.id);
      if (error) throw error;
    }
  };
  try {
    for (const name of ["Alex", "Blair", "Casey"]) {
      const email = `chatplus-${run}-${name.toLowerCase()}@test.kidpool`;
      const { user } = must(
        await admin.auth.admin.createUser({
          email,
          password: TEST_PASSWORD,
          email_confirm: true,
        }),
      );
      if (!user) throw new Error("User creation failed");
      const id = user.id,
        household = randomUUID();
      const client = createClient(env.supabaseUrl, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      people.push({ id, email, name: `${name} Chatplus`, household, client });
      must(
        await admin
          .from("profiles")
          .upsert({ id, email, full_name: `${name} Chatplus` }),
      );
      must(
        await admin
          .from("households")
          .insert({
            id: household,
            group_id: PILOT_GROUP_ID,
            name: `Chatplus ${run} ${name}`,
            created_by: id,
          }),
      );
      must(
        await admin
          .from("memberships")
          .insert({
            group_id: PILOT_GROUP_ID,
            household_id: household,
            profile_id: id,
            role: "member",
            status: "active",
          }),
      );
      must(
        await client.auth.signInWithPassword({
          email,
          password: TEST_PASSWORD,
        }),
      );
    }
    const dm = must(
      await people[0].client.rpc("create_dm_thread", {
        target_profile_id: people[1].id,
      }),
    ) as string;
    threads.push(dm);
    const everyone = must(
      await people[0].client.rpc("ensure_everyone_thread", {
        target_group_id: PILOT_GROUP_ID,
      }),
    ) as string;
    return { admin, people, dm, everyone, cleanup, must, env };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
