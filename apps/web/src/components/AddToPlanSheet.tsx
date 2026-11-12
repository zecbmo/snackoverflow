/** Put a recipe (or leftovers) into a meal slot: pick the day, the meal and how many servings. */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { addDays, type CalendarDate, MEAL_SLOTS, type MealSlot } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { useMe } from './Layout';
import { useToast } from './Toast';
import { Button, Field, Select, Sheet } from './ui';

export interface PlanTarget {
  kind: 'recipe' | 'stock';
  id: string;
  title: string;
  servings: number;
  date?: CalendarDate;
  slot?: MealSlot;
}

export function dayName(d: CalendarDate, today: CalendarDate): string {
  if (d === today) return 'Today';
  if (d === addDays(today, 1)) return 'Tomorrow';
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function AddToPlanSheet({ target, onClose }: { target: PlanTarget | null; onClose: () => void }) {
  return target ? <Inner key={`${target.kind}${target.id}`} target={target} onClose={onClose} /> : null;
}

function Inner({ target, onClose }: { target: PlanTarget; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(target.date ?? me.today);
  const [slot, setSlot] = useState<MealSlot>(target.slot ?? 'dinner');
  const [servings, setServings] = useState(target.servings);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(me.today, i)), [me.today]);

  const add = async () => {
    try {
      await api.post('/api/plan', {
        date,
        slot,
        servings,
        kind: target.kind,
        ...(target.kind === 'recipe' ? { recipeId: target.id } : { stockItemId: target.id }),
      });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(`${target.title} is planned for ${dayName(date, me.today).toLowerCase()}.`);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <Sheet open onClose={onClose} title={`Plan ${target.title}`}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day">
            {(id) => (
              <Select id={id} value={date} onChange={(e) => setDate(e.target.value)}>
                {days.map((d) => (
                  <option key={d} value={d}>
                    {dayName(d, me.today)}
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
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3" role="group" aria-label="Servings">
          <span className="font-medium">{target.kind === 'recipe' ? 'Servings' : 'Portions'}</span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Fewer" disabled={servings <= 1} onClick={() => setServings(servings - 1)} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl disabled:opacity-40">
              −
            </button>
            <span className="min-w-8 text-center font-semibold">{servings}</span>
            <button type="button" aria-label="More" onClick={() => setServings(servings + 1)} className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl">
              +
            </button>
          </div>
        </div>
        <Button variant="primary" size="lg" onClick={() => void add()}>
          Add to plan
        </Button>
      </div>
    </Sheet>
  );
}
