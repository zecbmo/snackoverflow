/**
 * The planner: each person's week as meal slots with calories. Plan recipes,
 * leftovers, products or a note; log what was eaten; build the shopping list.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { addDays, type CalendarDate, MEAL_SLOTS, type MealSlot, type PlanEntryDto, type UserDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { PickerMenu } from '../components/Menu';
import { PageTop, Segmented, Toolbar } from '../components/Toolbar';
import { Button, Card, ErrorNote, Field, IconButton, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { useIsDesktop } from '../lib/useMedia';
import { api, errorMessage } from '../lib/api';
import { amountLabel } from '../lib/format';
import { useIngredients, usePlan, useProducts, useRecipes, useStock, useSurplus, useUsers } from '../lib/queries';
import { PlanWeekSheet, SuggestSheet } from '../components/OptimiserSheets';
import { CalendarPane, type CalendarDrag, DRAG_TYPE, readDrag, startDrag } from '../components/CalendarPane';
import { amountText } from '@snackoverflow/shared';

const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

/** Monday of the week containing `d`. */
function weekStart(d: CalendarDate): CalendarDate {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return addDays(d, -((dow + 6) % 7));
}

function dayLabel(d: CalendarDate, today: CalendarDate, long = false): string {
  const date = new Date(`${d}T12:00:00Z`);
  const name = date.toLocaleDateString('en-GB', {
    weekday: long ? 'long' : 'short',
    timeZone: 'UTC',
  });
  const num = date.getUTCDate();
  if (d === today) return `Today · ${name.slice(0, 3)} ${num}`;
  if (d === addDays(today, 1)) return `Tomorrow · ${name.slice(0, 3)} ${num}`;
  return `${name} ${num}`;
}

function rangeLabel(from: CalendarDate, to: CalendarDate): string {
  const f = new Date(`${from}T12:00:00Z`);
  const t = new Date(`${to}T12:00:00Z`);
  const month = (x: Date) => x.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  return f.getUTCMonth() === t.getUTCMonth() ? `${f.getUTCDate()} – ${t.getUTCDate()} ${month(t)}` : `${f.getUTCDate()} ${month(f)} – ${t.getUTCDate()} ${month(t)}`;
}

