import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Download } from "lucide-react";
import qrcode from "qrcode-generator";
import type {
  AuthProviders,
  LocalLoginResponse,
  Me,
  RecoveryCodesResponse,
  TotpConfirmResponse,
  TotpEnrollResponse,
} from "@rconsole/shared";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODES_LOW,
  binFromString,
} from "@rconsole/shared";
import { post, request, setCsrfToken } from "../lib/api.ts";
import { visibleText } from "../lib/format.ts";
import { useSession } from "../lib/context.tsx";
import {
  ActionForm,
  CopyButton,
  ErrorState,
  Field,
  Loading,
  PageTitle,
} from "../components/ui.tsx";
import {
  KeyName,
  TtlFuse,
  TypeGlyph,
  countdown,
  useNow,
} from "../components/anatomy.tsx";
/** A static sample of what the key browser shows: typed keys, their anatomy and TTL fuse. */
const SAMPLE_READ_AT = Date.now();
const SAMPLE_KEYS = [
  { key: "session:9f2a1b7c:profile", type: "hash", ttl: 2530 },
  { key: "cart:user:1001:items", type: "list", ttl: 41 },
  { key: "rate:api:203.0.113.7", type: "string", ttl: 9 * 3600 },
  { key: "leaderboard:2026-10:weekly", type: "zset", ttl: -1 },
] as const;

function KeySample() {
  return (
    <figure className="login-sample">
      <ul aria-label="Example keys">
        {SAMPLE_KEYS.map((item) => (
          <li key={item.key}>
            <TypeGlyph type={item.type} />
            <KeyName name={binFromString(item.key)} />
            <TtlFuse ttl={item.ttl} readAt={SAMPLE_READ_AT} />
          </li>
        ))}
      </ul>
      <figcaption>
        Key names split into namespace, ID and leaf. The bar shows the time
        left before Redis removes the key.
      </figcaption>
    </figure>
  );
}

