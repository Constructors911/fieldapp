import React, { useState } from 'react';
import Card from '../components/Card.jsx';
import Spinner from '../components/Spinner.jsx';
import { authLogin, authRegister, setToken } from '../api.js';

// Employee sign-in. First-time registration links the account to the
// employee's JobTread user (required) and CompanyCam user (best-effort) by
// matching their work email.
export default function Login({ onSuccess }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = mode === 'login'
        ? await authLogin(email.trim(), pin)
        : await authRegister(email.trim(), pin, name.trim() || undefined);
      setToken(res.token);
      onSuccess(res.employee);
    } catch (ex) {
      setErr(ex.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <Card title={mode === 'login' ? 'Sign in' : 'First time — create your sign-in'}>
        <form onSubmit={submit}>
          <label className="c-label" htmlFor="login-email">Work email</label>
          <input
            id="login-email"
            className="c-input"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@constructors911.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          {mode === 'register' && (
            <>
              <label className="c-label" htmlFor="login-name">Name (optional — we&apos;ll use your JobTread name)</label>
              <input
                id="login-name"
                className="c-input"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}

          <label className="c-label" htmlFor="login-pin">{mode === 'login' ? 'PIN' : 'Choose a PIN (4-8 digits)'}</label>
          <input
            id="login-pin"
            className="c-input"
            type="password"
            inputMode="numeric"
            pattern="\d{4,8}"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />

          {err && <p className="login-err" role="alert">{err}</p>}

          <button
            type="submit"
            className="c-btn c-btn-big c-btn-block c-btn-green"
            style={{ marginTop: 14 }}
            disabled={busy || !email.trim() || !pin}
          >
            {busy && <Spinner inline size={18} />}
            {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create & link to JobTread'}
          </button>
        </form>

        <button
          type="button"
          className="c-btn c-btn-block c-btn-ghost"
          style={{ marginTop: 10 }}
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}
        >
          {mode === 'login' ? 'First time here? Create your sign-in' : 'Already registered? Sign in'}
        </button>

        {mode === 'register' && (
          <p className="login-hint">
            Use the email your JobTread account is under — that&apos;s how your hours get credited to you.
          </p>
        )}
      </Card>
    </div>
  );
}
