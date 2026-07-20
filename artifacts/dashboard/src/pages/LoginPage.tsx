import { useState } from 'react';
import { useLocation } from 'wouter';
import { useLogin } from '@workspace/api-client-react';

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const login = useLogin();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    login.mutate(
      { data: { username, password } },
      {
        onSuccess: () => {
          setLocation('/');
        },
        onError: (err: unknown) => {
          const msg = (err as { message?: string })?.message ?? '';
          if (msg.toLowerCase().includes('expired')) {
            setErrorMsg('Access expired. Contact admin.');
          } else {
            setErrorMsg('Invalid credentials');
          }
        },
      }
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: '#060609' }}
    >
      <div
        className="w-full max-w-sm border rounded-sm p-8"
        style={{
          backgroundColor: '#0d0d14',
          borderColor: 'rgba(255,255,255,0.08)',
        }}
      >
        {/* Header */}
        <div className="text-center mb-8">
          <h1
            className="text-2xl font-black tracking-widest mb-2"
            style={{
              color: '#22d3ee',
              textShadow: '0 0 20px rgba(34,211,238,0.5), 0 0 40px rgba(34,211,238,0.2)',
            }}
          >
            ⚡ REGIME TRACKER
          </h1>
          <p
            className="text-xs tracking-widest"
            style={{ color: '#71717a' }}
          >
            BACCARAT PREDICTION SYSTEM v4.2
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="block text-xs tracking-wider mb-1"
              style={{ color: '#71717a' }}
            >
              USERNAME
            </label>
            <input
              id="username"
              data-testid="input-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full px-3 py-2 rounded-sm text-sm outline-none focus:ring-1 transition-all"
              style={{
                backgroundColor: '#060609',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0',
                fontFamily: "'JetBrains Mono', monospace",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(34,211,238,0.5)';
                e.currentTarget.style.boxShadow = '0 0 0 1px rgba(34,211,238,0.3)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs tracking-wider mb-1"
              style={{ color: '#71717a' }}
            >
              PASSWORD
            </label>
            <input
              id="password"
              data-testid="input-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 rounded-sm text-sm outline-none transition-all"
              style={{
                backgroundColor: '#060609',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0',
                fontFamily: "'JetBrains Mono', monospace",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(34,211,238,0.5)';
                e.currentTarget.style.boxShadow = '0 0 0 1px rgba(34,211,238,0.3)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          {errorMsg && (
            <p
              data-testid="login-error"
              className="text-xs text-center py-2 px-3 rounded-sm"
              style={{
                color: '#f87171',
                backgroundColor: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.2)',
              }}
            >
              {errorMsg}
            </p>
          )}

          <button
            data-testid="btn-authenticate"
            type="submit"
            disabled={login.isPending}
            className="w-full py-3 rounded-sm text-sm font-bold tracking-widest transition-all active:scale-95"
            style={{
              backgroundColor: login.isPending ? 'rgba(34,211,238,0.1)' : 'rgba(34,211,238,0.15)',
              border: '2px solid #22d3ee',
              color: '#22d3ee',
              fontFamily: "'JetBrains Mono', monospace",
              boxShadow: login.isPending ? 'none' : '0 0 12px rgba(34,211,238,0.2)',
              cursor: login.isPending ? 'not-allowed' : 'pointer',
              opacity: login.isPending ? 0.7 : 1,
            }}
          >
            {login.isPending ? 'AUTHENTICATING...' : 'AUTHENTICATE'}
          </button>
        </form>

        {/* Footer */}
        <div className="mt-6 text-center">
          <span
            className="text-xs"
            style={{ color: 'rgba(113,113,122,0.5)' }}
          >
            © META-EXPERT SYSTEMS
          </span>
        </div>
      </div>
    </div>
  );
}