export function Login({
  onLogin,
  notice,
}: {
  onLogin: (me?: Me) => Promise<unknown>;
  /** Why the previous session ended (expiry, sign-out elsewhere, account change). */
  notice?: string;
}) {
  const [params] = useSearchParams();
  const oidcError = params.get("error");
  const oidcMessages: Record<string, string> = {
    oidc_failed:
      "Company sign-in failed. Try again or contact your administrator.",
    oidc_state: "The sign-in session expired. Start sign-in again.",
    oidc_no_role:
      "Your company account has no Redis Console role. Ask your administrator for access.",
    oidc_disabled: "Company sign-in is turned off.",
  };
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => request<AuthProviders>("/auth/providers"),
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState(false);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  return (
    <main className="login-layout">
      <section className="login-story" aria-label="About Redis Console">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            rc
          </span>
          <span>Redis Console</span>
        </div>
        <div className="login-about">
          <h2>Browse, inspect and change Redis data with the server checking every command.</h2>
          <KeySample />
          <ul className="login-facts">
            <li>
              The server checks each command against its policy and runs it
              with a Redis user for your role.
            </li>
            <li>
              Production changes need a typed confirmation and a reason. Every
              action is written to the audit log.
            </li>
            <li>
              Redis passwords and connection details stay on the server. Values
              are shown as text, never as HTML.
            </li>
          </ul>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <h1>
            {totp
              ? useRecovery
                ? "Enter a recovery code"
                : "Enter your authentication code"
              : "Sign in"}
          </h1>
          <p className="muted">
            {totp
              ? useRecovery
                ? "Use one of the recovery codes you saved when you set up two-factor authentication. Each code works once."
                : "Open your authenticator app and enter the six-digit code for Redis Console."
              : providers.data?.oidc.enabled && providers.data.local.enabled
                ? "Use your company account, or a local account an administrator created for you."
                : providers.data?.oidc.enabled
                  ? "Use your company account."
                  : "Use the local account an administrator created for you."}
          </p>
          {notice && (
            <div className="notice warning" role="status" data-testid="session-ended">
              <span>
                {visibleText(
                  (/^not signed in\.?$/i.test(notice.trim())
                    ? "Your session has ended. It expired, was signed out, or your account was changed by an administrator."
                    : notice
                  )
                    .trim()
                    .replace(/[\s;,.]*sign in again\.?$/i, "")
                    .replace(/([^.!?])$/, "$1."),
                )}{" "}
                Sign in again to continue.
              </span>
            </div>
          )}
          <ErrorState
            error={providers.error}
            onRetry={() => {
              void providers.refetch();
            }}
            retryLabel="Retry sign-in methods"
          />
          {providers.isPending && <Loading label="Loading sign-in methods…" />}
          {providers.data &&
            !providers.data.oidc.enabled &&
            !providers.data.local.enabled && (
              <p className="notice warning">
                No sign-in method is turned on. Ask your administrator to
                configure authentication.
              </p>
            )}
          {oidcError && (
            <ErrorState
              error={
                oidcMessages[oidcError] ??
                "Sign-in could not be completed. Try again."
              }
            />
          )}
          {!totp && providers.data?.oidc.enabled && (
            <a
              className="button primary sso"
              href="/api/v1/auth/oidc/start"
              data-testid="login-sso"
            >
              Continue with {providers.data.oidc.displayName}
              <ArrowRight size={15} aria-hidden="true" />
            </a>
          )}
          {!totp &&
            providers.data?.oidc.enabled &&
            providers.data.local.enabled && (
              <div className="divider-label">or use a local account</div>
            )}
          {(totp || providers.data?.local.enabled) && (
            <ActionForm
              label={totp ? "Verify code" : "Sign in"}
              testId={totp ? "totp-submit" : "login-submit"}
              resetKey={totp ? (useRecovery ? "recovery" : "totp") : "password"}
              onSubmit={async () => {
                if (totp) {
                  const result = await post<{ me?: Me }>(
                    "/auth/totp/verify",
                    useRecovery ? { recoveryCode } : { code },
                  );
                  setCode("");
                  setRecoveryCode("");
                  if (result.me) setCsrfToken(result.me.csrfToken);
                  await onLogin(result.me);
                } else {
                  const result = await post<LocalLoginResponse>("/auth/login", {
                    username,
                    password,
                  });
                  setPassword("");
                  if ("totpRequired" in result) setTotp(true);
                  else {
                    setCsrfToken(result.me.csrfToken);
                    await onLogin(result.me);
                  }
                }
              }}
            >
              {totp && useRecovery ? (
                <Field
                  label="Recovery code"
                  hint="Twelve letters and digits, like xxxx-xxxx-xxxx. Case and hyphens do not matter."
                >
                  <input
                    className="data"
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={32}
                    required
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    data-testid="recovery-code"
                  />
                </Field>
              ) : totp ? (
                <Field label="Authentication code">
                  <input
                    className="data code-input"
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    data-testid="totp-code"
                  />
                </Field>
              ) : (
                <>
                  <Field label="Username">
                    <input
                      required
                      autoComplete="username"
                      autoFocus
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      data-testid="login-username"
                    />
                  </Field>
                  <Field label="Password">
                    <input
                      type="password"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      data-testid="login-password"
                    />
                  </Field>
                </>
              )}
            </ActionForm>
          )}
          {totp && (
            <button
              type="button"
              className="ghost back"
              data-testid="recovery-toggle"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setCode("");
                setRecoveryCode("");
              }}
            >
              {useRecovery
                ? "Use your authenticator app"
                : "Use a recovery code"}
            </button>
          )}
          {totp && (
            <button
              type="button"
              className="ghost back"
              data-testid="totp-back"
              onClick={() => {
                setTotp(false);
                setUseRecovery(false);
                setCode("");
                setRecoveryCode("");
              }}
            >
              Use another account
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
function Enrollment({ enrollment }: { enrollment: TotpEnrollResponse }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    try {
      // Only the dependency-free encoder's matrix is consumed. No HTML/SVG/image helpers.
      const qr = qrcode(0, "M");
      qr.addData(enrollment.otpauthUrl);
      qr.make();
      const target = canvas.current;
      if (!target) return;
      const count = qr.getModuleCount();
      const scale = Math.max(1, Math.floor(220 / (count + 8)));
      target.width = target.height = (count + 8) * scale;
      const ctx = target.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable. Use the setup key below.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.fillStyle = "#000000";
      for (let row = 0; row < count; row++)
        for (let col = 0; col < count; col++)
          if (qr.isDark(row, col))
            ctx.fillRect((col + 4) * scale, (row + 4) * scale, scale, scale);
    } catch (failure) {
      setError(failure);
    }
  }, [enrollment]);
  return (
    <div className="enrollment">
      <canvas
        ref={canvas}
        aria-label="Authenticator enrollment QR code"
        role="img"
        data-testid="totp-qr"
      />
      <ErrorState error={error} />
      <p>Scan the code with your authenticator app, or type this setup key:</p>
      <code className="secret data">{enrollment.secretBase32}</code>
      <p className="muted">
        The QR code is drawn in this browser. Do not share the setup key.
      </p>
    </div>
  );
}
/** The text file offered by "Download": built in this browser from the codes on screen (a local Blob URL). */
export function recoveryCodesText(codes: string[], username: string, at = new Date()) {
  return [
    `Redis Console recovery codes for ${username}`,
    `Generated ${at.toISOString()}`,
    "",
    ...codes,
    "",
    "Each code works once, in place of an authenticator code at sign-in.",
    "Generating new codes in Account makes these stop working.",
    "",
  ].join("\n");
}

