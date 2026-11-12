import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { InviteDto, Role, UserDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { type Column, DataTable } from '../components/DataTable';
import { PageTop } from '../components/Toolbar';
import { Button, ErrorNote, Field, Select, Sheet, Spinner, TextInput } from '../components/ui';
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
  const [targeting, setTargeting] = useState<UserDto | null>(null);

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

  const avatar = (u: UserDto) => (
    <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-strong text-xs font-semibold text-strong-ink lg:size-6">
      {u.name.charAt(0).toUpperCase()}
    </span>
  );
  const nameCell = (u: UserDto) => (
    <span className="inline-flex items-center gap-2 font-semibold text-ink">
      {avatar(u)}
      {u.name}
      {u.id === me.user.id && <span className="font-normal text-muted">(you)</span>}
    </span>
  );
  const canEdit = (u: UserDto) => isAdmin && u.id !== me.user.id;
  const roleCell = (u: UserDto) =>
    canEdit(u) ? (
      <Select aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => void setRole(u, e.target.value as Role)} className="w-28 lg:w-28">
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </Select>
    ) : (
      <span>{u.role === 'admin' ? 'Admin' : 'Member'}</span>
    );
  const targetCell = (u: UserDto) =>
    isAdmin ? (
      <button type="button" onClick={() => setTargeting(u)} className="font-medium text-accent-text hover:underline" aria-label={`Daily calorie target for ${u.name}`}>
        {u.kcalTarget ? `${u.kcalTarget.toLocaleString('en-GB')} kcal` : 'Set'}
      </button>
    ) : u.kcalTarget ? (
      `${u.kcalTarget.toLocaleString('en-GB')} kcal`
    ) : (
      ''
    );
  const removeButton = (u: UserDto) =>
    canEdit(u) ? (
      <button
        type="button"
        aria-label={`Remove ${u.name}`}
        onClick={() => setRemoving(u)}
        className="inline-flex size-10 items-center justify-center rounded-lg text-danger hover:bg-card-muted lg:size-7 lg:rounded-md"
      >
        <Icon name="trash" className="size-4" />
      </button>
    ) : null;
  const columns: Column<UserDto>[] = [
    { key: 'name', header: 'Name', cell: nameCell },
    { key: 'email', header: 'Email', cell: (u) => u.email },
    { key: 'role', header: 'Role', cell: roleCell },
    { key: 'target', header: 'Daily target', cell: targetCell },
  ];
  const inviteColumns: Column<PendingInvite>[] = [
    { key: 'who', header: 'Invite', cell: (i) => <span className="font-medium text-ink">{i.email ?? 'Invite link'}</span> },
    { key: 'role', header: 'Role', cell: (i) => (i.role === 'admin' ? 'Admin' : 'Member') },
    { key: 'until', header: 'Expires', cell: (i) => new Date(i.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) },
  ];

  return (
    <div className="max-w-5xl">
      <PageTop
        title="People"
        subtitle={me.household.name}
        left={<MenuButton />}
        actions={
          isAdmin && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <Icon name="plus" className="size-4" /> Invite someone
            </Button>
          )
        }
      />
      <ErrorNote error={users.error} />
      {users.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="People"
          columns={columns}
          rows={users.data ?? []}
          rowKey={(u) => u.id}
          actions={isAdmin ? removeButton : undefined}
          phone={(u) => ({
            lead: avatar(u),
            title: (
              <>
                {u.name}
                {u.id === me.user.id && <span className="font-normal text-muted"> (you)</span>}
              </>
            ),
            meta: `${u.email}${u.kcalTarget ? ` · ${u.kcalTarget.toLocaleString('en-GB')} kcal a day` : ''}`,
            badge: canEdit(u) ? null : <span className="text-sm text-muted">{u.role === 'admin' ? 'Admin' : 'Member'}</span>,
            actions: canEdit(u) ? (
              <>
                {roleCell(u)}
                <Button size="xs" variant="ghost" onClick={() => setTargeting(u)}>
                  Calorie target
                </Button>
                {removeButton(u)}
              </>
            ) : undefined,
          })}
        />
      )}
      {isAdmin && (invites.data?.length ?? 0) > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 font-bold">Waiting to join</h2>
          <DataTable
            label="Waiting to join"
            columns={inviteColumns}
            rows={invites.data ?? []}
            rowKey={(i) => i.id}
            actions={(i) => (
              <Button size="xs" variant="ghost" onClick={() => void revoke(i.id)}>
                Cancel invite
              </Button>
            )}
            phone={(i) => ({
              title: i.email ?? 'Invite link',
              meta: `${i.role === 'admin' ? 'Admin' : 'Member'} · until ${new Date(i.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
              badge: (
                <Button size="xs" variant="ghost" onClick={() => void revoke(i.id)}>
                  Cancel
                </Button>
              ),
            })}
          />
        </section>
      )}
      <Sheet open={inviting} onClose={() => setInviting(false)} title="Invite someone">
        {inviting && <InviteForm onCreated={() => void refresh()} />}
      </Sheet>
      {targeting && <TargetSheet user={targeting} onClose={() => setTargeting(null)} />}
      <Sheet open={removing !== null} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`}>
        {removing && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">They'll be signed out and won't be able to see the household any more. Their stock history stays.</p>
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={() => setRemoving(null)}>Keep</Button>
              <Button variant="danger" onClick={() => void remove(removing)}>
                Remove
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
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

/** An admin sets someone's daily calorie target (shown on the dashboard). */
function TargetSheet({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(user.kcalTarget ? String(user.kcalTarget) : '');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(`/api/users/${user.id}`, { kcalTarget: value.trim() ? Number(value) : null });
      await qc.invalidateQueries({ queryKey: ['users'] });
      await qc.invalidateQueries({ queryKey: ['plan', 'calories'] });
      toast.show('Saved.');
      onClose();
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };
  return (
    <Sheet open onClose={onClose} title={`${user.name}'s calorie target`}>
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
        <Field label="Calories a day" hint="Leave empty for no target.">
          {(id) => <TextInput id={id} type="number" inputMode="numeric" min={500} max={10000} step={50} placeholder="2000" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" size="lg">
          Save
        </Button>
      </form>
    </Sheet>
  );
}
