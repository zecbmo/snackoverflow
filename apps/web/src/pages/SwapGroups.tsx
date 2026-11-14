/**
 * Settings → Swap groups: foods that can stand in for each other in a recipe (broccoli and
 * tenderstem). A recipe short of one shows the others you have as close swaps (yellow); food of
 * the same category, like chicken and pork, shows as a looser swap (orange).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { SwapExclusionDto, SwapGroupDto, SwapGroupSuggestionDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { PageTop } from '../components/Toolbar';
import { Button, Card, EmptyState, ErrorNote, Field, Select, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useIngredients } from '../lib/queries';

export const useSwapExclusions = () => useQuery({ queryKey: ['ingredients', 'swap-exclusions'], queryFn: () => api.get<SwapExclusionDto[]>('/api/swap-exclusions') });

export const useSwapGroups = () => useQuery({ queryKey: ['ingredients', 'swap-groups'], queryFn: () => api.get<SwapGroupDto[]>('/api/swap-groups') });

export function SwapGroupsPage() {
  const me = useMe();
  const groups = useSwapGroups();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  // AI suggestions to review: nothing changes until they're added.
  const [suggestions, setSuggestions] = useState<SwapGroupSuggestionDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const suggest = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post<SwapGroupSuggestionDto[]>('/api/swap-groups/suggest', {});
      setSuggestions(out);
      if (!out.length) toast.show('No new groups to suggest.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const apply = async (chosen: SwapGroupSuggestionDto[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/swap-groups/save', { groups: chosen.map((g) => ({ id: g.groupId, name: g.name, ingredientIds: g.ingredients.map((i) => i.id) })) });
      setSuggestions((cur) => {
        const left = (cur ?? []).filter((g) => !chosen.includes(g));
        return left.length ? left : null;
      });
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
      await qc.invalidateQueries({ queryKey: ['recipes'] });
      toast.show(chosen.length === 1 ? `Added ${chosen[0]!.name}.` : `Added ${chosen.length} groups.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/swap-groups', { name: name.trim() });
      setName('');
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageTop
        title="Swap groups"
        subtitle={groups.data ? `${groups.data.length}` : undefined}
        left={<MenuButton />}
        actions={
          me.features.ai ? (
            suggestions?.length ? (
              <Button variant="primary" disabled={busy} onClick={() => void apply(suggestions)}>
                <Icon name="check" className="size-4" /> Add all {suggestions.length}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void suggest()}>
                {busy ? 'Thinking…' : 'Suggest groups with AI'}
              </Button>
            )
          ) : undefined
        }
      />
      <p className="mb-4 text-sm text-muted">
        Foods that can stand in for each other in a recipe, like broccoli and tenderstem broccoli. When a recipe is short of one and you have another, it shows a{' '}
        <span className="font-semibold text-swap-close-text">close swap</span>. Food of the same category (chicken and pork are both Meat) shows as a{' '}
        <span className="font-semibold text-swap-loose-text">loose swap</span>.
      </p>
      {!me.features.ai && me.features.mcp && (
        <p className="mb-4 text-sm text-muted">Or ask your assistant (for example Claude) to &ldquo;set up swap groups in Snack Overflow&rdquo;.</p>
      )}
      {suggestions && suggestions.length > 0 && (
        <section aria-label="Suggested groups" className="mb-5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted">Suggested: check them, then add the ones you want</h2>
            <Button size="sm" variant="ghost" onClick={() => setSuggestions(null)}>
              Clear
            </Button>
          </div>
          {suggestions.map((g) => (
            <Card key={`${g.groupId ?? 'new'}-${g.name}`} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {g.groupId ? `Add to ${g.name}` : g.name}
                  <span className="font-normal text-muted">: {g.ingredients.map((i) => i.name).join(', ')}</span>
                </p>
                {g.reason && <p className="text-sm text-muted">{g.reason}</p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void apply([g])}>
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSuggestions((cur) => (cur ?? []).filter((x) => x !== g))}>
                  Skip
                </Button>
              </div>
            </Card>
          ))}
        </section>
      )}
      <Card className="mb-5 p-4">
        <form onSubmit={(e) => void create(e)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="New group" hint='e.g. "Broccoli", "Chicken", "Hard cheese".'>
              {(id) => <TextInput id={id} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            <Icon name="plus" className="size-4" /> Add group
          </Button>
        </form>
        <ErrorNote error={error} />
      </Card>
      <ErrorNote error={groups.error} />
      {groups.isPending ? (
        <Spinner />
      ) : !groups.data?.length ? (
        <EmptyState title="No swap groups yet">Make one, then add the foods that can stand in for each other.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.data.map((g) => (
            <GroupCard key={g.id} group={g} others={groups.data} />
          ))}
        </div>
      )}
      <NotSwaps />
    </div>
  );
}

function GroupCard({ group, others }: { group: SwapGroupDto; others: SwapGroupDto[] }) {
  const ingredients = useIngredients().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState('');
  const memberIds = group.ingredients.map((i) => i.id);
  const groupOf = new Map(others.flatMap((o) => o.ingredients.map((i) => [i.id, o.name])));

  const setMembers = async (ids: string[]) => {
    try {
      await api.patch(`/api/swap-groups/${group.id}`, { ingredientIds: ids });
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
      await qc.invalidateQueries({ queryKey: ['recipes'] });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const remove = async () => {
    try {
      await api.del(`/api/swap-groups/${group.id}`);
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
      toast.show(`Removed ${group.name}.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-bold">{group.name}</h2>
        <Button size="sm" variant="ghost" aria-label={`Remove the ${group.name} group`} onClick={() => void remove()}>
          <Icon name="trash" className="size-4" />
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {group.ingredients.map((i) => (
          <li key={i.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-card-muted py-1 pl-3 pr-1 text-sm">
            {i.name}
            <button
              type="button"
              aria-label={`Take ${i.name} out of ${group.name}`}
              onClick={() => void setMembers(memberIds.filter((x) => x !== i.id))}
              className="inline-flex size-8 items-center justify-center rounded-full hover:bg-card lg:size-6"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          </li>
        ))}
        {!group.ingredients.length && <li className="text-sm text-muted">No foods yet.</li>}
      </ul>
      <Select
        aria-label={`Add a food to ${group.name}`}
        value={adding}
        onChange={(e) => {
          setAdding('');
          if (e.target.value) void setMembers([...memberIds, e.target.value]);
        }}
      >
        <option value="">Add a food…</option>
        {ingredients
          .filter((i) => !memberIds.includes(i.id))
          .map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {groupOf.has(i.id) ? ` (in ${groupOf.get(i.id)})` : ''}
            </option>
          ))}
      </Select>
    </Card>
  );
}

/** Pairs taken away on a recipe ("not a good swap"), so they can be brought back. */
function NotSwaps() {
  const pairs = useSwapExclusions().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  if (!pairs.length) return null;
  const bringBack = async (p: SwapExclusionDto) => {
    try {
      await api.del(`/api/swap-exclusions/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
      await qc.invalidateQueries({ queryKey: ['recipes'] });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  return (
    <section className="mt-6" aria-labelledby="not-swaps">
      <h2 id="not-swaps" className="mb-1 font-bold">
        Not swaps
      </h2>
      <p className="mb-2 text-sm text-muted">Never offered for each other, from ✕ on a recipe&apos;s swaps.</p>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-card">
        {pairs.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-1.5">
            <span className="flex-1 text-sm">
              {p.ingredients[0].name} and {p.ingredients[1].name.toLowerCase()}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void bringBack(p)}>
              Bring back
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
