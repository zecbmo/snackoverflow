/** "Use it up": the AI makes up a recipe around food going off, to check and save like any other. */
import { type FormEvent, useState } from 'react';
import type { RecipeDraftDto } from '@snackoverflow/shared';
import { BackButton, useMe } from '../components/Layout';
import { Button, Card, ErrorNote, Field, PageHeader, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { RecipeForm } from './RecipeEditor';

export function UseItUpPage() {
  const me = useMe();
  const [serves, setServes] = useState('2');
  const [request, setRequest] = useState('');
  const [draft, setDraft] = useState<RecipeDraftDto | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const make = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDraft(await api.post<RecipeDraftDto>('/api/recipes/use-it-up', { serves: Math.max(1, Math.min(20, Number(serves) || 2)), request: request.trim() || null }));
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Use it up" left={<BackButton to="/recipes" />} />
      <Card className="mb-5 max-w-3xl p-5">
        {!me.features.ai ? (
          <p>This needs AI. An admin can add a key in Settings.</p>
        ) : (
          <form onSubmit={make} className="flex flex-col gap-3">
            <p className="text-[0.9375rem] text-muted">A recipe made up around the food you have that’s going off soonest, using what else is in. Check it, then save it.</p>
            <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
              <Field label="Serves">{(id) => <TextInput id={id} inputMode="numeric" value={serves} onChange={(e) => setServes(e.target.value)} />}</Field>
              <Field label="Anything to bear in mind?" hint="Optional, e.g. vegetarian, under 30 minutes, no chilli.">
                {(id) => <TextInput id={id} value={request} maxLength={300} onChange={(e) => setRequest(e.target.value)} />}
              </Field>
            </div>
            <Button type="submit" variant={draft ? 'outline' : 'primary'} className="self-start" disabled={busy}>
              {busy ? 'Thinking…' : draft ? 'Try another' : 'Make up a recipe'}
            </Button>
            <ErrorNote error={error} />
          </form>
        )}
      </Card>
      {draft && (
        <RecipeForm
          key={version}
          initial={draft}
          extraActions={() => (
            <Card className="p-4">
              <p className="text-[0.9375rem]">Made up for you, so check the amounts and steps. Highlighted lines need a look.</p>
            </Card>
          )}
        />
      )}
    </>
  );
}
