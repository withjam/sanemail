import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

// Vite exposes any env var prefixed with `VITE_` to the client bundle.
// In environments without these, we fall back to "dev mode": no auth UI,
// the backend honors DEV_USER_ID and accepts requests without a token.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || "";

export const isAuthConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isAuthConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        storageKey: "sanemail-auth-v1",
      },
    })
  : null;

let cachedSession: Session | null = null;
let sessionLoaded = false;
const sessionListeners = new Set<(session: Session | null) => void>();

if (supabase) {
  void supabase.auth.getSession().then(({ data }) => {
    cachedSession = data.session;
    sessionLoaded = true;
    sessionListeners.forEach((listener) => listener(cachedSession));
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedSession = session;
    sessionLoaded = true;
    sessionListeners.forEach((listener) => listener(cachedSession));
  });
} else {
  sessionLoaded = true;
}

export function getCurrentSession(): Session | null {
  return cachedSession;
}

export function isSessionLoaded(): boolean {
  return sessionLoaded;
}

export function subscribeToSession(listener: (session: Session | null) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export function getCurrentAccessToken(): string | null {
  return cachedSession?.access_token || null;
}

export async function signInWithPassword(email: string, password: string) {
  if (!supabase) throw new Error("Auth is not configured.");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUpWithPassword(email: string, password: string) {
  if (!supabase) throw new Error("Auth is not configured.");
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}
