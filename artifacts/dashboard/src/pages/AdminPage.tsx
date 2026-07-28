import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAdminLogin,
  useAdminLogout,
  useListUsers,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  useKickUserSession,
  useUnflagUser,
  getListUsersQueryKey,
} from '@workspace/api-client-react';
import type { UserAccount } from '@workspace/api-client-react';

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

function abbreviateUserAgent(ua: string | null): string {
  if (!ua) return '—';
  // Extract browser + OS from common UA strings
  const chrome = ua.match(/Chrome\/([\d]+)/);
  const safari = ua.match(/Safari/) && !ua.match(/Chrome/);
  const firefox = ua.match(/Firefox\/([\d]+)/);
  const edge = ua.match(/Edg\/([\d]+)/);
  const android = ua.match(/Android ([\d.]+)/);
  const ios = ua.match(/iPhone OS ([\d_]+)/);
  const mac = ua.match(/Mac OS X ([\d_]+)/);
  const windows = ua.match(/Windows NT ([\d.]+)/);

  let browser = 'Browser';
  if (edge) browser = `Edge ${edge[1]}`;
  else if (chrome) browser = `Chrome ${chrome[1]}`;
  else if (firefox) browser = `Firefox ${firefox[1]}`;
  else if (safari) browser = 'Safari';

  let os = '';
  if (android) os = `Android ${android[1]}`;
  else if (ios) os = `iOS ${ios[1].replace(/_/g, '.')}`;
  else if (mac) os = `macOS`;
  else if (windows) os = `Windows`;

  return os ? `${browser} / ${os}` : browser;
}

function toDatetimeLocal(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  const candidate = error as {
    message?: unknown;
    data?: { error?: unknown } | null;
  };
  if (typeof candidate?.data?.error === 'string' && candidate.data.error.trim()) {
    return candidate.data.error;
  }
  if (typeof candidate?.message === 'string' && candidate.message.trim()) {
    return candidate.message.replace(/^HTTP \d+ [^:]+:\s*/, '');
  }
  return fallback;
}

function UserStatusBadge({ user }: { user: UserAccount }) {
  const now = new Date();
  const expiry = new Date(user.expiresAt);
  const badges = [];

  if (user.flaggedAt) {
    badges.push(
      <span
        key="flagged"
        className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
        style={{
          color: '#fb923c',
          backgroundColor: 'rgba(251,146,60,0.1)',
          border: '1px solid rgba(251,146,60,0.4)',
        }}
        title={`Flagged: sharing violation detected at ${formatExpiry(user.flaggedAt)}`}
      >
        ⚠ FLAGGED
      </span>
    );
  }

  if (user.isOnline) {
    badges.push(
      <span
        key="online"
        className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
        style={{
          color: '#4ade80',
          backgroundColor: 'rgba(74,222,128,0.1)',
          border: '1px solid rgba(74,222,128,0.3)',
        }}
      >
        ONLINE
      </span>
    );
  } else if (expiry > now) {
    badges.push(
      <span
        key="active"
        className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
        style={{
          color: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.1)',
          border: '1px solid rgba(34,211,238,0.3)',
        }}
      >
        ACTIVE
      </span>
    );
  } else {
    badges.push(
      <span
        key="expired"
        className="text-xs font-bold px-2 py-0.5 rounded-sm tracking-wider"
        style={{
          color: '#f87171',
          backgroundColor: 'rgba(248,113,113,0.1)',
          border: '1px solid rgba(248,113,113,0.3)',
        }}
      >
        EXPIRED
      </span>
    );
  }

  return <div className="flex items-center gap-1.5">{badges}</div>;
}

interface EditState {
  expiresAt: string;
  password: string;
}

function SecurityInfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex gap-2 items-start min-w-0">
      <span className="shrink-0 text-xs tracking-wider" style={{ color: '#52525b', minWidth: '110px' }}>
        {label}
      </span>
      <span
        className="text-xs break-all"
        style={{
          color: highlight ? '#fb923c' : '#a1a1aa',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function UserRow({
  user,
  onRefresh,
}: {
  user: UserAccount;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [editState, setEditState] = useState<EditState>({
    expiresAt: toDatetimeLocal(user.expiresAt),
    password: '',
  });

  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const kickUser = useKickUserSession();
  const unflagUser = useUnflagUser();

  function handleEdit() {
    setEditing(true);
    setEditState({ expiresAt: toDatetimeLocal(user.expiresAt), password: '' });
  }

  function handleSave() {
    const data: { expiresAt?: string; password?: string } = {
      expiresAt: new Date(editState.expiresAt).toISOString(),
    };
    if (editState.password) {
      data.password = editState.password;
    }
    updateUser.mutate(
      { id: user.id, data },
      {
        onSuccess: () => {
          setEditing(false);
          onRefresh();
        },
      }
    );
  }

  function handleDelete() {
    if (!window.confirm(`Delete user "${user.username}"?`)) return;
    deleteUser.mutate(
      { id: user.id },
      { onSuccess: onRefresh }
    );
  }

  function handleKick() {
    kickUser.mutate(
      { id: user.id },
      { onSuccess: onRefresh }
    );
  }

  function handleUnflag() {
    unflagUser.mutate(
      { id: user.id },
      { onSuccess: onRefresh }
    );
  }

  const isFlagged = !!user.flaggedAt;
  const borderColor = isFlagged
    ? 'rgba(251,146,60,0.25)'
    : 'rgba(255,255,255,0.08)';

  return (
    <div
      className="rounded-sm border p-4 flex flex-col gap-3"
      style={{
        backgroundColor: isFlagged ? 'rgba(251,146,60,0.04)' : 'rgba(255,255,255,0.02)',
        borderColor,
      }}
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className="font-bold text-sm"
            style={{ color: '#e2e8f0', fontFamily: "'JetBrains Mono', monospace" }}
            data-testid={`user-username-${user.id}`}
          >
            {user.username}
          </span>
          <UserStatusBadge user={user} />
        </div>
        <div className="flex gap-2 flex-wrap">
          {isFlagged && (
            <button
              data-testid={`btn-unflag-${user.id}`}
              onClick={handleUnflag}
              disabled={unflagUser.isPending}
              className="text-xs px-2 py-1 rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                color: '#fb923c',
                border: '1px solid rgba(251,146,60,0.4)',
                backgroundColor: 'rgba(251,146,60,0.08)',
                cursor: unflagUser.isPending ? 'not-allowed' : 'pointer',
              }}
            >
              {unflagUser.isPending ? '...' : 'UNFLAG'}
            </button>
          )}
          <button
            data-testid={`btn-kick-${user.id}`}
            onClick={handleKick}
            disabled={kickUser.isPending || !user.isOnline}
            className="text-xs px-2 py-1 rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              color: '#eab308',
              border: '1px solid rgba(234,179,8,0.3)',
              backgroundColor: 'transparent',
              cursor: !user.isOnline ? 'not-allowed' : 'pointer',
              opacity: !user.isOnline ? 0.4 : 1,
            }}
          >
            KICK
          </button>
          <button
            data-testid={`btn-edit-${user.id}`}
            onClick={handleEdit}
            className="text-xs px-2 py-1 rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.3)',
              backgroundColor: 'transparent',
              cursor: 'pointer',
            }}
          >
            EDIT
          </button>
          <button
            data-testid={`btn-delete-${user.id}`}
            onClick={handleDelete}
            disabled={deleteUser.isPending}
            className="text-xs px-2 py-1 rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              color: '#f87171',
              border: '1px solid rgba(248,113,113,0.3)',
              backgroundColor: 'transparent',
              cursor: 'pointer',
            }}
          >
            DELETE
          </button>
        </div>
      </div>

      <div className="text-xs" style={{ color: '#71717a' }} data-testid={`user-expiry-${user.id}`}>
        EXPIRES: {formatExpiry(user.expiresAt)}
      </div>

      {/* Security info section */}
      <div>
        <button
          onClick={() => setShowSecurity((v) => !v)}
          className="text-xs tracking-wider transition-colors"
          style={{
            color: showSecurity ? '#52525b' : '#3f3f46',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {showSecurity ? '▾ SECURITY INFO' : '▸ SECURITY INFO'}
        </button>

        {showSecurity && (
          <div
            className="mt-2 p-3 rounded-sm flex flex-col gap-1.5"
            style={{
              backgroundColor: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <SecurityInfoRow label="LOGIN IP" value={user.sessionIp ?? '—'} />
            <SecurityInfoRow label="LAST SEEN IP" value={user.lastSeenIp ?? '—'} />
            <SecurityInfoRow
              label="LAST SEEN"
              value={user.lastSeenAt ? formatRelativeTime(user.lastSeenAt) : '—'}
            />
            <SecurityInfoRow
              label="DEVICE"
              value={abbreviateUserAgent(user.sessionUserAgent)}
            />
            {user.flaggedAt && (
              <SecurityInfoRow
                label="FLAGGED AT"
                value={formatExpiry(user.flaggedAt)}
                highlight
              />
            )}
            {user.sessionUserAgent && (
              <details className="mt-1">
                <summary
                  className="text-xs cursor-pointer"
                  style={{ color: '#3f3f46', listStyle: 'none' }}
                >
                  full UA ▸
                </summary>
                <p
                  className="mt-1 text-xs break-all"
                  style={{
                    color: '#52525b',
                    fontFamily: "'JetBrains Mono', monospace",
                    lineHeight: '1.5',
                  }}
                >
                  {user.sessionUserAgent}
                </p>
              </details>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div
          className="flex flex-col gap-3 pt-3 border-t"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <div>
            <label className="block text-xs tracking-wider mb-1" style={{ color: '#71717a' }}>
              EXPIRES AT
            </label>
            <input
              data-testid={`input-edit-expiry-${user.id}`}
              type="datetime-local"
              value={editState.expiresAt}
              onChange={(e) => setEditState((s) => ({ ...s, expiresAt: e.target.value }))}
              className="w-full px-3 py-2 rounded-sm text-sm outline-none"
              style={{
                backgroundColor: '#060609',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            />
          </div>
          <div>
            <label className="block text-xs tracking-wider mb-1" style={{ color: '#71717a' }}>
              NEW PASSWORD (optional)
            </label>
            <input
              data-testid={`input-edit-password-${user.id}`}
              type="text"
              value={editState.password}
              onChange={(e) => setEditState((s) => ({ ...s, password: e.target.value }))}
              placeholder="Leave blank to keep current"
              className="w-full px-3 py-2 rounded-sm text-sm outline-none"
              style={{
                backgroundColor: '#060609',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            />
          </div>
          <div className="flex gap-2">
            <button
              data-testid={`btn-save-${user.id}`}
              onClick={handleSave}
              disabled={updateUser.isPending}
              className="flex-1 py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: '2px solid #22d3ee',
                color: '#22d3ee',
                backgroundColor: 'rgba(34,211,238,0.08)',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {updateUser.isPending ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              data-testid={`btn-cancel-${user.id}`}
              onClick={() => setEditing(false)}
              className="flex-1 py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#71717a',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              CANCEL
            </button>
          </div>
          {updateUser.isError && (
            <p className="text-xs" style={{ color: '#f87171' }}>
              Failed to update user.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AdminManagement() {
  const queryClient = useQueryClient();
  const adminLogout = useAdminLogout();
  const createUser = useCreateUser();
  const users = useListUsers();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newExpiresAt, setNewExpiresAt] = useState('');
  const [createError, setCreateError] = useState('');

  function handleAdminLogout(onLogout: () => void) {
    adminLogout.mutate(undefined, {
      onSuccess: onLogout,
    });
  }

  function handleCreate() {
    setCreateError('');
    if (!newUsername || !newPassword || !newExpiresAt) {
      setCreateError('All fields are required.');
      return;
    }
    if (newPassword.length < 6) {
      setCreateError('Password must be at least 6 characters.');
      return;
    }
    createUser.mutate(
      {
        data: {
          username: newUsername,
          password: newPassword,
          expiresAt: new Date(newExpiresAt).toISOString(),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          setShowCreateForm(false);
          setNewUsername('');
          setNewPassword('');
          setNewExpiresAt('');
        },
        onError: (error: unknown) => {
          setCreateError(getApiErrorMessage(error, 'Failed to create user.'));
        },
      }
    );
  }

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
  }

  const inputStyle = {
    backgroundColor: '#060609',
    border: '1px solid rgba(255,255,255,0.12)',
    color: '#e2e8f0',
    fontFamily: "'JetBrains Mono', monospace",
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1
          className="text-lg font-black tracking-widest"
          style={{ color: '#e2e8f0' }}
        >
          USER MANAGEMENT
        </h1>
        <div className="flex gap-2">
          <button
            data-testid="btn-new-user"
            onClick={() => setShowCreateForm((v) => !v)}
            className="text-sm px-4 py-2 rounded-sm tracking-wider font-bold transition-all active:scale-95"
            style={{
              border: '2px solid #22d3ee',
              color: '#22d3ee',
              backgroundColor: 'rgba(34,211,238,0.08)',
              cursor: 'pointer',
            }}
          >
            + NEW USER
          </button>
          <button
            data-testid="btn-admin-logout"
            onClick={() => handleAdminLogout(() => window.location.reload())}
            className="text-sm px-4 py-2 rounded-sm tracking-wider transition-all active:scale-95"
            style={{
              border: '1px solid rgba(255,255,255,0.18)',
              color: '#71717a',
              backgroundColor: 'transparent',
              cursor: 'pointer',
            }}
          >
            ADMIN LOGOUT
          </button>
        </div>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <div
          className="rounded-sm border p-4 flex flex-col gap-3"
          style={{
            backgroundColor: '#0d0d14',
            borderColor: 'rgba(34,211,238,0.2)',
          }}
        >
          <div className="text-xs font-bold tracking-widest mb-1" style={{ color: '#22d3ee' }}>
            CREATE NEW USER
          </div>
          <div>
            <label className="block text-xs tracking-wider mb-1" style={{ color: '#71717a' }}>
              USERNAME
            </label>
            <input
              data-testid="input-new-username"
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-sm text-sm outline-none"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="block text-xs tracking-wider mb-1" style={{ color: '#71717a' }}>
              PASSWORD (min 6 chars)
            </label>
            <input
              data-testid="input-new-password"
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-sm text-sm outline-none"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="block text-xs tracking-wider mb-1" style={{ color: '#71717a' }}>
              EXPIRES AT
            </label>
            <input
              data-testid="input-new-expires"
              type="datetime-local"
              value={newExpiresAt}
              onChange={(e) => setNewExpiresAt(e.target.value)}
              className="w-full px-3 py-2 rounded-sm text-sm outline-none"
              style={inputStyle}
            />
          </div>
          {createError && (
            <p className="text-xs" style={{ color: '#f87171' }} data-testid="create-error">
              {createError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              data-testid="btn-create-user"
              onClick={handleCreate}
              disabled={createUser.isPending}
              className="flex-1 py-2 text-sm rounded-sm tracking-wider font-bold transition-all active:scale-95"
              style={{
                border: '2px solid #22d3ee',
                color: '#22d3ee',
                backgroundColor: 'rgba(34,211,238,0.1)',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {createUser.isPending ? 'CREATING...' : 'CREATE'}
            </button>
            <button
              data-testid="btn-cancel-create"
              onClick={() => setShowCreateForm(false)}
              className="flex-1 py-2 text-sm rounded-sm tracking-wider transition-all active:scale-95"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#71717a',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* User List */}
      {users.isLoading && (
        <div className="text-sm text-center py-8" style={{ color: '#71717a' }}>
          LOADING USERS...
        </div>
      )}
      {users.data && users.data.length === 0 && (
        <div className="text-sm text-center py-8" style={{ color: '#71717a' }}>
          NO USERS FOUND
        </div>
      )}
      {users.data && users.data.map((user: UserAccount) => (
        <UserRow key={user.id} user={user} onRefresh={handleRefresh} />
      ))}
    </div>
  );
}

export default function AdminPage() {
  const [isAdminAuthed, setIsAdminAuthed] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const adminLogin = useAdminLogin();

  function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    adminLogin.mutate(
      { data: { password: adminPassword } },
      {
        onSuccess: () => {
          setIsAdminAuthed(true);
        },
        onError: () => {
          setLoginError('Invalid admin password.');
        },
      }
    );
  }

  if (isAdminAuthed) {
    return (
      <div
        className="min-h-screen px-4 py-6"
        style={{ backgroundColor: '#060609', fontFamily: "'JetBrains Mono', monospace" }}
      >
        <div className="max-w-2xl mx-auto">
          <div className="mb-4 flex items-center gap-3">
            <span
              className="text-sm font-bold tracking-wider"
              style={{ color: '#22d3ee' }}
            >
              ⚡ META-EXPERT REGIME TRACKER
            </span>
            <span style={{ color: '#71717a' }}>/</span>
            <span className="text-sm" style={{ color: '#71717a' }}>
              ADMIN
            </span>
          </div>
          <AdminManagement />
        </div>
      </div>
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
        <div className="text-center mb-8">
          <h1
            className="text-2xl font-black tracking-widest mb-2"
            style={{
              color: '#a855f7',
              textShadow: '0 0 20px rgba(168,85,247,0.5), 0 0 40px rgba(168,85,247,0.2)',
            }}
          >
            ⚡ ADMIN ACCESS
          </h1>
          <p className="text-xs tracking-widest" style={{ color: '#71717a' }}>
            RESTRICTED CONTROL PANEL
          </p>
        </div>

        <form onSubmit={handleAdminLogin} className="space-y-4">
          <div>
            <label
              className="block text-xs tracking-wider mb-1"
              style={{ color: '#71717a' }}
            >
              ADMIN PASSWORD
            </label>
            <input
              data-testid="input-admin-password"
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 rounded-sm text-sm outline-none transition-all"
              style={{
                backgroundColor: '#060609',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#e2e8f0',
                fontFamily: "'JetBrains Mono', monospace",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(168,85,247,0.5)';
                e.currentTarget.style.boxShadow = '0 0 0 1px rgba(168,85,247,0.3)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          {loginError && (
            <p
              data-testid="admin-login-error"
              className="text-xs text-center py-2 px-3 rounded-sm"
              style={{
                color: '#f87171',
                backgroundColor: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.2)',
              }}
            >
              {loginError}
            </p>
          )}

          <button
            data-testid="btn-admin-login"
            type="submit"
            disabled={adminLogin.isPending}
            className="w-full py-3 rounded-sm text-sm font-bold tracking-widest transition-all active:scale-95"
            style={{
              backgroundColor: 'rgba(168,85,247,0.12)',
              border: '2px solid #a855f7',
              color: '#a855f7',
              fontFamily: "'JetBrains Mono', monospace",
              boxShadow: '0 0 12px rgba(168,85,247,0.2)',
              cursor: adminLogin.isPending ? 'not-allowed' : 'pointer',
              opacity: adminLogin.isPending ? 0.7 : 1,
            }}
          >
            {adminLogin.isPending ? 'VERIFYING...' : 'LOGIN'}
          </button>
        </form>
      </div>
    </div>
  );
}
