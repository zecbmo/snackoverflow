import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { keys } from '../lib/queries';

export function ProfilePage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState(me.user.name);
  const [email, setEmail] = useState(me.user.email);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pwError, setPwError] = useState<unknown>(null);

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.patch('/api/me', { name, email });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.session }), qc.invalidateQueries({ queryKey: ['users'] })]);
      toast.show('Saved.');
    } catch (err) {
      setError(err);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwError(null);
    try {
      await api.patch('/api/me', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      toast.show('Password changed. Other devices have been signed out.');
    } catch (err) {
      setPwError(err);
    }
  };

  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login');
  };

  return (
    <>
      <PageHeader title="Your profile" subtitle={me.household.name} left={<BackButton />} />
      <div className="flex max-w-xl flex-col gap-5">
        <Card className="p-5">
          <form onSubmit={(e) => void saveDetails(e)} className="flex flex-col gap-4">
            <Field label="Name">{(id) => <TextInput id={id} required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Email">
              {(id) => <TextInput id={id} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <ErrorNote error={error} />
            <Button type="submit" variant="primary" className="self-start">
              Save
            </Button>
          </form>
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-lg font-bold">Change password</h2>
          <form onSubmit={(e) => void changePassword(e)} className="flex flex-col gap-4">
            <Field label="Current password">
              {(id) => <TextInput id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              {(id) => <TextInput id={id} type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
            </Field>
            <ErrorNote error={pwError} />
            <Button type="submit" className="self-start" disabled={next.length < 8}>
              Change password
            </Button>
          </form>
        </Card>
        <Button variant="danger" size="lg" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </>
  );
}
