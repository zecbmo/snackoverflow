/**
 * Settings → Unmatched ingredients: recipe lines the app can't check against stock or put on the
 * shopping list, grouped by food. Fix them by hand, from AI suggestions (reviewed, then applied),
 * or by asking your own assistant over MCP.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import {
  FOOD_GROUPS,
  type IngredientInput,
  parseIngredientLine,
  type UnmatchedFix,
  type UnmatchedGroupDto,
  type UnmatchedSuggestionDto,
} from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { type Column, DataTable } from '../components/DataTable';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { PageTop, Segmented, Toolbar } from '../components/Toolbar';
import { Button, Card, EmptyState, ErrorNote, Field, Select, Spinner, TextInput, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { useIngredients, useShelfLife, useUnmatched } from '../lib/queries';

const PROBLEM: Record<UnmatchedGroupDto['problem'], string> = {
  unlinked: 'Not linked',
  noWeight: 'No weight per item',
  unknownUnit: 'Unknown unit',
  noNutrition: 'No nutrition',
};

const recipeCount = (g: UnmatchedGroupDto) => {
  const n = new Set(g.lines.map((l) => l.recipeId)).size;
  return `${n} recipe${n === 1 ? '' : 's'}`;
};

/** "sachet" for "1 sachet curry powder", so a weight can be asked for per sachet. */
const countWord = (g: UnmatchedGroupDto): string | null => {
  for (const l of g.lines) {
    const p = parseIngredientLine(l.text);
    if (p.unit === 'count') return p.countWord ?? 'item';
  }
  return null;
};

function suggestionText(s: UnmatchedSuggestionDto): string {
  if (s.action === 'ignore') return 'Leave unmatched';
  const each = s.gramsPerCount ?? s.newIngredient?.gramsPerCount;
  const kcal = (s.nutritionPer100g ?? s.newIngredient?.nutritionPer100g)?.kcal;
  const weight = `${each ? ` · ${each}g each` : ''}${kcal != null ? ` · ${kcal} kcal per 100g` : ''}`;
  if (s.action === 'create') return `New: ${s.newIngredient!.name}${s.newIngredient!.foodGroup ? ` (${s.newIngredient!.foodGroup})` : ''}${weight}`;
  return `${s.ingredientName}${weight}`;
}

/** Turn a reviewed suggestion into a fix for the server; null for "leave unmatched". */
function fixFor(g: UnmatchedGroupDto, s: UnmatchedSuggestionDto): UnmatchedFix | null {
  if (s.action === 'ignore') return null;
  return {
    lineIds: g.lines.map((l) => l.id),
    ingredientId: s.action === 'link' ? s.ingredientId : null,
    newIngredient: s.action === 'create' ? s.newIngredient : null,
    gramsPerCount: s.gramsPerCount,
    nutritionPer100g: s.nutritionPer100g,
  };
}

