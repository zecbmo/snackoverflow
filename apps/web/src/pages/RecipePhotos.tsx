/**
 * The recipe photo bank: snap cookbook pages or both sides of recipe cards now, and have them
 * all read into recipes later in one go (AI), or by your own assistant (MCP).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { RecipeScanDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { PageTop, Segmented } from '../components/Toolbar';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { photoBody } from '../lib/images';

const STATUS: Record<RecipeScanDto['status'], string> = { waiting: 'Waiting to be read', reading: 'Reading…', failed: "Couldn't read", done: 'Read' };

export const useRecipeScans = () =>
  useQuery({
    queryKey: ['recipes', 'scans'],
    queryFn: () => api.get<RecipeScanDto[]>('/api/recipe-scans'),
    // While something's being read, check back now and then.
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'reading') ? 3000 : false),
  });

export function RecipePhotosPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const scans = useRecipeScans();
  const [together, setTogether] = useState<'one' | 'each'>('one');
  const [busy, setBusy] = useState<'upload' | 'read' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const all = scans.data ?? [];
  const toRead = all.filter((s) => s.status !== 'done');
  const done = all.filter((s) => s.status === 'done');
  const refresh = () => qc.invalidateQueries({ queryKey: ['recipes'] });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('upload');
    setError(null);
    try {
      const photos = await Promise.all([...files].slice(0, 20).map(photoBody));
      const { ids } = await api.post<{ ids: string[] }>('/api/recipe-scans', { photos, separate: together === 'each' });
      await refresh();
      toast.show(ids.length === 1 ? 'Added. It’s waiting to be read.' : `Added ${ids.length} recipes. They’re waiting to be read.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const readAll = async () => {
    setBusy('read');
    setError(null);
    try {
      const { started } = await api.post<{ started: number }>('/api/recipe-scans/read-all', {});
      await refresh();
      toast.show(started ? `Reading ${started}. They’ll turn into recipes as they’re done.` : 'Nothing to read.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: RecipeScanDto) => {
    try {
      await api.del(`/api/recipe-scans/${s.id}`);
      await refresh();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <div className="max-w-3xl">
      <PageTop
        title="Recipe photos"
        subtitle={toRead.length ? `${toRead.length} to read` : undefined}
        left={<BackButton to="/recipes" />}
        actions={
          me.features.ai && toRead.length > 0 ? (
            <Button variant="primary" disabled={busy !== null || toRead.every((s) => s.status === 'reading')} onClick={() => void readAll()}>
              {busy === 'read' ? 'Starting…' : `Read ${toRead.length === 1 ? 'it' : `all ${toRead.length}`} with AI`}
            </Button>
          ) : undefined
        }
      />
      <Card className="mb-5 flex flex-col gap-3 p-4">
        <p className="text-sm text-muted">
          Snap recipes now and turn them into recipes later. Lines that can&apos;t be matched to your food wait in{' '}
          <Link to="/unmatched" className="font-semibold text-accent-text">
            Unmatched ingredients
          </Link>
          .
          {!me.features.ai && me.features.mcp && ' Ask your assistant (for example Claude) to read your waiting recipe photos.'}
          {!me.features.ai && !me.features.mcp && ' To have them read, add an AI key or turn on your own assistant in Settings.'}
        </p>
        <Segmented
          label="Photos"
          value={together}
          onChange={setTogether}
          options={[
            { value: 'one', label: 'All one recipe (front and back)' },
            { value: 'each', label: 'One recipe each' },
          ]}
        />
        <label
          className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 self-start rounded-lg bg-accent px-4 font-semibold text-accent-ink hover:brightness-110 lg:min-h-9 ${busy === 'upload' ? 'opacity-60' : ''}`}
        >
          <Icon name="camera" className="size-5" />
          {busy === 'upload' ? 'Adding…' : 'Add photos'}
          <input type="file" accept="image/*" multiple className="sr-only" disabled={busy !== null} onChange={(e) => void upload(e.target.files)} />
        </label>
      </Card>
      <ErrorNote error={error ?? scans.error} />
      {scans.isPending ? (
        <Spinner />
      ) : all.length === 0 ? (
        <EmptyState title="No recipe photos">Add photos of recipes you want to keep.</EmptyState>
      ) : (
        <>
          {toRead.length > 0 && <ScanList title="To read" scans={toRead} onRemove={remove} />}
          {done.length > 0 && <ScanList title="Read" scans={done.slice(0, 20)} onRemove={remove} />}
        </>
      )}
    </div>
  );
}

function ScanList({ title, scans, onRemove }: { title: string; scans: RecipeScanDto[]; onRemove: (s: RecipeScanDto) => void }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-muted">{title}</h2>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-card">
        {scans.map((s) => (
          <li key={s.id} className="flex items-center gap-3 p-3">
            <div className="flex shrink-0 gap-1">
              {Array.from({ length: Math.min(s.imageCount, 3) }, (_, i) => (
                <img key={i} src={`/api/recipe-scans/${s.id}/images/${i}`} alt="" className="size-14 rounded-md border border-line object-cover" loading="lazy" />
              ))}
              {s.imageCount === 0 && (
                <span className="inline-flex size-14 items-center justify-center rounded-md border border-line text-muted">
                  <Icon name="recipe" className="size-6" />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {s.recipeId ? (
                <Link to={`/recipes/${s.recipeId}`} className="block truncate font-semibold text-accent-text">
                  {s.recipeTitle ?? 'Recipe'}
                </Link>
              ) : (
                <p className="font-semibold">
                  {s.imageCount} photo{s.imageCount === 1 ? '' : 's'}
                </p>
              )}
              <p className={`text-sm ${s.status === 'failed' ? 'text-danger' : 'text-muted'}`}>{s.status === 'failed' && s.error ? s.error : STATUS[s.status]}</p>
            </div>
            {s.status !== 'reading' && (
              <button
                type="button"
                aria-label={s.status === 'done' ? 'Remove from this list' : 'Delete these photos'}
                onClick={() => onRemove(s)}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-card-muted lg:size-8"
              >
                <Icon name="trash" className="size-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
