function isPlaceholderEnv(value: string | undefined) {
  if (!value) return true;
  const normalized = value.trim();
  return normalized === "[SENSITIVE]"
    || normalized.startsWith("your-")
    || normalized.startsWith("changeme")
    || normalized.includes("example.com")
    || normalized.includes("<")
    || normalized.includes(">")
    || normalized.includes("replace-me");
}

export function getSupabaseEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey || isPlaceholderEnv(supabaseUrl) || isPlaceholderEnv(supabaseAnonKey)) {
    return {
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "placeholder-anon-key",
    };
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
  };
}