function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A recovery code set, shown once (after enrollment or regeneration). */
export function RecoveryCodes({
  codes,
  username,
  onDone,
}: {
  codes: string[];
  username: string;
  onDone: () => Promise<unknown>;
}) {
  const [error, setError] = useState<unknown>();
  return (
    <div className="recovery-codes" data-testid="recovery-codes">
      <p>
        <strong>Save these recovery codes now.</strong> If you lose your
        authenticator, each code signs you in once instead of a six-digit code.
        They are not shown again.
      </p>
      <ol className="recovery-code-list data" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className="actions">
        <CopyButton text={codes.join("\n")} label="Copy codes" />
        <button
          type="button"
          className="ghost"
          data-testid="recovery-download"
          onClick={() =>
            downloadText(
              recoveryCodesText(codes, username),
              "redis-console-recovery-codes.txt",
            )
          }
        >
          <Download size={13} aria-hidden="true" />
          Download
        </button>
      </div>
      <p className="muted">
        Keep them somewhere safe and apart from your password, for example in
        a password manager.
      </p>
      <ErrorState error={error} />
      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="recovery-saved"
          onClick={() => {
            void onDone().catch(setError);
          }}
        >
          I saved my recovery codes
        </button>
      </div>
    </div>
  );
}

export function Account({ forced = false }: { forced?: boolean }) {
  const { me, refresh, logout } = useSession();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [enrollment, setEnrollment] = useState<TotpEnrollResponse>();
  const [code, setCode] = useState("");
  const [issued, setIssued] = useState<string[]>();
  const [regenPassword, setRegenPassword] = useState("");
  const [logoutError, setLogoutError] = useState<unknown>();
  // A set on screen is a new, complete set (and means TOTP is on); `me` is reloaded once the user saved it.
  const remaining = issued ? issued.length : me.recoveryCodesRemaining;
  const totpOn = me.totpEnabled || !!issued;
  const now = useNow();
  const expires = Date.parse(me.sessionExpiresAt);
  const showPassword = me.source === "local" && (!forced || me.mustChangePassword);
  const showTotp = me.source === "local" && (!forced || !me.mustChangePassword);
  const identity = (
      <section className="section account-section">
        <header>
          <h2>Identity</h2>
        </header>
        <dl className="facts account-facts">
          <dt>Name</dt>
          <dd>{visibleText(me.displayName)}</dd>
          <dt>Username</dt>
          <dd>
            <code>{visibleText(me.username)}</code>
          </dd>
          <dt>Signs in with</dt>
          <dd>{me.source === "oidc" ? "Company SSO" : "Local account"}</dd>
          <dt>Role</dt>
          <dd>
            <span className={`role-tag ${me.role}`}>{me.role}</span>
            <span className="muted">
              {" "}
              Your highest role. Each database can lower it.
            </span>
          </dd>
          <dt>Two-factor</dt>
          <dd>
            {me.source === "oidc"
              ? "Managed by your identity provider"
              : totpOn
                ? "Authenticator enrolled"
                : "Not set up"}
          </dd>
          {me.source === "local" && totpOn && remaining !== undefined && (
            <>
              <dt>Recovery codes</dt>
              <dd className="tabular" data-testid="recovery-remaining">
                {remaining} of {RECOVERY_CODE_COUNT} left
              </dd>
            </>
          )}
          <dt>Session ends</dt>
          <dd className="tabular">
            {new Date(expires).toLocaleString()}{" "}
            <span className="muted">
              (in {countdown(Math.max(0, Math.floor((expires - now) / 1000)))})
            </span>
          </dd>
        </dl>
        {me.source === "oidc" && (
          <p className="muted section-note">
            Your password and two-factor settings live in your company identity
            provider. Change them there.
          </p>
        )}
      </section>
  );
  return (
    <div className={forced ? "forced-account" : "account"}>
      <PageTitle
        title={forced ? "Secure your account" : "Account"}
        description={
          forced
            ? me.mustChangePassword
              ? "Choose a new password before you open a database."
              : "Set up an authenticator before you open a database."
            : undefined
        }
        actions={
          <button
            type="button"
            onClick={() => {
              void logout().catch(setLogoutError);
            }}
          >
            Sign out
          </button>
        }
      />
      <ErrorState error={logoutError} />
      {!forced && identity}
      {showPassword && (
        <section className="section account-section">
          <header>
            <h2>Password</h2>
          </header>
          <ActionForm
            label="Change password"
            testId="password-change-submit"
            onSubmit={async () => {
              const result = await post<{ me: Me }>("/auth/password", {
                currentPassword,
                newPassword,
              });
              setCsrfToken(result.me.csrfToken);
              setCurrent("");
              setNew("");
              await refresh();
            }}
          >
            <div className="form-row">
              <Field label="Current password">
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrent(e.target.value)}
                  data-testid="current-password"
                />
              </Field>
              <Field
                label="New password"
                hint="At least 12 characters. A unique passphrase works well."
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={newPassword}
                  onChange={(e) => setNew(e.target.value)}
                  data-testid="new-password"
                />
              </Field>
            </div>
          </ActionForm>
        </section>
      )}
      {showTotp && (
        <section className="section account-section">
          <header>
            <h2>Two-factor authentication</h2>
            <span className="meta" data-testid="totp-state">
              {totpOn ? "on" : "off"}
            </span>
          </header>
          {issued ? (
            <RecoveryCodes
              codes={issued}
              username={me.username}
              onDone={async () => {
                await refresh();
                setIssued(undefined);
              }}
            />
          ) : me.totpEnabled ? (
            <>
              <p>
                Sign-in asks for a code from your authenticator. To move it to a
                new device, ask an administrator to reset it.
              </p>
              <h3>Recovery codes</h3>
              <p data-testid="recovery-status">
                {remaining ?? 0} of {RECOVERY_CODE_COUNT} recovery codes left.
                Each one signs you in once if you lose your authenticator.
              </p>
              {(remaining ?? 0) <= RECOVERY_CODES_LOW && (
                <div className="notice warning" role="status" data-testid="recovery-low">
                  <span>
                    {(remaining ?? 0) === 0
                      ? "You have no recovery codes left. Generate new ones so a lost authenticator does not lock you out."
                      : `Only ${remaining} recovery code${remaining === 1 ? "" : "s"} left. Generate new ones soon.`}
                  </span>
                </div>
              )}
              <ActionForm
                label="Generate new recovery codes"
                testId="recovery-regenerate"
                onSubmit={async () => {
                  const result = await post<RecoveryCodesResponse>(
                    "/auth/recovery-codes",
                    { currentPassword: regenPassword },
                  );
                  setRegenPassword("");
                  setIssued(result.recoveryCodes);
                }}
              >
                <Field
                  label="Current password"
                  hint="New codes replace all your current codes, used or not."
                >
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={regenPassword}
                    onChange={(e) => setRegenPassword(e.target.value)}
                    data-testid="recovery-password"
                  />
                </Field>
              </ActionForm>
            </>
          ) : !enrollment ? (
            <>
              <p className="muted">
                Add an authenticator app (any TOTP app) so a password alone
                cannot open your account.
              </p>
              <ActionForm
                label="Set up authenticator"
                testId="totp-enroll"
                onSubmit={async () =>
                  setEnrollment(
                    await post<TotpEnrollResponse>("/auth/totp/enroll"),
                  )
                }
              >
                {null}
              </ActionForm>
            </>
          ) : (
            <div className="enroll-grid">
              <Enrollment enrollment={enrollment} />
              <ActionForm
                label="Turn on two-factor"
                testId="totp-enroll-confirm"
                onSubmit={async () => {
                  const result = await post<TotpConfirmResponse>(
                    "/auth/totp/confirm",
                    { code },
                  );
                  // The session was rotated; the codes are shown before the account is reloaded (a forced
                  // enrollment leaves this page once `me` says TOTP is on).
                  setCsrfToken(result.me.csrfToken);
                  setEnrollment(undefined);
                  setCode("");
                  setIssued(result.recoveryCodes);
                }}
              >
                <Field
                  label="Six-digit code"
                  hint="Enter the code your app shows now to confirm the setup."
                >
                  <input
                    className="data code-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    data-testid="totp-enroll-code"
                  />
                </Field>
              </ActionForm>
            </div>
          )}
        </section>
      )}
      {forced && identity}
      {!forced && (
        <section className="section account-section" data-testid="account-about">
          <header>
            <h2>About</h2>
          </header>
          <p className="section-note">
            Redis Console is open source under the Apache License 2.0. It includes
            third-party software (npm packages and the Atkinson Hyperlegible fonts)
            under their own licences.{" "}
            <a
              href="/THIRD-PARTY-NOTICES.txt"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="about-notices"
            >
              Third-party notices
            </a>
          </p>
        </section>
      )}
    </div>
  );
}
