import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, Card, ErrorNote, Field, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';

interface AuthStatus {
  needsSetup: boolean;
  oidc: { enabled: boolean; displayName: string; allowPassword: boolean };
}

const useAuthStatus = () => useQuery({ queryKey: ['auth-status'], queryFn: () => api.get<AuthStatus>('/api/auth/status') });

function AuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <span aria-hidden className="inline-flex size-12 items-center justify-center rounded-2xl bg-accent font-bold text-accent-ink">
          S/O
        </span>
        <span className="font-display text-2xl font-bold">Snack Overflow</span>
      </div>
      <h1 className="mb-2 text-3xl font-bold">{title}</h1>
      {intro && <div className="mb-6 text-muted">{intro}</div>}
      <Card className="p-5">{children}</Card>
    </main>
  );
}

function useSubmit(fn: () => Promise<unknown>, after: () => void) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

export function LoginPage() {
  const status = useAuthStatus();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const next = params.get('next') ?? '/';
  const { submit, error, busy } = useSubmit(
    () => api.post('/api/auth/login', { email, password }),
    () => {
      void qc.invalidateQueries();
      navigate(next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    },
  );
  if (status.isPending) return <Spinner />;
  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;
  const oidc = status.data?.oidc;
  return (
    <AuthFrame title="Sign in">
      {params.get('error') && <ErrorNote error={params.get('error')} />}
      {oidc?.enabled && (
        <a href="/api/auth/oidc/start" className="mb-4 flex min-h-12 items-center justify-center rounded-xl bg-accent font-semibold text-accent-ink">
          Continue with {oidc.displayName}
        </a>
      )}
      {(!oidc || oidc.allowPassword) && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email">{(id) => <TextInput id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password">
            {(id) => <TextInput id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" variant={oidc?.enabled ? 'outline' : 'primary'} size="lg" disabled={busy}>
            Sign in
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function SetupPage() {
  const status = useAuthStatus();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ householdName: '', name: '', email: '', password: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const { submit, error, busy } = useSubmit(
    () => api.post('/api/auth/setup', form),
    () => {
      void qc.invalidateQueries();
      navigate('/', { replace: true });
    },
  );
  if (status.isPending) return <Spinner />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;
  return (
    <AuthFrame title="Welcome" intro="Set up your household. You'll be its admin and can invite everyone else after.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Household name" hint="e.g. The Smiths, or Flat 4">
          {(id) => <TextInput id={id} required value={form.householdName} onChange={set('householdName')} />}
        </Field>
        <Field label="Your name">{(id) => <TextInput id={id} autoComplete="name" required value={form.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <TextInput id={id} type="email" autoComplete="email" required value={form.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 8 characters.">
          {(id) => <TextInput id={id} type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={set('password')} />}
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          Create household
        </Button>
      </form>
    </AuthFrame>
  );
}

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<{ email: string | null; role: string; householdName: string; passwordAllowed: boolean }>(`/api/invites/${token}`),
    retry: false,
  });
  const status = useAuthStatus();
  const [form, setForm] = useState<{ name: string; email: string | null; password: string }>({ name: '', email: null, password: '' });
  const email = form.email ?? invite.data?.email ?? '';
  const { submit, error, busy } = useSubmit(
    () => api.post(`/api/invites/${token}/accept`, { name: form.name, email, password: form.password }),
    () => {
      void qc.invalidateQueries();
      navigate('/', { replace: true });
    },
  );
  if (invite.isPending) return <Spinner />;
  if (invite.error) {
    return (
      <AuthFrame title="Invite not found">
        <ErrorNote error={invite.error} />
      </AuthFrame>
    );
  }
  const oidc = status.data?.oidc;
  return (
    <AuthFrame title={`Join ${invite.data.householdName}`} intro="Share the household's stock, best-before dates and plans.">
      {oidc?.enabled && (
        <a href={`/api/auth/oidc/start?invite=${encodeURIComponent(token)}`} className="mb-4 flex min-h-12 items-center justify-center rounded-xl bg-accent font-semibold text-accent-ink">
          Continue with {oidc.displayName}
        </a>
      )}
      {invite.data.passwordAllowed && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Your name">{(id) => <TextInput id={id} autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Email">
            {(id) => <TextInput id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            {(id) => (
              <TextInput id={id} type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            )}
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            Join
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}
