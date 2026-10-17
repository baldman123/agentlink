"use client";
import { useEffect, useRef, useState } from "react";
import { login, loginErrorText } from "../lib/client/api.ts";
import { Brand } from "./Brand.tsx";

export function LoginForm({ reason }: { reason?: string }) {
  const [code, setCode] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    reason === "revoked" ? "Your access was turned off or replaced. Ask Bryant for a new code." : null,
  );
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(c);
      location.replace("/");
    } catch (err) {
      setError(loginErrorText(err));
      setBusy(false);
      input.current?.select();
    }
  };

  return (
    <main className="gate">
      <div className="gate-card">
        <Brand big />
        <h1>Sign in with your access code</h1>
        <p>Bryant gives each person their own code. It opens your claude4 team and the others&apos; on this site.</p>
        <form onSubmit={submit} noValidate>
          <label className="field-label" htmlFor="code">
            Access code
          </label>
          <input
            id="code"
            ref={input}
            className="code-input"
            type={show ? "text" : "password"}
            name="code"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={!!error}
            aria-describedby="code-error"
            placeholder="alc_…"
          />
          <label className="dialog-check">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span>Show code</span>
          </label>
          <div id="code-error" className="form-error" role="alert">
            {error}
          </div>
          <button className="btn btn-primary btn-big" type="submit" disabled={!code.trim() || busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="gate-foot">No code? Nothing here is visible without one. Ask Bryant.</p>
      </div>
    </main>
  );
}