export function UnmatchedPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const unmatched = useUnmatched();
  const [view, setView] = useState<'todo' | 'ignored'>('todo');
  const [suggestions, setSuggestions] = useState<Map<string, UnmatchedSuggestionDto>>(new Map());
  const [busy, setBusy] = useState<'suggest' | 'apply' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [openKey, openPanel, closePanel] = usePanelParam();
  const all = unmatched.data ?? [];
  const todo = all.filter((g) => !g.ignored);
  const ignored = all.filter((g) => g.ignored);
  const list = view === 'todo' ? todo : ignored;
  const open = all.find((g) => g.key === openKey) ?? null;
  const pending = todo.filter((g) => suggestions.has(g.key));

  const refresh = () =>
    Promise.all(['recipes', 'ingredients', 'shopping', 'plan', 'stock'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const suggest = async () => {
    setBusy('suggest');
    setError(null);
    try {
      const out = await api.post<UnmatchedSuggestionDto[]>('/api/unmatched/suggest', {});
      setSuggestions(new Map(out.map((s) => [s.key, s])));
      toast.show(out.length ? `${out.length} suggestion${out.length === 1 ? '' : 's'} to check.` : 'No suggestions this time.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  /** Apply the suggestions for these groups (all of them when none given). */
  const apply = async (groups: UnmatchedGroupDto[]) => {
    setBusy('apply');
    setError(null);
    try {
      const chosen = groups.map((g) => ({ g, s: suggestions.get(g.key)! })).filter((x) => x.s);
      const fixes = chosen.map(({ g, s }) => fixFor(g, s)).filter((f): f is UnmatchedFix => f !== null);
      const ignore = chosen.filter((x) => x.s.action === 'ignore').map((x) => x.g.key);
      if (fixes.length) await api.post('/api/unmatched/fix', { fixes });
      if (ignore.length) await api.post('/api/unmatched/ignore', { keys: ignore, ignored: true });
      setSuggestions((m) => {
        const next = new Map(m);
        for (const { g } of chosen) next.delete(g.key);
        return next;
      });
      await refresh();
      toast.show(chosen.length === 1 ? 'Fixed.' : `Fixed ${chosen.length}.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<UnmatchedGroupDto>[] = [
    { key: 'name', header: 'Food', primary: true, cell: (g) => g.name },
    { key: 'problem', header: 'Problem', cell: (g) => PROBLEM[g.problem] },
    { key: 'used', header: 'Used in', cell: recipeCount },
    { key: 'example', header: 'For example', className: 'max-w-[18rem] truncate', cell: (g) => g.lines[0]?.text ?? '' },
    ...(suggestions.size
      ? [{ key: 'suggestion', header: 'Suggestion', cell: (g: UnmatchedGroupDto) => (suggestions.has(g.key) ? suggestionText(suggestions.get(g.key)!) : '') }]
      : []),
  ];

  const rowAction = (g: UnmatchedGroupDto) =>
    g.ignored ? (
      <Button size="xs" onClick={() => void setIgnored(g, false)}>
        Bring back
      </Button>
    ) : suggestions.has(g.key) ? (
      <Button size="xs" disabled={busy !== null} onClick={() => void apply([g])}>
        Apply
      </Button>
    ) : null;

  const setIgnored = async (g: UnmatchedGroupDto, on: boolean) => {
    setError(null);
    try {
      await api.post('/api/unmatched/ignore', { keys: [g.key], ignored: on });
      await qc.invalidateQueries({ queryKey: ['recipes'] });
      toast.show(on ? `Leaving ${g.name} unmatched.` : `${g.name} is back on the list.`);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <PageTop
        title="Unmatched ingredients"
        subtitle={unmatched.data ? `${todo.length}` : undefined}
        left={<MenuButton />}
        actions={
          view === 'todo' && todo.length > 0 && me.features.ai ? (
            pending.length > 0 ? (
              <Button variant="primary" disabled={busy !== null} onClick={() => void apply(pending)}>
                <Icon name="check" className="size-4" /> Apply {pending.length} suggestion{pending.length === 1 ? '' : 's'}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy !== null} onClick={() => void suggest()}>
                {busy === 'suggest' ? 'Asking…' : 'Suggest fixes with AI'}
              </Button>
            )
          ) : undefined
        }
      />
      <p className="mb-3 max-w-3xl text-sm text-muted">
        Recipe lines that aren't linked to your stock. Until they're fixed, recipes can't tell whether you have them, and they won't go on the shopping list.
        {me.features.mcp && ' You can also ask your assistant (for example Claude, connected over MCP) to "fix my unmatched ingredients in Snack Overflow".'}
        {!me.features.ai && !me.features.mcp && ' Set AI_API_KEY or MCP_TOKEN on the server to have these suggested for you.'}
      </p>
      <Toolbar>
        <Segmented
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'todo', label: `To fix${todo.length ? ` (${todo.length})` : ''}` },
            { value: 'ignored', label: `Left unmatched${ignored.length ? ` (${ignored.length})` : ''}` },
          ]}
        />
        {pending.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSuggestions(new Map())}>
            Clear suggestions
          </Button>
        )}
      </Toolbar>
      <ErrorNote error={error ?? unmatched.error} />
      {unmatched.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Unmatched ingredients"
          columns={columns}
          rows={list}
          rowKey={(g) => g.key}
          onOpen={(g) => openPanel(g.key)}
          openLabel={(g) => `Fix ${g.name}`}
          activeKey={openKey}
          actions={rowAction}
          phone={(g) => ({
            title: g.name,
            meta: [PROBLEM[g.problem], recipeCount(g), suggestions.has(g.key) ? suggestionText(suggestions.get(g.key)!) : null].filter(Boolean).join(' · '),
            trailing: rowAction(g),
          })}
          empty={
            <EmptyState title={view === 'todo' ? 'Everything is matched' : 'Nothing left unmatched'}>
              {view === 'todo' ? 'Every recipe line is linked to your stock.' : 'Things you choose to leave unmatched (like water) show here.'}
            </EmptyState>
          }
        />
      )}
      <SidePanel open={Boolean(open)} onClose={closePanel} title={open?.name ?? 'Unmatched'} subtitle={open ? `${PROBLEM[open.problem]} · ${recipeCount(open)}` : undefined}>
        {open && (
          <GroupFixer
            key={open.key}
            group={open}
            suggestion={suggestions.get(open.key) ?? null}
            onApplySuggestion={() => void apply([open]).then(closePanel)}
            onIgnore={(on) => void setIgnored(open, on).then(closePanel)}
            onDone={async (msg) => {
              setSuggestions((m) => {
                const next = new Map(m);
                next.delete(open.key);
                return next;
              });
              await refresh();
              toast.show(msg);
              closePanel();
            }}
          />
        )}
      </SidePanel>
    </>
  );
}

type NutrientKey = 'kcal' | 'protein' | 'carbs' | 'sugars' | 'fat' | 'saturates' | 'fibre' | 'salt';
const NUTRIENTS: [NutrientKey, string][] = [
  ['kcal', 'Calories (kcal)'],
  ['protein', 'Protein (g)'],
  ['carbs', 'Carbs (g)'],
  ['sugars', 'of which sugars (g)'],
  ['fat', 'Fat (g)'],
  ['saturates', 'of which saturates (g)'],
  ['fibre', 'Fibre (g)'],
  ['salt', 'Salt (g)'],
];

const numOrNull = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) || Number(s) <= 0 ? null : Number(s));

function GroupFixer({
  group,
  suggestion,
  onApplySuggestion,
  onIgnore,
  onDone,
}: {
  group: UnmatchedGroupDto;
  suggestion: UnmatchedSuggestionDto | null;
  onApplySuggestion: () => void;
  onIgnore: (on: boolean) => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const ingredients = useIngredients().data ?? [];
  const categories = useShelfLife().data ?? [];
  const word = countWord(group);
  const fromSuggestion = suggestion?.action === 'create' ? suggestion.newIngredient : null;
  const [mode, setMode] = useState<'existing' | 'new'>(suggestion?.action === 'create' ? 'new' : 'existing');
  const [ingredientId, setIngredientId] = useState(suggestion?.action === 'link' ? (suggestion.ingredientId ?? '') : (group.ingredientId ?? ''));
  const [name, setName] = useState(fromSuggestion?.name ?? group.name);
  const [foodGroup, setFoodGroup] = useState<string>(fromSuggestion?.foodGroup ?? '');
  const [categoryId, setCategoryId] = useState(fromSuggestion?.shelfLifeCategoryId ?? '');
  const [perItem, setPerItem] = useState(String(suggestion?.gramsPerCount ?? fromSuggestion?.gramsPerCount ?? ''));
  const [runningLow, setRunningLow] = useState(fromSuggestion?.trackRunningLow ?? false);
  const [nutrition, setNutrition] = useState<Record<NutrientKey, string>>(() =>
    Object.fromEntries(NUTRIENTS.map(([k]) => [k, suggestion?.nutritionPer100g?.[k] != null ? String(suggestion.nutritionPer100g[k]) : ''])) as Record<NutrientKey, string>,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = ingredients.find((i) => i.id === ingredientId);
  // Counted lines need a weight per item unless the chosen ingredient already has one.
  const needsWeight = word !== null && group.problem !== 'noNutrition' && (mode === 'new' || !chosen?.gramsPerCount);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const newIngredient: IngredientInput | null =
        mode === 'new' && group.problem === 'unlinked'
          ? {
              name,
              foodGroup: (foodGroup || null) as IngredientInput['foodGroup'],
              shelfLifeCategoryId: categoryId || null,
              gramsPerCount: needsWeight ? numOrNull(perItem) : null,
              countUnit: word && word !== 'item' ? word : null,
              trackRunningLow: runningLow,
              aisle: fromSuggestion?.aisle ?? null,
            }
          : null;
      const per100g =
        group.problem === 'noNutrition' ? Object.fromEntries(NUTRIENTS.map(([k]) => [k, nutrition[k].trim() === '' ? null : Number(nutrition[k])])) : null;
      const fix: UnmatchedFix = {
        lineIds: group.lines.map((l) => l.id),
        ingredientId: newIngredient ? null : ingredientId,
        newIngredient,
        gramsPerCount: !newIngredient && needsWeight ? numOrNull(perItem) : null,
        nutritionPer100g: per100g,
      };
      await api.post('/api/unmatched/fix', { fixes: [fix] });
      await onDone(group.problem === 'unlinked' ? `Linked ${group.lines.length} line${group.lines.length === 1 ? '' : 's'}.` : 'Saved.');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-1.5 text-sm font-semibold">In your recipes</h3>
        <ul className="flex flex-col gap-1.5 text-sm">
          {group.lines.map((l) => (
            <li key={l.id}>
              <span className="block">{l.text}</span>
              <Link to={`/recipes/${l.recipeId}`} className="text-accent-text underline-offset-2 hover:underline">
                {l.recipeTitle}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {suggestion && !group.ignored && (
        <Card className="flex flex-col gap-2 p-3">
          <p className="text-sm">
            <span className="font-semibold">Suggested:</span> {suggestionText(suggestion)}
            {suggestion.reason && <span className="block text-muted">{suggestion.reason}</span>}
          </p>
          <Button variant="primary" className="self-start" onClick={onApplySuggestion}>
            Apply suggestion
          </Button>
        </Card>
      )}

      {group.problem === 'unknownUnit' ? (
        <p className="text-sm">
          The unit on these lines isn't one the app can weigh. Edit the recipe to use grams, millilitres, spoons or a count (like "2 steaks").
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          {group.problem === 'unlinked' && (
            <Segmented
              label="Link to"
              stretch
              value={mode}
              onChange={setMode}
              options={[
                { value: 'existing', label: 'An ingredient you have' },
                { value: 'new', label: 'A new ingredient' },
              ]}
            />
          )}
          {group.problem === 'unlinked' && mode === 'existing' && (
            <Field label="Ingredient">
              {(id) => (
                <Select id={id} required value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}>
                  <option value="">Choose…</option>
                  {ingredients.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {mode === 'new' && group.problem === 'unlinked' && (
            <>
              <Field label="Name" hint='Keep it generic, e.g. "Rump steak", so other recipes and products can use it.'>
                {(id) => <TextInput id={id} required value={name} onChange={(e) => setName(e.target.value)} />}
              </Field>
              <div className="grid grid-cols-2 gap-3">
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
                <Field label="Shelf life">
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
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <span className="text-sm font-medium">Track running low (for spices and other staples)</span>
                <Toggle checked={runningLow} onChange={setRunningLow} label="Track running low" />
              </div>
            </>
          )}
          {group.problem === 'noNutrition' && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Per 100g</legend>
              <p className="text-sm text-muted">From a pack label, or typical values. Recipes use these for calories when no product you&apos;ve bought says.</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {NUTRIENTS.map(([k, label]) => (
                  <Field key={k} label={label}>
                    {(id) => (
                      <TextInput
                        id={id}
                        inputMode="decimal"
                        required={k === 'kcal'}
                        value={nutrition[k]}
                        onChange={(e) => setNutrition((n) => ({ ...n, [k]: e.target.value }))}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </fieldset>
          )}
          {needsWeight && (
            <Field label={`Grams per ${word}`} hint={`The recipes count it, so the app needs to know what one ${word} weighs.`}>
              {(id) => <TextInput id={id} inputMode="decimal" required value={perItem} onChange={(e) => setPerItem(e.target.value)} />}
            </Field>
          )}
          <ErrorNote error={error} />
          <Button type="submit" variant="primary" disabled={saving}>
            {group.problem === 'unlinked' ? `Link ${group.lines.length} line${group.lines.length === 1 ? '' : 's'}` : 'Save'}
          </Button>
        </form>
      )}

      <div className="border-t border-line pt-4">
        {group.ignored ? (
          <Button onClick={() => onIgnore(false)}>Bring back to the list</Button>
        ) : (
          <>
            <Button onClick={() => onIgnore(true)}>Leave unmatched</Button>
            <p className="mt-1.5 text-sm text-muted">For things you never buy, like water.</p>
          </>
        )}
      </div>
    </div>
  );
}
