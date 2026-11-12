import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { IngredientDto, IngredientInput, ShelfLife } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, EmptyState, ErrorNote, Field, PageHeader, Select, Sheet, Spinner, TextInput, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { useIngredients, useShelfLife } from '../lib/queries';

function shelfSummary(s: ShelfLife): string {
  const parts: string[] = [];
  if (s.closedDays !== null) parts.push(`${s.closedDays} days`);
  if (s.openedDays !== null) parts.push(`${s.openedDays} opened`);
  if (s.frozenDays !== null && s.freezable !== false) parts.push(`freezes ${s.frozenDays}`);
  return parts.length ? parts.join(' · ') : 'No shelf life set';
}

type Editing = IngredientDto | 'new' | null;

export function IngredientsPage() {
  const ingredients = useIngredients();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const list = (ingredients.data ?? []).filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHeader
        title="Ingredients"
        left={<MenuButton />}
        right={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Icon name="plus" className="size-5" /> Add
          </Button>
        }
      />
      <label className="relative mb-4 block">
        <span className="sr-only">Search ingredients</span>
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
        <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ingredients" className="pl-10" />
      </label>
      {ingredients.isPending ? (
        <Spinner />
      ) : ingredients.error ? (
        <ErrorNote error={ingredients.error} />
      ) : list.length === 0 ? (
        <EmptyState title="No ingredients found" />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {list.map((i) => (
            <button key={i.id} type="button" onClick={() => setEditing(i)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-card-muted">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{i.name}</span>
                <span className="block truncate text-sm text-muted">
                  {[i.aisle, shelfSummary(i.shelfLife)].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Icon name="chevronRight" className="size-5 text-muted" />
            </button>
          ))}
        </Card>
      )}
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add ingredient' : 'Edit ingredient'}>
        {editing !== null && <IngredientEditor key={editing === 'new' ? 'new' : editing.id} ingredient={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Sheet>
    </>
  );
}

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

function IngredientEditor({ ingredient, onDone }: { ingredient: IngredientDto | null; onDone: () => void }) {
  const categories = useShelfLife().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(ingredient?.name ?? '');
  const [aisle, setAisle] = useState(ingredient?.aisle ?? '');
  const [categoryId, setCategoryId] = useState(ingredient?.shelfLifeCategoryId ?? '');
  const [density, setDensity] = useState(str(ingredient?.densityGPerMl));
  const [perItem, setPerItem] = useState(str(ingredient?.gramsPerCount));
  const [countUnit, setCountUnit] = useState(ingredient?.countUnit ?? '');
  const [runningLow, setRunningLow] = useState(ingredient?.trackRunningLow ?? false);
  // Blank means "use the category's value".
  const category = categories.find((c) => c.id === categoryId);
  const o = ingredient?.overrides;
  const [days, setDays] = useState({
    closedDays: str(o?.closedDays),
    openedDays: str(o?.openedDays),
    frozenDays: str(o?.frozenDays),
    defrostedDays: str(o?.defrostedDays),
  });
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const input: IngredientInput = {
      name,
      aisle: aisle.trim() || null,
      shelfLifeCategoryId: categoryId || null,
      densityGPerMl: numOrNull(density),
      gramsPerCount: numOrNull(perItem),
      countUnit: countUnit.trim() || null,
      trackRunningLow: runningLow,
    };
    const overrides = Object.fromEntries(Object.entries(days).map(([k, v]) => [k, numOrNull(v)]));
    input.shelfLife = overrides;
    try {
      if (ingredient) await api.patch(`/api/ingredients/${ingredient.id}`, input);
      else await api.post('/api/ingredients', input);
      await Promise.all([qc.invalidateQueries({ queryKey: ['ingredients'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
      toast.show(ingredient ? 'Saved.' : `Added ${name}.`);
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  const dayFields = [
    ['closedDays', 'Closed'],
    ['openedDays', 'Opened'],
    ['frozenDays', 'Frozen'],
    ['defrostedDays', 'Defrosted'],
  ] as const;

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Name">{(id) => <TextInput id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Aisle" hint="Groups the shopping list, e.g. Veg, Dairy, Tins and jars.">
        {(id) => <TextInput id={id} value={aisle} onChange={(e) => setAisle(e.target.value)} />}
      </Field>
      <Field label="Shelf-life category">
        {(id) => (
          <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Days it keeps</legend>
        <p className="text-sm text-muted">
          {ingredient ? `Now: ${shelfSummary(ingredient.shelfLife)}. ` : ''}Leave blank to use the category{category ? ` (${category.name})` : ''}.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {dayFields.map(([key, label]) => (
            <Field key={key} label={label}>
              {(id) => (
                <TextInput
                  id={id}
                  inputMode="numeric"
                  value={days[key]}
                  placeholder={str(category?.[key])}
                  onChange={(e) => setDays((d) => ({ ...d, [key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Density (g per ml)" hint="For liquids and powders.">
          {(id) => <TextInput id={id} inputMode="decimal" value={density} onChange={(e) => setDensity(e.target.value)} />}
        </Field>
        <Field label="Grams per item">{(id) => <TextInput id={id} inputMode="decimal" value={perItem} onChange={(e) => setPerItem(e.target.value)} />}</Field>
      </div>
      <Field label="Item name" hint='e.g. "onion", "tin", "slice".'>
        {(id) => <TextInput id={id} value={countUnit} onChange={(e) => setCountUnit(e.target.value)} />}
      </Field>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span className="font-medium">Track running low</span>
        <Toggle checked={runningLow} onChange={setRunningLow} label="Track running low" />
      </div>
      <ErrorNote error={error} />
      <Button type="submit" variant="primary" size="lg">
        {ingredient ? 'Save' : 'Add ingredient'}
      </Button>
    </form>
  );
}
