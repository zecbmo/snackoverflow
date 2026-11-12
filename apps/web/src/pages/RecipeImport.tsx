import { type FormEvent, useState } from 'react';
import type { RecipeDraftDto } from '@snackoverflow/shared';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { type Draft, RecipeForm } from './RecipeEditor';

/** Import from a link (schema.org data most recipe sites publish), then review before saving. */
export function RecipeImportPage() {
  const me = useMe();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const aiEnabled = me.features.ai;

  const load = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setDraft(await api.post<RecipeDraftDto>('/api/recipes/import', { url: url.trim() }));
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const tidy = async (current: Draft) => {
    setBusy(true);
    try {
      const better = await api.post<RecipeDraftDto>('/api/recipes/tidy', { draft: current });
      setDraft(better);
      setVersion((v) => v + 1);
      toast.show('Tidied up. Check the matches, then save.');
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Import a recipe" left={<BackButton to="/recipes" />} />
      <Card className="mb-5 max-w-3xl p-5">
        <form onSubmit={load} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Recipe link" hint="Works with BBC Good Food, Hello Fresh and most recipe blogs.">
              {(id) => <TextInput id={id} type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />}
            </Field>
          </div>
          <Button type="submit" variant={draft ? 'outline' : 'primary'} disabled={busy || !url.trim()}>
            {busy && !draft ? 'Reading…' : 'Import'}
          </Button>
        </form>
        {error !== null && (
          <div className="mt-3">
            <ErrorNote error={error} />
          </div>
        )}
      </Card>
      {draft && (
        <RecipeForm
          key={version}
          initial={draft}
          extraActions={(current) => (
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <p className="flex-1 text-[0.9375rem]">Check each ingredient is matched to the right thing. Highlighted lines need a look.</p>
              {aiEnabled && (
                <Button variant="outline" disabled={busy} onClick={() => void tidy(current)}>
                  {busy ? 'Tidying…' : 'Tidy up with AI'}
                </Button>
              )}
            </Card>
          )}
        />
      )}
    </>
  );
}
