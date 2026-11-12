import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, ErrorNote, Field, TextInput } from '../components/ui';
import { forgetDevice } from '../lib/native';
import { normaliseServerUrl, serverUrl, setServerUrl } from '../lib/platform';

/** Android app, first launch: which server is your household's Snack Overflow on? */
export function ConnectPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [value, setValue] = useState(serverUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let url: string;
    try {
      url = normaliseServerUrl(value);
    } catch {
      setError("That doesn't look like a web address.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { ok?: boolean };
      if (!body.ok) throw new Error('not snack overflow');
      if (url !== serverUrl()) await forgetDevice();
      setServerUrl(url);
      qc.clear();
      navigate('/login', { replace: true });
    } catch {
      setError(`Couldn't find Snack Overflow at ${url}. Check the address and that this phone is on the right network.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <span aria-hidden className="inline-flex size-12 items-center justify-center rounded-2xl bg-accent font-bold text-accent-ink">
          S/O
        </span>
        <span className="font-display text-xl font-bold sm:text-2xl">Snack Overflow</span>
      </div>
      <h1 className="mb-2 text-3xl font-bold">Connect to your server</h1>
      <p className="mb-6 text-muted">Enter the address you use to open Snack Overflow in a browser.</p>
      <Card className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Server address" hint="e.g. https://snacks.example.com or http://192.168.1.20:3000">
            {(id) => (
              <TextInput id={id} type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" required value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </Field>
          {error && <ErrorNote error={error} />}
          <Button type="submit" variant="primary" size="lg" disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Connect'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
