import type { Session } from "@supabase/supabase-js";
import { Loader2, LogIn, UserPlus } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getCurrentSession,
  isAuthConfigured,
  isSessionLoaded,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  subscribeToSession,
} from "./auth";
import { queryClient } from "./query";

interface AuthContextValue {
  loading: boolean;
  authConfigured: boolean;
  session: Session | null;
  userId: string | null;
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(getCurrentSession());
  const [loading, setLoading] = useState<boolean>(!isSessionLoaded());

  useEffect(() => {
    setSession(getCurrentSession());
    setLoading(!isSessionLoaded());
    let previousUserId = getCurrentSession()?.user?.id ?? null;
    return subscribeToSession((next) => {
      setSession(next);
      setLoading(false);
      const nextUserId = next?.user?.id ?? null;
      if (nextUserId !== previousUserId) {
        // Identity changed — drop any cached queries from the previous user
        // so user B never sees user A's data on screen.
        void queryClient.invalidateQueries();
        queryClient.removeQueries();
        previousUserId = nextUserId;
      }
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      authConfigured: isAuthConfigured,
      session,
      userId: session?.user?.id || null,
      email: session?.user?.email || null,
      signIn: signInWithPassword,
      signUp: signUpWithPassword,
      signOut,
    }),
    [loading, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { loading, authConfigured, session } = useAuth();

  if (!authConfigured) {
    // Dev mode: backend trusts DEV_USER_ID, no sign-in UI.
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="loading" data-testid="auth-loading">
        <Loader2 className="spin" size={22} />
        <span>Loading session</span>
      </div>
    );
  }

  if (!session) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}

function SignInScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setInfo(null);
      setSubmitting(true);
      try {
        if (mode === "sign-in") {
          await signIn(email, password);
        } else {
          await signUp(email, password);
          setInfo("Check your email to confirm the account, then sign in.");
          setMode("sign-in");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Authentication failed.");
      } finally {
        setSubmitting(false);
      }
    },
    [email, mode, password, signIn, signUp],
  );

  return (
    <div className="signin-shell" data-testid="signin-screen">
      <div className="signin-card">
        <div className="signin-header">
          <span className="brand-mark">S</span>
          <h1>SaneMail</h1>
          <p>{mode === "sign-in" ? "Sign in to continue." : "Create an account to get started."}</p>
        </div>
        <form className="signin-form" onSubmit={handleSubmit}>
          <label className="signin-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="signin-email"
            />
          </label>
          <label className="signin-field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="signin-password"
            />
          </label>
          {error ? <p className="signin-error">{error}</p> : null}
          {info ? <p className="signin-info">{info}</p> : null}
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
            data-testid="signin-submit"
          >
            {submitting ? (
              <Loader2 className="spin" size={17} />
            ) : mode === "sign-in" ? (
              <LogIn size={17} />
            ) : (
              <UserPlus size={17} />
            )}
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          type="button"
          className="signin-toggle"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
            setInfo(null);
          }}
          data-testid="signin-toggle"
        >
          {mode === "sign-in" ? "Need an account? Create one." : "Have an account? Sign in."}
        </button>
      </div>
    </div>
  );
}
