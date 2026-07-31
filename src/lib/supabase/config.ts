export type SupabasePublicConfig = {
  url: string;
  publishableKey: string;
};

function readValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function readSupabasePublicConfig(): SupabasePublicConfig | null {
  const url = readValue(import.meta.env.VITE_SUPABASE_URL);
  const publishableKey = readValue(
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );

  if (!url && !publishableKey) return null;

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase configuration is incomplete. Set both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("VITE_SUPABASE_URL must be a valid HTTPS URL.");
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "127.0.0.1") {
    throw new Error("VITE_SUPABASE_URL must use HTTPS outside local development.");
  }

  return { url: parsedUrl.toString().replace(/\/$/, ""), publishableKey };
}
