const requiredEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

export function getSupabaseEnv() {
  if (!requiredEnv.supabaseUrl || !requiredEnv.supabaseAnonKey) {
    throw new Error(
      "Missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return {
    supabaseUrl: requiredEnv.supabaseUrl,
    supabaseAnonKey: requiredEnv.supabaseAnonKey,
  };
}
