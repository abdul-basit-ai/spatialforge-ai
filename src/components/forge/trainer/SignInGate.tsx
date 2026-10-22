"use client";

import { useState } from "react";
import { saveLocalOperator, type Operator } from "./data";

// Shown before a session starts. With accounts (people agent: /signin + /api/auth/me) it links to the PIN sign-in;
// it always offers a device-local name so the trainer works without the auth service.
export function SignInGate({ title, authAvailable, nextPath, onReady }: { title: string; authAvailable: boolean; nextPath: string; onReady: (operator: Operator) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="forge-gate">
      <div className="forge-gate-card">
        <span className="forge-kicker">Operator check-in</span>
        <h2>Train: {title}</h2>
        <p>Sign in so the Coach remembers what you struggle with and tailors hints to you. Your runs feed the team&apos;s assembly analytics.</p>
        {authAvailable && <a className="forge-primary forge-gate-signin" href={`/signin?next=${encodeURIComponent(nextPath)}`}>Sign in with name + PIN</a>}
        <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onReady(saveLocalOperator(name)); }}>
          <label className="forge-label" htmlFor="forge-local-name">{authAvailable ? "Or continue on this device" : "Your name"}</label>
          <div className="forge-gate-row">
            <input id="forge-local-name" autoFocus value={name} maxLength={60} placeholder="e.g. Sam Rivera" onChange={(event) => setName(event.target.value)} />
            <button type="submit" className={authAvailable ? "forge-secondary" : "forge-primary"} disabled={!name.trim()}>Start</button>
          </div>
        </form>
      </div>
    </div>
  );
}
