import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { InviteDto, Role, UserDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useUsers } from '../lib/queries';

type PendingInvite = Omit<InviteDto, 'url'> & { url: null };

export function PeoplePage() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  const users = useUsers();
  const invites = useQuery({
    queryKey: ['users', 'invites'],
    queryFn: () => api.get<PendingInvite[]>('/api/invites'),
    enabled: isAdmin,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<UserDto | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const setRole = async (u: UserDto, role: Role) => {
    try {
      await api.patch(`/api/users/${u.id}`, { role });
      await refresh();
      toast.show(`${u.name} is now ${role === 'admin' ? 'an admin' : 'a member'}.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
      await refresh();
    }
  };
  const remove = async (u: UserDto) => {
    try {
      await api.del(`/api/users/${u.id}`);
      await refresh();
      toast.show(`Removed ${u.name}.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
    setRemoving(null);
  };
  const revoke = async (id: string) => {
    try {
      await api.del(`/api/invites/${id}`);
      await refresh();
      toast.show('Invite cancelled.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <>
      <PageHeader
        title="People"
        subtitle={me.household.name}
        left={<MenuButton />}
        right={
          isAdmin && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <Icon name="plus" className="size-5" /> Invite
            </Button>
          )
        }
      />
      {users.isPending ? (
        <Spinner />
      ) : users.error ? (
        <ErrorNote error={users.error} />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {users.data.map((u) => (
            <div key={u.id} className="flex min-h-16 flex-wrap items-center gap-3 px-4 py-3">
              <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-ink font-semibold text-bg">
                {u.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">
                  {u.name}
                  {u.id === me.user.id && <span className="font-normal text-muted"> (you)</span>}
                </span>
                <span className="block truncate text-sm text-muted">{u.email}</span>
              </span>
              {isAdmin && u.id !== me.user.id ? (
                <div className="flex items-center gap-2">
                  <Select aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => void setRole(u, e.target.value as Role)} className="w-32">
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </Select>
                  <button
                    type="button"
                    aria-label={`Remove ${u.name}`}
                    onClick={() => setRemoving(u)}
                    className="inline-flex size-11 items-center justify-center rounded-full text-danger hover:bg-card-muted"
                  >
                    <Icon name="trash" className="size-5" />
                  </button>
                </div>
              ) : (
                <span className="text-sm font-semibold text-muted">{u.role === 'admin' ? 'Admin' : 'Member'}</span>
              )}
            </div>
          ))}
        </Card>
      )}
      {isAdmin && (invites.data?.length ?? 0) > 0 && (
        <>
          <h2 className="mb-3 mt-6 text-lg font-bold">Waiting to join</h2>
          <Card className="divide-y divide-line overflow-hidden">
            {invites.data?.map((i) => (
              <div key={i.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{i.email ?? 'Invite link'}</span>
                  <span className="block text-sm text-muted">
                    {i.role === 'admin' ? 'Admin' : 'Member'} · until {new Date(i.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void revoke(i.id)}>
                  Cancel
                </Button>
              </div>
            ))}
          </Card>
        </>
      )}
      <Sheet open={inviting} onClose={() => setInviting(false)} title="Invite someone">
        {inviting && <InviteForm onCreated={() => void refresh()} />}
      </Sheet>
      <Sheet open={removing !== null} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`}>
        {removing && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">They'll be signed out and won't be able to see the household any more. Their stock history stays.</p>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={() => setRemoving(null)}>
                Keep
              </Button>
              <Button size="lg" variant="danger" onClick={() => void remove(removing)}>
                Remove
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}

function InviteForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [result, setResult] = useState<(InviteDto & { emailed: boolean }) | null>(null);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setResult(await api.post<InviteDto & { emailed: boolean }>('/api/invites', { email: email.trim() || null, role }));
      onCreated();
    } catch (err) {
      setError(err);
    }
  };

  if (result) {
    return (
      <div className="flex flex-col gap-3">
        {result.emailed && result.email && <p>Emailed to {result.email}.</p>}
        <p className="text-muted">Send them this link. It works once, for 7 days.</p>
        <Field label="Invite link">{(id) => <TextInput id={id} readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} />}</Field>
        <Button
          variant="primary"
          size="lg"
          onClick={() =>
            void navigator.clipboard
              .writeText(result.url)
              .then(() => toast.show('Link copied.'))
              .catch(() => toast.show("Couldn't copy. Select the link and copy it instead.", { tone: 'error' }))
          }
        >
          <Icon name="copy" className="size-5" /> Copy link
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Email" hint="Optional. We'll email the link if email is set up.">
        {(id) => <TextInput id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field label="Role" hint="Admins can manage people and household settings.">
        {(id) => (
          <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
        )}
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" variant="primary" size="lg">
        Create invite
      </Button>
    </form>
  );
}
