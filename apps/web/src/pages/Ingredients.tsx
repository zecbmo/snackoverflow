import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FOOD_GROUPS, type IngredientDto, type IngredientInput, type ShelfLife } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { type Column, DataTable } from '../components/DataTable';
import { PickerMenu } from '../components/Menu';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { PageTop, SearchBox, Toolbar } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Field, Select, Sheet, Spinner, TextInput, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { useIngredients, useShelfLife } from '../lib/queries';
import { groupRows, matchesSearch } from '../lib/table';

function shelfSummary(s: ShelfLife): string {
  const parts: string[] = [];
  if (s.closedDays !== null) parts.push(`${s.closedDays} days`);
  if (s.openedDays !== null) parts.push(`${s.openedDays} opened`);
  if (s.frozenDays !== null && s.freezable !== false) parts.push(`freezes ${s.frozenDays}`);
  return parts.length ? parts.join(' · ') : 'No shelf life set';
}

export function IngredientsPage() {
  const ingredients = useIngredients();
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'none' | 'aisle' | 'category'>('none');
  const [adding, setAdding] = useState(false);
  const [openId, openPanel, closePanel] = usePanelParam();
  const list = (ingredients.data ?? []).filter((i) => !q.trim() || matchesSearch(`${i.name} ${i.aisle ?? ''}`, q));
  const editing = (ingredients.data ?? []).find((i) => i.id === openId) ?? null;
  const days = (n: number | null) => (n === null ? '' : `${n} d`);
  const columns: Column<IngredientDto>[] = [
    { key: 'name', header: 'Name', primary: true, cell: (i) => i.name },
    { key: 'category', header: 'Category', cell: (i) => i.foodGroup ?? '' },
    { key: 'aisle', header: 'Aisle', cell: (i) => i.aisle ?? '' },
    { key: 'closed', header: 'Keeps', align: 'right', className: 'tabular-nums', cell: (i) => days(i.shelfLife.closedDays) },
    { key: 'opened', header: 'Once opened', align: 'right', className: 'tabular-nums', cell: (i) => days(i.shelfLife.openedDays) },
    { key: 'frozen', header: 'Frozen', align: 'right', className: 'tabular-nums', cell: (i) => (i.shelfLife.freezable === false ? 'No' : days(i.shelfLife.frozenDays)) },
  ];
  const groups =
    group === 'aisle'
      ? groupRows(list, (i) => i.aisle ?? 'Other').map((g) => ({ key: g.key, label: g.key, rows: g.rows }))
      : group === 'category'
        ? groupRows(list, (i) => i.foodGroup ?? 'Other', [...FOOD_GROUPS, 'Other']).map((g) => ({ key: g.key, label: g.key, rows: g.rows }))
        : undefined;

  return (
    <>
      <PageTop
        title="Ingredients"
        subtitle={ingredients.data ? `${ingredients.data.length}` : undefined}
        left={<MenuButton />}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" className="size-4" /> Add ingredient
          </Button>
        }
      />
      <Toolbar search={<SearchBox value={q} onChange={setQ} placeholder="Search ingredients" label="Search ingredients" />}>
        <PickerMenu
          label="Group"
          icon="group"
          value={group}
          defaultValue="none"
          onChange={setGroup}
          options={[
            { value: 'none', label: 'No grouping' },
            { value: 'category', label: 'Category' },
            { value: 'aisle', label: 'Aisle' },
          ]}
        />
      </Toolbar>
      <ErrorNote error={ingredients.error} />
      {ingredients.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Ingredients"
          columns={columns}
          rows={groups ? undefined : list}
          groups={groups}
          rowKey={(i) => i.id}
          onOpen={(i) => openPanel(i.id)}
          openLabel={(i) => `Edit ${i.name}`}
          activeKey={openId}
          phone={(i) => ({ title: i.name, meta: [i.aisle, shelfSummary(i.shelfLife)].filter(Boolean).join(' · '), badge: <Icon name="chevronRight" className="size-4 text-muted" /> })}
          empty={<EmptyState title="No ingredients found" />}
        />
      )}
      <SidePanel open={Boolean(openId)} onClose={closePanel} title={editing?.name ?? 'Ingredient'} subtitle="Used to match recipes, receipts and products">
        {editing && <IngredientEditor key={editing.id} ingredient={editing} onDone={closePanel} />}
      </SidePanel>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add ingredient">
        {adding && <IngredientEditor key="new" ingredient={null} onDone={() => setAdding(false)} />}
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
  const [foodGroup, setFoodGroup] = useState(ingredient?.foodGroup ?? '');
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
      foodGroup: (foodGroup || null) as IngredientInput['foodGroup'],
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
      <Field label="Category">
        {(id) => (
          <Select id={id} value={foodGroup} onChange={(e) => setFoodGroup(e.target.value)}>
            <option value="">Not set</option>
            {FOOD_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Aisle" hint="Where it is in the shop, e.g. Veg, Dairy, Tins and jars.">
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
