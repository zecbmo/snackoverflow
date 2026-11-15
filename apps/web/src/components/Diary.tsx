/**
 * The daily diary at the top of Today: calories eaten against your target (planned shown
 * apart, never added in), then each meal with what you've logged and, dashed, what's still
 * planned with one tap to say you ate it. ‹ › moves between days; earlier days are a diary,
 * later ones show the plan.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, type CalendarDate, type MacroTotals, MEAL_SLOTS, type MealSlot, type PlanEntryDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { usePlan } from '../lib/queries';
import { Icon } from './Icon';
import { useMe } from './Layout';
import { SLOT_LABEL, useLogFood } from './LogFood';
import { useToast } from './Toast';
import { Button, Card, Field, Sheet, Spinner, TextInput } from './ui';

function dayTitle(date: CalendarDate, today: CalendarDate): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const n = (x: number) => x.toLocaleString('en-GB');

/** Eaten (solid), planned (lighter) and what's left, against the target when there is one. */
export function CalorieBar({ eaten, planned, target }: { eaten: number; planned: number; target: number | null }) {
  const scale = Math.max(target ?? 0, eaten + planned, 1);
  const left = target === null ? null : target - eaten;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-3xl font-bold tabular-nums lg:text-2xl">{n(eaten)}</p>
        <p className="text-sm text-muted">{target ? `of ${n(target)} kcal eaten` : 'kcal eaten'}</p>
        {left !== null && (
          <p className={`ml-auto text-sm font-semibold tabular-nums ${left < 0 ? 'text-accent-text' : 'text-ink'}`}>{left < 0 ? `${n(-left)} over` : `${n(left)} left`}</p>
        )}
      </div>
      <div
        className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-card-muted"
        role="img"
        aria-label={`${n(eaten)} kcal eaten${planned ? `, ${n(planned)} more planned` : ''}${target ? ` of a ${n(target)} target` : ''}`}
      >
        <div className="h-full bg-accent" style={{ width: `${Math.min(100, (eaten / scale) * 100)}%` }} />
        <div className="h-full bg-accent/30" style={{ width: `${Math.min(100, (planned / scale) * 100)}%` }} />
      </div>
      {planned > 0 && <p className="mt-1.5 text-sm text-muted">{n(planned)} kcal more planned</p>}
    </div>
  );
}

/** "Protein 80g · Carbs 200g · Fat 60g", from the eaten foods whose macros are known. */
export function MacroLine({ macros }: { macros: MacroTotals }) {
  if (!macros.protein && !macros.carbs && !macros.fat) return null;
  return (
    <p className="mt-1 text-sm tabular-nums text-muted">
      Protein <span className="font-semibold text-ink">{n(macros.protein)}g</span> · Carbs <span className="font-semibold text-ink">{n(macros.carbs)}g</span> · Fat{' '}
      <span className="font-semibold text-ink">{n(macros.fat)}g</span>
      {macros.missing > 0 && <span> · {macros.missing === 1 ? '1 food' : `${macros.missing} foods`} without macros</span>}
    </p>
  );
}

