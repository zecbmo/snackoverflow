/**
 * New recipe, edit, and the review screen after importing a link. Each
 * ingredient line shows which ingredient it was matched to; uncertain matches
 * are flagged so the cook can check them before saving.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { RecipeDraftDto, RecipeDto, RecipeInput } from '@snackoverflow/shared';
import { BackButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Select, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useIngredients, useRecipe } from '../lib/queries';

export type DraftLine = RecipeDraftDto['ingredients'][number];
export type Draft = Omit<RecipeDraftDto, 'ingredients'> & { ingredients: DraftLine[] };

export const emptyDraft = (): Draft => ({
  title: '',
  serves: 4,
  steps: [],
  imageUrl: null,
  sourceUrl: null,
  tags: [],
  prepMinutes: null,
  cookMinutes: null,
  ingredients: [],
});

export function draftFromRecipe(r: RecipeDto): Draft {
  return {
    title: r.title,
    serves: r.serves,
    steps: r.steps,
    imageUrl: r.imageUrl,
    sourceUrl: r.sourceUrl,
    tags: r.tags,
    prepMinutes: r.prepMinutes,
    cookMinutes: r.cookMinutes,
    ingredients: r.ingredients.map((l) => ({
      text: l.text,
      amount: l.amount,
      unit: l.unit,
      ingredientId: l.ingredientId,
      ingredientName: l.ingredientName,
      productId: l.productId,
      note: l.note,
      optional: l.optional,
      matchConfidence: l.ingredientId ? 'high' : 'none',
    })),
  };
}

const UNITS: [string, string][] = [
  ['', '–'],
  ['g', 'g'],
  ['kg', 'kg'],
  ['ml', 'ml'],
  ['l', 'L'],
  ['tsp', 'tsp'],
  ['tbsp', 'tbsp'],
  ['cup_metric', 'cup'],
  ['count', 'item'],
  ['pinch', 'pinch'],
];

const num = (s: string) => (s.trim() === '' ? null : Number(s));

export function RecipeForm({ initial, recipeId, extraActions }: { initial: Draft; recipeId?: string; extraActions?: (draft: Draft, replace: (d: Draft) => void) => ReactNode }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const ingredients = useIngredients().data ?? [];
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) => ({ ...d, ingredients: d.ingredients.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const addLines = async (text: string) => {
    const lines = text.split('\n').map((l) => l.replace(/^[-•*\s]+/, '').trim()).filter(Boolean);
    if (!lines.length) return;
    try {
      const parsed = await api.post<DraftLine[]>('/api/recipes/parse-lines', { lines });
      setDraft((d) => ({ ...d, ingredients: [...d.ingredients, ...parsed] }));
      setPaste('');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const reparse = async (i: number, text: string) => {
    try {
      const [p] = await api.post<DraftLine[]>('/api/recipes/parse-lines', { lines: [text] });
      if (p) setLine(i, { ...p });
    } catch {
      // Keep what they typed.
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const body: RecipeInput = {
      title: draft.title,
      serves: draft.serves,
      steps: draft.steps.map((s) => s.trim()).filter(Boolean),
      imageUrl: draft.imageUrl || null,
      sourceUrl: draft.sourceUrl || null,
      tags: draft.tags,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      ingredients: draft.ingredients.map((l) => ({
        text: l.text,
        amount: l.amount,
        unit: l.unit || null,
        ingredientId: l.ingredientId,
        productId: l.productId,
        note: l.note,
        optional: l.optional,
      })),
    };
    try {
      const saved = recipeId ? await api.put<RecipeDto>(`/api/recipes/${recipeId}`, body) : await api.post<RecipeDto>('/api/recipes', body);
      await qc.invalidateQueries({ queryKey: ['recipes'] });
      toast.show(recipeId ? 'Saved.' : `Added ${saved.title}.`);
      navigate(`/recipes/${saved.id}`, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const uncertain = draft.ingredients.filter((l) => l.matchConfidence !== 'high' && l.amount !== null).length;

  return (
    <form onSubmit={save} className="flex max-w-3xl flex-col gap-5">
      {extraActions?.(draft, setDraft)}
      <Card className="flex flex-col gap-4 p-5">
        <Field label="Title">{(id) => <TextInput id={id} required value={draft.title} onChange={(e) => set({ title: e.target.value })} />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Serves">{(id) => <TextInput id={id} inputMode="numeric" value={String(draft.serves)} onChange={(e) => set({ serves: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
          <Field label="Prep (min)">{(id) => <TextInput id={id} inputMode="numeric" value={draft.prepMinutes ?? ''} onChange={(e) => set({ prepMinutes: num(e.target.value) })} />}</Field>
          <Field label="Cook (min)">{(id) => <TextInput id={id} inputMode="numeric" value={draft.cookMinutes ?? ''} onChange={(e) => set({ cookMinutes: num(e.target.value) })} />}</Field>
        </div>
        <Field label="Tags" hint="Comma separated, e.g. dinner, veggie, freezes well">
          {(id) => (
            <TextInput
              id={id}
              defaultValue={draft.tags.join(', ')}
              onBlur={(e) => set({ tags: e.target.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) })}
            />
          )}
        </Field>
        <Field label="Photo link (optional)">{(id) => <TextInput id={id} type="url" value={draft.imageUrl ?? ''} onChange={(e) => set({ imageUrl: e.target.value || null })} />}</Field>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-bold">Ingredients</h2>
          {uncertain > 0 && <span className="text-sm font-semibold text-accent-text">{uncertain} to check</span>}
        </div>
        {draft.ingredients.map((l, i) => {
          const check = l.matchConfidence !== 'high' && l.amount !== null;
          return (
            <div key={i} className={`flex flex-col gap-2 rounded-lg border p-3 ${check ? 'border-accent bg-accent-soft/50' : 'border-line'}`}>
              <div className="flex gap-2">
                <TextInput aria-label={`Ingredient line ${i + 1}`} value={l.text} onChange={(e) => setLine(i, { text: e.target.value })} onBlur={(e) => void reparse(i, e.target.value)} />
                <button
                  type="button"
                  aria-label={`Remove ${l.text}`}
                  onClick={() => setDraft((d) => ({ ...d, ingredients: d.ingredients.filter((_, j) => j !== i) }))}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-line text-xl"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-[5rem_6rem_1fr] gap-2">
                <TextInput aria-label="Amount" inputMode="decimal" value={l.amount ?? ''} onChange={(e) => setLine(i, { amount: num(e.target.value) })} />
                <Select aria-label="Unit" value={l.unit ?? ''} onChange={(e) => setLine(i, { unit: e.target.value || null })}>
                  {UNITS.map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Matched ingredient"
                  value={l.ingredientId ?? ''}
                  onChange={(e) => setLine(i, { ingredientId: e.target.value || null, ingredientName: ingredients.find((x) => x.id === e.target.value)?.name ?? null, matchConfidence: e.target.value ? 'high' : 'none' })}
                >
                  <option value="">Not matched</option>
                  {ingredients.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={l.optional} onChange={(e) => setLine(i, { optional: e.target.checked })} />
                Optional
                {check && <span className="ml-auto font-semibold text-accent-text">{l.ingredientId ? 'Check this match' : 'Pick an ingredient to link it to your stock'}</span>}
              </label>
            </div>
          );
        })}
        <Field label="Add ingredients" hint="Paste or type one per line, e.g. “2 onions, chopped”.">
          {(id) => <textarea id={id} rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} className="w-full rounded-xl border border-line bg-card p-3 text-base" />}
        </Field>
        <Button className="self-start" disabled={!paste.trim()} onClick={() => void addLines(paste)}>
          Add lines
        </Button>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <Field label="Method" hint="One step per paragraph.">
          {(id) => (
            <textarea
              id={id}
              rows={8}
              value={draft.steps.join('\n\n')}
              onChange={(e) => set({ steps: e.target.value.split(/\n\s*\n/) })}
              className="w-full rounded-xl border border-line bg-card p-3 text-base"
            />
          )}
        </Field>
      </Card>

      <ErrorNote error={error} />
      <Button type="submit" variant="primary" size="lg" disabled={saving || !draft.title.trim()}>
        {saving ? 'Saving…' : 'Save recipe'}
      </Button>
    </form>
  );
}

export function RecipeNewPage() {
  return (
    <>
      <PageHeader title="New recipe" left={<BackButton to="/recipes" />} />
      <RecipeForm initial={emptyDraft()} />
    </>
  );
}

export function RecipeEditPage() {
  const { id = '' } = useParams();
  const recipe = useRecipe(id);
  if (recipe.isPending) return <Spinner />;
  if (!recipe.data) return <ErrorNote error={recipe.error ?? 'Not found'} />;
  return (
    <>
      <PageHeader title="Edit recipe" left={<BackButton to={`/recipes/${id}`} />} />
      <RecipeForm key={recipe.data.updatedAt} initial={draftFromRecipe(recipe.data)} recipeId={id} />
    </>
  );
}