export function PlannerPage() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(() => weekStart(params.get('date') ?? me.today));
  const to = addDays(from, 6);
  const [person, setPerson] = useState('me');
  const plan = usePlan(from, to, person);
  const members = useUsers().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // "+ Add" on Today's week strip opens the add sheet for that dinner straight away.
  const [adding, setAdding] = useState<{
    date: CalendarDate;
    slot: MealSlot;
  } | null>(() => {
    const date = params.get('date');
    const slot = params.get('add');
    return date && slot && (MEAL_SLOTS as readonly string[]).includes(slot) ? { date, slot: slot as MealSlot } : null;
  });
  const [open, setOpen] = useState<PlanEntryDto | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [suggesting, setSuggesting] = useState<{
    ingredient: { id: string; name: string } | null;
  } | null>(null);
  const [planningWeek, setPlanningWeek] = useState(false);
  const surplus = useSurplus().data ?? [];
  const desktop = useIsDesktop();
  const ingredients = useIngredients().data ?? [];
  const hint = surplus.find((h) => h.ideas > 0) ?? surplus[0];

  // Opened from a "Move" notification: show that meal.
  const entryParam = params.get('entry');
  useEffect(() => {
    if (!entryParam) return;
    void api.get<PlanEntryDto>(`/api/plan/${entryParam}`).then(setOpen, () => {});
    setParams((p) => {
      p.delete('entry');
      return p;
    });
  }, [entryParam, setParams]);

  const build = async () => {
    try {
      const start = from < me.today ? me.today : from;
      const r = await api.post<{
        added: number;
        updated: number;
        covered: number;
      }>('/api/shopping/build', { from: start, to });
      await qc.invalidateQueries({ queryKey: ['shopping'] });
      toast.show(r.added + r.updated ? `Added ${r.added + r.updated} thing${r.added + r.updated === 1 ? '' : 's'} to the list.` : 'Nothing to buy: stock covers this plan.');
      if (r.added + r.updated) navigate('/shop');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const [dropAt, setDropAt] = useState<string | null>(null);
  const [dragging, setDragging] = useState<PlanEntryDto | null>(null);
  /** A meal's calories: everything in it that wasn't skipped. */
  const mealKcal = (entries: PlanEntryDto[]) => entries.filter((e) => e.status !== 'skipped').reduce((n, e) => n + (e.kcal ?? 0), 0);
  /** Dropped back on the pane: take it off the calendar (its food comes off the planned list too), with Undo. */
  const remove = async (id: string) => {
    const entry = plan.data?.days.flatMap((x) => x.entries).find((x) => x.id === id);
    setDragging(null);
    if (!entry) return;
    const refresh = async () => {
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    };
    try {
      await api.del(`/api/plan/${entry.id}`);
      await refresh();
      toast.show(`Took ${entry.title} off the calendar.`, {
        action: {
          label: 'Undo',
          onClick: async () =>
            void (await api.post('/api/plan', {
              date: entry.date,
              slot: entry.slot,
              kind: entry.kind,
              servings: entry.servings,
              people: entry.people.map((p) => ({ userId: p.userId, portions: p.portions })),
              eaten: entry.status === 'cooked',
              ...(entry.kind === 'recipe'
                ? { recipeId: entry.recipeId }
                : entry.kind === 'product'
                  ? { productId: entry.productId }
                  : entry.kind === 'stock'
                    ? { stockItemId: entry.stockItemId }
                    : { text: entry.title, kcalPerServing: entry.kcalPerServing }),
            }),
            await refresh()),
        },
      });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  /** Something dropped on a day and meal: plan it, or move the planned meal there. Both can be undone. */
  const drop = async (date: CalendarDate, slot: MealSlot, d: CalendarDrag) => {
    const where = `${SLOT_LABEL[slot].toLowerCase()} on ${dayLabel(date, me.today, true)}`;
    const refresh = async () => {
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    };
    try {
      if (d.type === 'move') {
        const entry = plan.data?.days.flatMap((x) => x.entries).find((x) => x.id === d.entryId);
        if (!entry || (entry.date === date && entry.slot === slot)) return;
        await api.patch(`/api/plan/${entry.id}`, { date, slot });
        await refresh();
        toast.show(`Moved ${d.title} to ${where}.`, {
          action: { label: 'Undo', onClick: async () => void (await api.patch(`/api/plan/${entry.id}`, { date: entry.date, slot: entry.slot }), await refresh()) },
        });
      } else {
        const created = await api.post<PlanEntryDto>('/api/plan', {
          date,
          slot,
          kind: d.kind,
          servings: d.kind === 'recipe' ? Math.max(1, members.length) : 1,
          ...(d.kind === 'recipe' ? { recipeId: d.id } : d.kind === 'product' ? { productId: d.id } : { stockItemId: d.id }),
        });
        await refresh();
        toast.show(`Planned ${d.title} for ${where}.`, {
          action: { label: 'Undo', onClick: async () => void (await api.del(`/api/plan/${created.id}`), await refresh()) },
        });
      }
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const people = [{ value: 'me', label: 'You' }, ...(isAdmin ? members.filter((m) => m.id !== me.user.id).map((m) => ({ value: m.id, label: m.name })) : []), { value: 'everyone', label: 'Everyone' }];
  const thisWeek = weekStart(me.today);
  const addLabel = (date: CalendarDate, slot: MealSlot) => `Add to ${slot} on ${dayLabel(date, me.today, true)}`;
  const entryButton = (e: PlanEntryDto, compact: boolean) => (
    <button
      type="button"
      onClick={() => setOpen(e)}
      className={
        compact
          ? `flex w-full items-start gap-1.5 rounded-md border border-line bg-card px-1.5 py-1 text-left text-[0.8125rem] leading-snug hover:border-accent/50 hover:bg-accent-soft/40 ${e.status === 'skipped' ? 'opacity-60' : ''}`
          : 'flex min-h-11 w-full items-center gap-3 text-left'
      }
    >
      <span aria-hidden className={`mt-1 size-2 shrink-0 rounded-full ${e.status === 'cooked' ? 'bg-fresh-green' : e.status === 'skipped' ? 'bg-transparent' : 'border border-muted'} ${compact ? '' : 'mt-0'}`} />
      <span className={`min-w-0 flex-1 ${compact ? 'line-clamp-2' : 'text-[1.0625rem]'} ${e.status === 'skipped' ? 'text-muted line-through' : ''}`}>{e.title}</span>
      {compact ? (
        <span className="shrink-0 text-right text-[0.6875rem] leading-tight text-muted tabular-nums">
          {shortAmount(e) && <span className="block font-medium text-ink/70">{shortAmount(e)}</span>}
          {e.kcal !== null && <span className="block">{e.kcal}</span>}
        </span>
      ) : (
        <span className="whitespace-nowrap text-[0.9375rem] text-muted">{[shortAmount(e), e.detail, e.kcal !== null ? `${e.kcal} kcal` : null].filter((x) => x !== null && x !== '').join(' · ')}</span>
      )}
      <span className="sr-only">{e.status === 'cooked' ? '(done)' : e.status === 'skipped' ? '(skipped)' : '(planned)'}</span>
    </button>
  );
  const scanLink = (date: CalendarDate, slot: MealSlot, cls: string) =>
    date === me.today ? (
      <Link to={`/scan?mode=eat&slot=${slot}`} aria-label={`Scan something you ate for ${slot}`} className={cls}>
        <Icon name="scan" className="size-4" />
      </Link>
    ) : null;

  return (
    <div className="lg:-mr-6 lg:flex lg:items-start">
      <div className="min-w-0 flex-1 lg:pr-5">
        <PageTop
          title="Calendar"
          subtitle={rangeLabel(from, to)}
          left={<MenuButton />}
          actions={
            <div className="flex items-center gap-1">
              <IconButton icon="chevronLeft" label="Previous week" onClick={() => setFrom(addDays(from, -7))} />
              {from !== thisWeek && (
                <Button size="sm" onClick={() => setFrom(thisWeek)}>
                  This week
                </Button>
              )}
              <IconButton icon="chevronRight" label="Next week" onClick={() => setFrom(addDays(from, 7))} />
            </div>
          }
        />
        <Toolbar>
          {people.length > 1 && <PickerMenu label="Person" icon="users" value={person} defaultValue="me" onChange={setPerson} options={people} />}
          <Button size="sm" variant="dark" onClick={() => setSuggesting({ ingredient: null })}>
            Suggest meals
          </Button>
          <Button size="sm" onClick={() => setPlanningWeek(true)}>
            Plan my week
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void build()}>
            <Icon name="cart" className="size-4" /> Build shopping list
          </Button>
        </Toolbar>
        {hint && (
          <button
            type="button"
            onClick={() => setSuggesting({ ingredient: { id: hint.ingredientId, name: hint.name } })}
            className="mb-3 flex w-full items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-left text-sm hover:border-accent/60"
          >
            <span className="min-w-0 flex-1">
              <strong className="font-semibold">
                {amountText(hint.grams, ingredients.find((i) => i.id === hint.ingredientId))} {hint.name.toLowerCase()} spare after this plan.
              </strong>{' '}
              <span className="text-muted">
                {hint.topIdea ? `${hint.topIdea.title} would use it${hint.topIdea.missing.length ? ` (needs ${hint.topIdea.missing.join(', ').toLowerCase()})` : ''}. ` : ''}
                {hint.ideas ? `${hint.ideas} idea${hint.ideas === 1 ? '' : 's'}` : 'No recipes use it yet'}
              </span>
            </span>
            <Icon name="chevronRight" className="size-4 shrink-0 text-accent-text" />
          </button>
        )}
        <ErrorNote error={plan.error} />
        {plan.isPending ? (
          <Spinner />
        ) : desktop ? (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <div className="grid min-h-[calc(100vh-12rem)] min-w-[56rem] grid-cols-[6.5rem_repeat(7,minmax(0,1fr))] grid-rows-[auto_repeat(4,minmax(8rem,1fr))]" role="table" aria-label={`Meals, ${rangeLabel(from, to)}`}>
              <div role="row" className="contents">
                <div role="columnheader" className="border-b border-r border-line bg-card-muted/60" />
                {plan.data?.days.map((day) => (
                  <div key={day.date} role="columnheader" className={`border-b border-r border-line px-2 py-1.5 last:border-r-0 ${day.date === me.today ? 'bg-accent-soft' : 'bg-card-muted/60'}`}>
                    <p className={`text-sm font-semibold ${day.date === me.today ? 'text-accent-text' : ''}`}>{dayLabel(day.date, me.today)}</p>
                    <p className="text-xs text-muted tabular-nums">{day.kcal ? `${day.kcal.toLocaleString('en-GB')} kcal` : '–'}</p>
                  </div>
                ))}
              </div>
              {MEAL_SLOTS.map((slot) => (
                <div key={slot} role="row" className="contents">
                  <div role="rowheader" className="border-b border-r border-line px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
                    {SLOT_LABEL[slot]}
                  </div>
                  {plan.data?.days.map((day) => {
                    const entries = day.entries.filter((e) => e.slot === slot);
                    return (
                      <div
                        key={day.date}
                        role="cell"
                        onDragOver={(ev) => {
                          if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
                          ev.preventDefault();
                          setDropAt(`${day.date}|${slot}`);
                        }}
                        onDragLeave={() => setDropAt((d) => (d === `${day.date}|${slot}` ? null : d))}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          setDropAt(null);
                          const d = readDrag(ev);
                          if (d) void drop(day.date, slot, d);
                        }}
                        className={`group flex min-h-32 flex-col gap-1 border-b border-r border-line p-1.5 last:border-r-0 ${
                          dropAt === `${day.date}|${slot}` ? 'bg-accent-soft outline-2 -outline-offset-2 outline-accent' : day.date === me.today ? 'bg-accent-soft/30' : day.date < me.today ? 'bg-card-muted/30' : ''
                        }`}
                      >
                        {entries.map((e) => (
                          <div
                            key={e.id}
                            draggable
                            onDragStart={(ev) => {
                              startDrag(ev, { type: 'move', entryId: e.id, title: e.title });
                              setDragging(e);
                            }}
                            onDragEnd={() => {
                              setDropAt(null);
                              setDragging(null);
                            }}
                            className="cursor-grab active:cursor-grabbing"
                          >
                            {entryButton(e, true)}
                          </div>
                        ))}
                        <div className="mt-auto flex items-center gap-0.5">
                          <button
                            type="button"
                            aria-label={addLabel(day.date, slot)}
                            onClick={() => setAdding({ date: day.date, slot })}
                            className={`inline-flex h-6 items-center gap-1 rounded px-1 text-xs text-muted hover:bg-card-muted hover:text-ink ${entries.length ? 'opacity-0 group-hover:opacity-100 focus:opacity-100' : ''}`}
                          >
                            <Icon name="plus" className="size-3.5" /> Add
                          </button>
                          {scanLink(day.date, slot, 'inline-flex size-6 items-center justify-center rounded text-muted hover:bg-card-muted hover:text-ink')}
                          {mealKcal(entries) > 0 && (
                            <span className="ml-auto whitespace-nowrap text-[0.6875rem] font-semibold tabular-nums text-ink/70" title={`${SLOT_LABEL[slot]} total`}>
                              {mealKcal(entries).toLocaleString('en-GB')} kcal
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {plan.data && !showEarlier && plan.data.days.some((d) => d.date < me.today && d.entries.length === 0) && <Button onClick={() => setShowEarlier(true)}>Show earlier days</Button>}
            {plan.data?.days.map((day) => (
              <Card key={day.date} className={`p-3 ${day.date === me.today ? 'border-accent' : ''} ${!showEarlier && day.date < me.today && day.entries.length === 0 ? 'hidden' : ''}`}>
                <div className="mb-1 flex items-baseline justify-between gap-2 border-b border-line pb-2">
                  <h2 className="text-lg font-bold">{dayLabel(day.date, me.today)}</h2>
                  <span className="text-sm font-semibold text-muted">{day.kcal ? `${day.kcal.toLocaleString('en-GB')} kcal` : ''}</span>
                </div>
                {MEAL_SLOTS.map((slot) => {
                  const entries = day.entries.filter((e) => e.slot === slot);
                  return (
                    <section key={slot} className="border-b border-line py-1 last:border-b-0">
                      <div className="flex items-center gap-1">
                        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted">{SLOT_LABEL[slot]}</h3>
                        {mealKcal(entries) > 0 && <span className="text-sm font-semibold tabular-nums">{mealKcal(entries).toLocaleString('en-GB')} kcal</span>}
                        {scanLink(day.date, slot, 'inline-flex size-11 items-center justify-center text-accent-text')}
                        <button type="button" aria-label={addLabel(day.date, slot)} onClick={() => setAdding({ date: day.date, slot })} className="inline-flex size-11 items-center justify-center text-accent-text">
                          <Icon name="plus" className="size-5" />
                        </button>
                      </div>
                      <ul>
                        {entries.map((e) => (
                          <li key={e.id}>{entryButton(e, false)}</li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </Card>
            ))}
          </div>
        )}
        {adding && <AddSheet target={adding} members={members} onClose={() => setAdding(null)} />}
        {suggesting && <SuggestSheet open onClose={() => setSuggesting(null)} defaultDate={firstFreeDinner(plan.data?.days ?? [], me.today)} ingredient={suggesting.ingredient} servings={Math.max(1, members.length)} />}
        <PlanWeekSheet open={planningWeek} onClose={() => setPlanningWeek(false)} from={from} to={to} defaultServings={Math.max(1, members.length)} />
        {open && <EntrySheet entry={open} onClose={() => setOpen(null)} />}
      </div>
      {desktop && <CalendarPane servings={Math.max(1, members.length)} removing={dragging} onRemove={(id) => void remove(id)} />}
    </div>
  );
}

/** The first day from today with no dinner planned (for "Suggest meals"). */
function firstFreeDinner(days: { date: CalendarDate; entries: PlanEntryDto[] }[], today: CalendarDate): CalendarDate {
  return days.find((d) => d.date >= today && !d.entries.some((e) => e.slot === 'dinner' && e.status !== 'skipped'))?.date ?? today;
}

type Tab = 'recipe' | 'stock' | 'product' | 'text';

function AddSheet({ target, members, onClose }: { target: { date: CalendarDate; slot: MealSlot }; members: UserDto[]; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('recipe');
  const [q, setQ] = useState('');
  const [servings, setServings] = useState(target.slot === 'dinner' ? Math.max(1, members.length) : 1);
  const [eaters, setEaters] = useState<Set<string>>(new Set(members.length > 1 ? [] : [me.user.id]));
  const [text, setText] = useState('');
  const [kcal, setKcal] = useState('');
  const recipes = useRecipes().data ?? [];
  const meals = (useStock().data ?? []).filter((s) => s.isMeal);
  const products = useProducts(q).data ?? [];
  const isPast = target.date < me.today;

  const add = async (body: Record<string, unknown>) => {
    try {
      const people = [...eaters].map((userId) => ({
        userId,
        portions: servings / Math.max(1, eaters.size),
      }));
      await api.post('/api/plan', {
        date: target.date,
        slot: target.slot,
        servings,
        people,
        eaten: isPast,
        ...body,
      });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      toast.show('Added to the plan.');
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const shownRecipes = recipes.filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  const title = `${SLOT_LABEL[target.slot]}, ${new Date(`${target.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', timeZone: 'UTC' })}`;

  return (
    <Sheet open onClose={onClose} title={title}>
      <div role="tablist" aria-label="What to add" className="mb-3 grid grid-cols-4 gap-1 rounded-xl bg-card-muted p-1">
        {(
          [
            ['recipe', 'Recipe'],
            ['stock', 'Leftovers'],
            ['product', 'Food'],
            ['text', 'Note'],
          ] as const
        ).map(([t, label]) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-11 rounded-lg text-sm font-semibold ${tab === t ? 'bg-card shadow-sm' : 'text-muted'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2" role="group" aria-label="Servings">
          <button
            type="button"
            aria-label="Fewer"
            disabled={servings <= 0.5}
            onClick={() => setServings(servings - (servings > 1 ? 1 : 0.5))}
            className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40"
          >
            −
          </button>
          <span className="min-w-24 text-center font-semibold">
            {servings} {tab === 'recipe' ? (servings === 1 ? 'serving' : 'servings') : tab === 'stock' ? (servings === 1 ? 'portion' : 'portions') : ''}
          </span>
          <button type="button" aria-label="More" onClick={() => setServings(servings + (servings >= 1 ? 1 : 0.5))} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl">
            +
          </button>
        </div>
      </div>
      {members.length > 1 && (
        <fieldset className="mb-3">
          <legend className="mb-1 text-sm font-medium">Who's eating? (optional)</legend>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <label key={m.id} className={`flex min-h-11 items-center gap-2 rounded-full border px-3 ${eaters.has(m.id) ? 'border-strong bg-strong text-strong-ink' : 'border-line'}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={eaters.has(m.id)}
                  onChange={(e) =>
                    setEaters((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(m.id);
                      else n.delete(m.id);
                      return n;
                    })
                  }
                />
                {m.id === me.user.id ? 'You' : m.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted">{eaters.size ? `Split ${servings} between ${eaters.size}.` : 'Nobody picked: it’s for the household.'}</p>
        </fieldset>
      )}

      {tab !== 'text' && tab !== 'stock' && <TextInput aria-label="Search" placeholder={tab === 'recipe' ? 'Search recipes' : 'Search food'} value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />}
      {tab === 'recipe' && (
        <ul className="flex flex-col divide-y divide-line">
          {shownRecipes.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => void add({ kind: 'recipe', recipeId: r.id })} className="flex min-h-12 w-full items-center justify-between gap-3 text-left">
                <span className="font-medium">{r.title}</span>
                <span className="text-sm text-muted">{r.kcalPerServing ? `${r.kcalPerServing} kcal` : ''}</span>
              </button>
            </li>
          ))}
          {!shownRecipes.length && <li className="py-3 text-muted">No recipes found.</li>}
        </ul>
      )}
      {tab === 'stock' && (
        <ul className="flex flex-col divide-y divide-line">
          {meals.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => void add({ kind: 'stock', stockItemId: m.id })} className="flex min-h-12 w-full items-center justify-between gap-3 text-left">
                <span className="font-medium">{m.productName}</span>
                <span className="text-sm text-muted">
                  {m.locationName} · {amountLabel(m)}
                </span>
              </button>
            </li>
          ))}
          {!meals.length && <li className="py-3 text-muted">No leftovers or batch portions in stock.</li>}
        </ul>
      )}
      {tab === 'product' && (
        <ul className="flex flex-col divide-y divide-line">
          {products
            .filter((p) => p.name)
            .slice(0, 30)
            .map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => void add({ kind: 'product', productId: p.id })} className="flex min-h-12 w-full items-center justify-between gap-3 text-left">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-sm text-muted">{p.brand ?? ''}</span>
                </button>
              </li>
            ))}
          {!products.length && <li className="py-3 text-muted">Nothing found. Scan it in Eat mode, or add a note.</li>}
        </ul>
      )}
      {tab === 'text' && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim())
              void add({
                kind: 'text',
                text: text.trim(),
                kcalPerServing: kcal ? Number(kcal) : null,
              });
          }}
        >
          <Field label="What">{(id) => <TextInput id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Lunch out, Coffee with milk" />}</Field>
          <Field label="Calories each (optional)">{(id) => <TextInput id={id} inputMode="numeric" value={kcal} onChange={(e) => setKcal(e.target.value)} />}</Field>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            Add
          </Button>
        </form>
      )}
    </Sheet>
  );
}

/** True when a planned food was set by weight (a fraction of an item) rather than a count. */
const byWeight = (e: Pick<PlanEntryDto, 'servings' | 'unitGrams'>) => e.unitGrams !== null && Math.abs(e.servings - Math.round(e.servings)) > 0.001;

/** A short amount for the calendar card: "×2", "150g", or nothing for one of something. */
function shortAmount(e: PlanEntryDto): string {
  if (e.kind === 'text') return '';
  if (byWeight(e)) return amountText(e.servings * e.unitGrams!, { displayUnit: e.displayUnit });
  return e.servings === 1 ? '' : `×${e.servings}`;
}

/** "2 servings", "1 item", "150g". */
function amountWords(e: PlanEntryDto): string {
  if (e.kind === 'text') return '';
  if (e.kind === 'recipe') return `${e.servings} ${e.servings === 1 ? 'serving' : 'servings'}`;
  if (byWeight(e)) return amountText(e.servings * e.unitGrams!, { displayUnit: e.displayUnit });
  const noun = e.kind === 'stock' ? 'portion' : 'item';
  return `${e.servings} ${noun}${e.servings === 1 ? '' : 's'}`;
}

/** How much of it: servings for a recipe; items or a weight for food and leftovers. */
function AmountEditor({ entry }: { entry: PlanEntryDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canWeigh = entry.kind !== 'recipe' && entry.unitGrams !== null;
  const unit = entry.displayUnit === 'ml' ? 'ml' : 'g';
  const [mode, setMode] = useState<'items' | 'weight'>(byWeight(entry) ? 'weight' : 'items');
  const [value, setValue] = useState(byWeight(entry) ? String(Math.round(entry.servings * entry.unitGrams!)) : String(entry.servings));
  const number = Number(value);
  const servings = mode === 'weight' && entry.unitGrams ? number / entry.unitGrams : number;
  const valid = Number.isFinite(number) && number > 0 && servings <= 100;
  const save = async () => {
    try {
      await api.patch(`/api/plan/${entry.id}`, { servings: Math.round(servings * 1000) / 1000 });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      toast.show('Amount changed.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const switchMode = (m: 'items' | 'weight') => {
    if (m === mode || !entry.unitGrams) return;
    setValue(m === 'weight' ? String(Math.round((Number(value) || 1) * entry.unitGrams)) : String(Math.max(1, Math.round((Number(value) || entry.unitGrams) / entry.unitGrams))));
    setMode(m);
  };
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-2 rounded-lg bg-card-muted p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save();
      }}
    >
      <Field label={entry.kind === 'recipe' ? 'Servings' : mode === 'weight' ? `Amount (${unit})` : entry.kind === 'stock' ? 'Portions' : 'Items'}>
        {(id) => <TextInput id={id} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="w-28" />}
      </Field>
      {canWeigh && (
        <Segmented
          label="Measure by"
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'items', label: entry.kind === 'stock' ? 'Portions' : 'Items' },
            { value: 'weight', label: unit === 'ml' ? 'Volume' : 'Weight' },
          ]}
        />
      )}
      <Button type="submit" disabled={!valid}>
        Update
      </Button>
      {canWeigh && mode === 'items' && (
        <p className="w-full text-xs text-muted">One item is {amountText(entry.unitGrams!, { displayUnit: entry.displayUnit })}. For multipacks, set the size of one item on the product.</p>
      )}
    </form>
  );
}

function EntrySheet({ entry, onClose }: { entry: PlanEntryDto; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(entry.date);
  const [slot, setSlot] = useState<MealSlot>(entry.slot);
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(me.today, i - 1)), [me.today]);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(message);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <Sheet open onClose={onClose} title={entry.title}>
      <p className="mb-4 text-muted">
        {SLOT_LABEL[entry.slot]}
        {amountWords(entry) ? ` · ${amountWords(entry)}` : ''}
        {entry.kcal !== null ? ` · ${entry.kcal} kcal` : ''}
        {entry.people.length ? ` · ${entry.people.map((p) => (p.userId === me.user.id ? 'you' : p.name)).join(' + ')}` : ''}
      </p>
      {!moving && entry.kind !== 'text' && <AmountEditor key={`${entry.id}-${entry.servings}`} entry={entry} />}
      {moving ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day">
              {(id) => (
                <Select id={id} value={date} onChange={(e) => setDate(e.target.value)}>
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {dayLabel(d, me.today, true)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Meal">
              {(id) => (
                <Select id={id} value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)}>
                  {MEAL_SLOTS.map((s) => (
                    <option key={s} value={s}>
                      {SLOT_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button
            variant="primary"
            onClick={() =>
              void run(
                () =>
                  api.patch(`/api/plan/${entry.id}`, {
                    date,
                    slot,
                    status: 'planned',
                  }),
                'Moved.',
              )
            }
          >
            Move it
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {entry.status !== 'cooked' &&
            (entry.kind === 'recipe' && entry.recipeId ? (
              <Button variant="primary" size="lg" onClick={() => navigate(`/recipes/${entry.recipeId}/cook?servings=${entry.servings}&entry=${entry.id}`)}>
                Cooked it
              </Button>
            ) : (
              <Button variant="primary" size="lg" onClick={() => void run(() => api.post(`/api/plan/${entry.id}/eat`, {}), entry.kind === 'text' ? 'Done.' : 'Eaten, and taken out of stock.')}>
                Eaten
              </Button>
            ))}
          {entry.status === 'planned' ? (
            <Button size="lg" onClick={() => void run(() => api.patch(`/api/plan/${entry.id}`, { status: 'skipped' }), 'Skipped.')}>
              Skip
            </Button>
          ) : (
            <Button size="lg" onClick={() => void run(() => api.patch(`/api/plan/${entry.id}`, { status: 'planned' }), 'Back on the plan.')}>
              Not done yet
            </Button>
          )}
          <Button size="lg" onClick={() => setMoving(true)}>
            Move
          </Button>
          <Button size="lg" variant="danger" onClick={() => void run(() => api.del(`/api/plan/${entry.id}`), 'Removed.')}>
            Remove
          </Button>
          {entry.recipeId && (
            <Link to={`/recipes/${entry.recipeId}`} className="col-span-2 inline-flex min-h-11 items-center justify-center font-semibold text-accent-text">
              Open the recipe
            </Link>
          )}
        </div>
      )}
    </Sheet>
  );
}