export function Diary() {
  const me = useMe();
  const [date, setDate] = useState(me.today);
  const plan = usePlan(date, date, 'me');
  const day = plan.data?.days[0];
  const logFood = useLogFood();
  const navigate = useNavigate();
  const future = date > me.today;

  return (
    <section aria-labelledby="diary" className="mb-6">
      <div className="mb-2 flex items-center gap-1">
        <h2 id="diary" className="mr-auto text-lg font-bold lg:text-base">
          {dayTitle(date, me.today)}
          <span className="sr-only">: food diary</span>
        </h2>
        <button
          type="button"
          aria-label="Day before"
          onClick={() => setDate(addDays(date, -1))}
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink lg:size-8 lg:rounded-md"
        >
          <Icon name="chevronLeft" className="size-5" />
        </button>
        {date !== me.today && (
          <Button size="xs" variant="ghost" onClick={() => setDate(me.today)}>
            Today
          </Button>
        )}
        <button
          type="button"
          aria-label="Day after"
          onClick={() => setDate(addDays(date, 1))}
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink lg:size-8 lg:rounded-md"
        >
          <Icon name="chevronRight" className="size-5" />
        </button>
        {!future && (
          <Button size="sm" variant="primary" onClick={() => logFood.openLog({ date })} className="ml-1">
            <Icon name="plus" className="size-4" /> Log food
          </Button>
        )}
      </div>
      <Card className="p-4">
        {!day ? (
          <Spinner />
        ) : (
          <>
            <CalorieBar eaten={day.eatenKcal} planned={day.plannedKcal} target={me.user.kcalTarget ?? null} />
            <MacroLine macros={day.eatenMacros} />
            <div className="mt-3 flex flex-col">
              {MEAL_SLOTS.map((slot) => (
                <MealSection
                  key={slot}
                  slot={slot}
                  entries={day.entries.filter((e) => e.slot === slot && e.status !== 'skipped' && !e.batch)}
                  future={future}
                  onAdd={() => (future ? navigate(`/calendar?date=${date}&add=${slot}`) : logFood.openLog({ date, slot }))}
                />
              ))}
            </div>
            {!me.user.kcalTarget && (
              <p className="mt-2 text-sm text-muted">
                Want a daily target?{' '}
                <Link to="/profile" className="font-semibold text-accent-text hover:underline">
                  Set one in your profile
                </Link>
                .
              </p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

function MealSection({ slot, entries, future, onAdd }: { slot: MealSlot; entries: PlanEntryDto[]; future: boolean; onAdd: () => void }) {
  const eaten = entries.filter((e) => e.eaten).reduce((s, e) => s + (e.kcal ?? 0), 0);
  const [saving, setSaving] = useState(false);
  const eatenEntries = entries.filter((e) => e.eaten);
  return (
    <section aria-label={SLOT_LABEL[slot]} className="border-t border-line py-1.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted">{SLOT_LABEL[slot]}</h3>
        {eaten > 0 && <span className="text-sm font-semibold tabular-nums">{n(eaten)} kcal</span>}
        {!future && eatenEntries.length > 0 && (
          <button
            type="button"
            onClick={() => setSaving(true)}
            aria-label={`Save ${SLOT_LABEL[slot].toLowerCase()} as a meal`}
            title="Save as a meal, to log it again in one tap"
            className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-card-muted hover:text-ink lg:size-7"
          >
            <Icon name="bookmark" className="size-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onAdd}
          aria-label={`${future ? 'Plan' : 'Log'} ${SLOT_LABEL[slot].toLowerCase()}`}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-semibold text-accent-text hover:bg-card-muted lg:min-h-7"
        >
          <Icon name="plus" className="size-4" /> {future ? 'Plan' : 'Log'}
        </button>
      </div>
      {entries.length > 0 && (
        <ul className="flex flex-col gap-1 pb-1">
          {entries.map((e) => (
            <DiaryRow key={e.id} entry={e} future={future} />
          ))}
        </ul>
      )}
      {saving && <SaveMealSheet slot={slot} entries={eatenEntries} onClose={() => setSaving(false)} />}
    </section>
  );
}

/** Save what you ate at a meal as "My usual breakfast", to log again in one tap from Log food. */
function SaveMealSheet({ slot, entries, onClose }: { slot: MealSlot; entries: PlanEntryDto[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(`My usual ${SLOT_LABEL[slot].toLowerCase()}`);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/foods/meals', { name: name.trim(), entryIds: entries.map((e) => e.id) });
      await qc.invalidateQueries({ queryKey: ['foods'] });
      toast.show(`Saved ${name.trim()}. It's under Your meals in Log food.`);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title="Save as a meal">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !busy) void save();
        }}
      >
        <p className="text-sm text-muted">{entries.map((e) => e.title).join(', ')}</p>
        <Field label="Name">{(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}

function DiaryRow({ entry, future }: { entry: PlanEntryDto; future: boolean }) {
  const me = useMe();
  const logFood = useLogFood();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const eaten = entry.eaten;
  const uncookedRecipe = entry.kind === 'recipe' && entry.recipeId && entry.status === 'planned';
  const skip = async () => {
    try {
      await api.patch(`/api/plan/${entry.id}`, { status: 'skipped' });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      toast.show(`Skipped the ${entry.title.toLowerCase()}.`, {
        action: { label: 'Undo', onClick: async () => void (await api.patch(`/api/plan/${entry.id}`, { status: 'planned' }), await qc.invalidateQueries({ queryKey: ['plan'] })) },
      });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const meta = [entry.detail, entry.kcal !== null ? `${n(entry.kcal)} kcal` : 'Calories unknown'].filter(Boolean).join(' · ');
  return (
    <li className={`flex min-h-12 items-center gap-2 rounded-lg px-2 py-1 lg:min-h-10 ${eaten ? '' : 'border border-dashed border-line'}`}>
      {!future && (
        <button
          type="button"
          aria-pressed={eaten}
          aria-label={eaten ? `Untick ${entry.title} (eaten)` : `Tick ${entry.title} as eaten`}
          title={eaten ? 'Eaten (tap to untick)' : 'Tick when you ate it'}
          onClick={() => void (eaten ? logFood.untickEaten(entry, me.user.id) : uncookedRecipe ? navigate(cookUrl(entry)) : logFood.tickEaten(entry, me.user.id))}
          className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full border lg:size-7 ${eaten ? 'border-accent bg-accent text-accent-ink' : 'border-muted text-muted hover:border-accent hover:text-accent-text'}`}
        >
          <Icon name="check" className="size-4" strokeWidth={2.4} />
        </button>
      )}
      <Link to={`/calendar?date=${entry.date}&entry=${entry.id}`} className="min-w-0 flex-1">
        <span className="block truncate font-medium">{entry.title}</span>
        <span className="block truncate text-sm text-muted lg:text-xs">{eaten ? meta : `Planned · ${meta}`}</span>
      </Link>
      {!eaten && !future && (
        <div className="flex shrink-0 gap-1">
          {uncookedRecipe ? (
            <Button size="xs" variant="primary" onClick={() => navigate(cookUrl(entry))}>
              Cooked it
            </Button>
          ) : (
            <Button size="xs" variant="primary" onClick={() => void logFood.tickEaten(entry, me.user.id)}>
              Ate it
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => void skip()}>
            Skip
          </Button>
        </div>
      )}
    </li>
  );
}

function cookUrl(entry: PlanEntryDto): string {
  return `/recipes/${entry.recipeId}/cook?servings=${entry.servings}&entry=${entry.id}`;
}
