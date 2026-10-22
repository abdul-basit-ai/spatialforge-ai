"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import "./people.css";

type Operator = { id: string; name: string; role: "trainee" | "admin" };
type Message = { kind: "err" | "ok" | "info"; text: string } | null;

// Only same-site relative paths are followed after sign-in.
const safeNext = (value: string | null) => value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/train";

export default function SignIn() {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [next, setNext] = useState("/train");
  const [me, setMe] = useState<Operator | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNext(safeNext(new URLSearchParams(window.location.search).get("next")));
    try { setName(localStorage.getItem("spatialforge:last-operator") || ""); } catch { /* ignore */ }
    fetch("/api/auth/me").then((response) => response.ok ? response.json() : null).then((body) => setMe(body?.operator ?? null)).catch(() => undefined).finally(() => setChecking(false));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (name.trim().length < 2) { setMessage({ kind: "err", text: "Enter your name (at least 2 characters)." }); return; }
    if (!/^\d{4,6}$/.test(pin)) { setMessage({ kind: "err", text: "Your PIN is 4 to 6 digits." }); pinRef.current?.focus(); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/auth/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), pin }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAttemptsLeft(typeof body.attemptsLeft === "number" ? body.attemptsLeft : null);
        setMessage({ kind: "err", text: body.error || `Sign-in failed (${response.status}).` });
        setPin(""); pinRef.current?.focus();
        return;
      }
      try { localStorage.setItem("spatialforge:last-operator", body.operator.name); } catch { /* ignore */ }
      setMe(body.operator); setAttemptsLeft(null);
      setMessage({ kind: "ok", text: body.created ? `Welcome, ${body.operator.name}. Your operator profile is ready. Remember your PIN.` : `Welcome back, ${body.operator.name}.` });
      setTimeout(() => window.location.assign(next), body.created ? 1300 : 500);
    } catch { setMessage({ kind: "err", text: "Network error. Check your connection and try again." }); }
    finally { setBusy(false); }
  };
  const signOut = async () => { await fetch("/api/auth/signout", { method: "POST" }).catch(() => undefined); setMe(null); setPin(""); setMessage({ kind: "info", text: "Signed out." }); };
  const digits = Math.max(4, Math.min(6, pin.length + (pin.length >= 4 && pin.length < 6 ? 1 : 0)));

  return <main className="pf-root pf-signin">
    <section className="pf-card" aria-labelledby="signin-title">
      <div className="pf-brand"><span className="pf-brand-mark">◇</span><span>SPATIAL<b>FORGE</b></span><small>OPERATOR ID</small></div>
      {me && !message?.kind?.startsWith("ok") ? <>
        <h1 id="signin-title">You are <span>signed in</span></h1>
        <p className="pf-sub">Your runs, mistakes and coaching are saved to this operator.</p>
        <div className="pf-who"><span className="pf-avatar">{me.name.slice(0, 1).toUpperCase()}</span><div><strong>{me.name}</strong><small>{me.id}</small></div><span className={`pf-role ${me.role}`}>{me.role.toUpperCase()}</span></div>
        <div className="pf-row"><button type="button" className="pf-button" onClick={() => window.location.assign(next)}>Continue →</button><button type="button" className="pf-button ghost" onClick={signOut}>Switch operator</button></div>
      </> : <form onSubmit={submit} noValidate>
        <div className="pf-kicker">Station sign-in</div>
        <h1 id="signin-title">Who is <span>on the bench</span>?</h1>
        <p className="pf-sub">Enter your name and PIN. A new name creates your operator profile, so the Coach can remember where you struggle.</p>
        <div className="pf-field"><label htmlFor="pf-name">Name</label><input id="pf-name" className="pf-input" autoComplete="username" autoFocus={!name} maxLength={32} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Maya Chen" /></div>
        <div className="pf-field"><label htmlFor="pf-pin">PIN · 4 to 6 digits</label>
          <div className="pf-pin">
            <input id="pf-pin" ref={pinRef} className="pf-input" type="password" inputMode="numeric" autoComplete="current-password" autoFocus={Boolean(name)} pattern="\d*" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))} aria-describedby="pf-pin-help" />
            <div className="pf-pin-dots" aria-hidden>{Array.from({ length: digits }, (_, index) => <i key={index} className={index < pin.length ? "on" : index >= 4 ? "opt" : ""} />)}</div>
          </div>
          <small id="pf-pin-help" style={{ color: "var(--pf-muted)", fontSize: 11 }}>Five wrong PINs lock the name for 5 minutes.</small>
          {attemptsLeft !== null && <div className="pf-attempts" aria-label={`${attemptsLeft} attempts left`}>{Array.from({ length: 5 }, (_, index) => <i key={index} className={index < 5 - attemptsLeft ? "used" : ""} />)}</div>}
        </div>
        <button className="pf-button" type="submit" disabled={busy || checking}>{busy ? "Checking…" : "Sign in"}</button>
      </form>}
      {message && <p className={`pf-msg ${message.kind}`} role={message.kind === "err" ? "alert" : "status"}>{message.text}</p>}
      <div className="pf-foot"><span>Next: <code>{next}</code></span><span><Link href="/train">Train</Link> · <Link href="/admin">Admin</Link></span></div>
    </section>
  </main>;
}
