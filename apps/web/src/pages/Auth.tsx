import { readBoundedJsonResponse, signupRequiresEmailVerification } from "@ardurbot/core";
import { Button, Input, Label } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { authReturnPath } from "../lib/auth-return-path";
import { clearSpaceSelection } from "../lib/rpc";

type AuthMode = "in" | "up" | "forgot";
type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };

const fieldClass = "mt-2 h-12 rounded-xl px-4 text-base md:text-base";
const submitClass = "mt-3 h-12 w-full rounded-xl text-base";
const AUTH_CAPABILITIES_TIMEOUT_MS = 8_000;
const MAX_AUTH_CAPABILITIES_RESPONSE_BYTES = 64 * 1024;

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { refetch: refreshAuthSession } = authClient.useSession();
  const { t } = useLingui();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const returnPath = searchParams.has("next") ? authReturnPath(searchParams.get("next")) : null;
  const authLink = (path: string) =>
    returnPath ? `${path}?next=${encodeURIComponent(returnPath)}` : path;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const sent = resetSent || searchParams.get("verify") === "email";
  const [reset, setReset] = useState<PasswordResetCapabilities | null>(null);
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const title = sent ? (
    <Trans>Check your email</Trans>
  ) : mode === "in" ? (
    <Trans>Sign in to Ardur</Trans>
  ) : mode === "up" ? (
    <Trans>Create your Ardur</Trans>
  ) : (
    <Trans>Reset your password</Trans>
  );

  useEffect(() => {
    if (mode === "up") return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_CAPABILITIES_TIMEOUT_MS);
    void fetch("/api/auth/capabilities", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load authentication capabilities");
        return readBoundedJsonResponse<PasswordResetCapabilities>(
          response,
          MAX_AUTH_CAPABILITIES_RESPONSE_BYTES,
          controller.signal,
        );
      })
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(result.error.message ?? t`Could not send reset email`);
          return;
        }
        setResetSent(true);
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email,
              password,
              name: name || email.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? t`Could not continue`);
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams(returnPath ? { verify: "email", next: returnPath } : { verify: "email" });
        return;
      }
      clearSpaceSelection();
      await refreshAuthSession();
      navigate(
        mode === "up" ? (returnPath ?? "/onboarding") : authReturnPath(searchParams.get("next")),
      );
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={title}>
      {sent ? (
        <div className="w-full text-center">
          <Link to={authLink("/sign-in")} className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          {mode === "up" ? (
            <div className="mb-4 w-full">
              <Label htmlFor="name" className="text-muted-foreground">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`Your name`}
                className={fieldClass}
              />
            </div>
          ) : null}
          <div className="w-full">
            <Label htmlFor="email" className="text-muted-foreground">
              <Trans>Email</Trans>
            </Label>
            <Input
              id="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`Your email address`}
              type="email"
              required
              className={fieldClass}
            />
          </div>
          {mode !== "forgot" ? (
            <div className="mt-4 w-full">
              <Label htmlFor={passwordFieldId} className="text-muted-foreground">
                <Trans>Password</Trans>
              </Label>
              <div className="relative">
                <Input
                  id={passwordFieldId}
                  name="password"
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t`Password`}
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  className={`${fieldClass} pr-12`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? t`Hide password` : t`Show password`}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-2 my-auto text-muted-foreground"
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {mode === "in" && reset?.passwordReset ? (
                <div className="mt-2 text-right text-sm">
                  <Link to="/forgot-password" className="font-medium text-foreground">
                    <Trans>Forgot password?</Trans>
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={pending} className={submitClass}>
            {pending ? (
              <Trans>Working…</Trans>
            ) : mode === "in" ? (
              <Trans>Continue with email</Trans>
            ) : mode === "forgot" ? (
              <Trans>Send reset link</Trans>
            ) : (
              <Trans>Create account</Trans>
            )}
          </Button>
          <p className="mt-8 text-muted-foreground">
            {mode === "in" ? (
              <>
                <Trans>Don’t have an account?</Trans>{" "}
                <Link to={authLink("/sign-up")} className="font-medium text-foreground">
                  <Trans>Sign up</Trans>
                </Link>
              </>
            ) : mode === "up" ? (
              <>
                <Trans>Already have an account?</Trans>{" "}
                <Link to={authLink("/sign-in")} className="font-medium text-foreground">
                  <Trans>Sign in</Trans>
                </Link>
              </>
            ) : (
              <Link to="/sign-in" className="font-medium text-foreground">
                <Trans>Back to sign in</Trans>
              </Link>
            )}
          </p>
        </>
      )}
    </AuthFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(result.error.message ?? t`Could not reset password`);
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-lg">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

function AuthFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground">
      <form onSubmit={onSubmit} className="flex w-[460px] flex-col items-center">
        <svg
          viewBox="0 0 400 400"
          className="h-[74px] w-[74px] text-foreground"
          aria-hidden="true"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fill="currentColor"
            d="M298 74.5L306.6 78.9L314.9 83.9L322.8 89.6L330.4 96L337.5 102.9L343.9 110.5L348.9 119.1L353.2 128L357 137.2L360.1 146.5L362.8 156.1L364.8 165.7L366.4 175.4L367.4 185.2L367.9 195.1L367.9 204.9L367.4 214.7L366.4 224.5L364.9 234.2L362.8 243.9L360.2 253.4L357 262.8L353.2 271.9L348.7 280.8L343.7 289.3L338 297.4L331.8 305.1L325 312.3L317.8 318.9L310 324.9L301.9 330.4L293.5 335.2L284.8 339.4L275.9 343L266.9 346.1L257.8 348.6L248.6 350.6L239.5 352.2L230.3 353.3L221.2 354.1L212.1 354.5L203 354.5L194 354.3L185 353.6L176 352.7L167 351.3L158.1 349.6L149.3 347.4L140.5 344.7L131.8 341.6L123.4 337.9L115.1 333.7L107.1 328.9L99.4 323.6L92.1 317.8L85.2 311.5L78.7 304.7L72.7 297.5L67.2 289.9L62.1 282L57.6 273.8L53.5 265.3L49.9 256.7L46.7 247.8L44 238.8L41.7 229.7L39.8 220.4L38.3 211.1L37.3 201.6L37.4 192.1L38.1 182.6L39.3 173.1L41 163.7L43.3 154.4L46.1 145.3L49.6 136.4L53.6 127.7L58.2 119.4L63.5 111.4L69.4 103.9L75.7 96.9L82.6 90.4L90 84.5L97.7 79.2L105.8 74.5L114.1 70.4L122.6 66.9L131.2 63.9L139.8 61.5L148.5 59.5L157.2 58L165.9 56.9L174.5 56.1L183 55.5L191.5 55.1L200 55.2L200 56.4L191.6 56.3L183.1 56.6L174.7 57.3L166.3 58.5L157.9 60.3L149.6 62.5L141.4 65.1L133.4 68.3L125.5 71.9L117.9 76.1L110.6 80.8L103.6 86.1L97 91.9L91 98.2L85.4 104.9L80.5 112.1L76.1 119.6L72.4 127.4L69.3 135.5L66.9 143.7L65 152L63.8 160.4L63.1 168.8L62.9 177.1L63.2 185.3L63.9 193.4L64.9 201.3L65.6 209.2L66.6 217L68 224.8L69.7 232.4L71.7 240L74.2 247.5L77 254.9L80.3 262L84 269L88.1 275.8L92.7 282.2L97.7 288.3L103.2 294.1L109 299.4L115.2 304.2L121.7 308.6L128.6 312.5L135.6 315.9L142.8 318.8L150.2 321.2L157.6 323.2L165.1 324.7L172.6 325.9L180.1 326.7L187.6 327.2L195 327.5L202.5 327.5L210 327.2L217.4 326.6L224.9 325.8L232.3 324.7L239.8 323.2L247.2 321.4L254.6 319.2L261.9 316.6L269.1 313.5L276.1 310L282.8 305.9L289.3 301.4L295.4 296.3L301.1 290.8L306.4 284.9L311.3 278.5L315.6 271.8L319.4 264.8L322.7 257.6L325.5 250.2L327.9 242.6L329.7 235L331.1 227.2L332.2 219.5L332.8 211.7L333.1 203.9L333 196.1L332.5 188.3L331.7 180.6L330.6 172.8L329 165.2L327.1 157.6L324.7 150.1L321.8 142.8L318.5 135.6L314.7 128.6L311.3 121.4L307.5 114.2L303.2 107.3L298.3 100.7L292.9 94.5L286.9 88.7Z"
          />
        </svg>
        <h1 aria-live="polite" className="mb-9 mt-7 text-4xl font-medium tracking-tight">
          {title}
        </h1>
        {children}
      </form>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
