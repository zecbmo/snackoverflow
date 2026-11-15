/**
 * One small person icon per serving of a planned meal: filled in the accent colour for the person
 * whose calendar it is, filled dark for someone else, dashed when nobody has it yet, and dashed
 * with a box when it was kept as leftovers after cooking. In the meal's sheet each icon is a menu
 * to give that portion to someone, take it, or free it again.
 */
import { assignSlot, type PlanEntryDto, portionSlots, type UserDto } from '@snackoverflow/shared';
import { Icon } from './Icon';
import { Menu, type MenuEntry } from './Menu';

type Person = Pick<UserDto, 'id' | 'name'>;

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?';

/** A slot that was kept as leftovers when the meal was cooked: nobody's to take. */
const KEPT = 'kept:leftovers';

/** One slot per serving: a person, null for free, or KEPT (the last free ones, as many as were kept). */
function slotsOf(entry: Pick<PlanEntryDto, 'servings' | 'people'> & { keptServings?: number }, max?: number): (string | null)[] {
  const slots = portionSlots(entry.servings, entry.people, max);
  let kept = Math.round(entry.keptServings ?? 0);
  for (let i = slots.length - 1; i >= 0 && kept > 0; i--) {
    if (slots[i] === null) {
      slots[i] = KEPT;
      kept--;
    }
  }
  return slots;
}

function Dot({ who, viewerId, names, size }: { who: string | null; viewerId: string; names: Map<string, string>; size: 'sm' | 'lg' }) {
  const box = size === 'sm' ? 'size-3.5 text-[0.5625rem]' : 'size-9 text-sm';
  if (who === KEPT) {
    return (
      <span aria-hidden title="Kept as leftovers" className={`inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted text-muted ${box}`}>
        <Icon name="box" className={size === 'sm' ? 'size-2.5' : 'size-4'} strokeWidth={size === 'sm' ? 2.4 : undefined} />
      </span>
    );
  }
  const name = who ? (names.get(who) ?? 'Someone') : null;
  const tone = who === null ? 'border border-dashed border-muted text-transparent' : who === viewerId ? 'bg-accent text-accent-ink' : 'bg-strong text-strong-ink';
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none ${box} ${tone}`}>
      {name ? initial(name) : ''}
    </span>
  );
}

/** "Portions: you, Sam, 1 free": what the icons say, for screen readers and tooltips. */
export function portionsSummary(entry: Pick<PlanEntryDto, 'servings' | 'people' | 'batch'> & { keptServings?: number }, meId: string): string {
  if (entry.batch) return 'Batch cook: nobody is eating it now';
  const slots = slotsOf(entry, 1000);
  const free = slots.filter((s) => s === null).length;
  const kept = slots.filter((s) => s === KEPT).length;
  const parts = entry.people.map((p) => (p.userId === meId ? 'you' : p.name));
  if (kept) parts.push(`${kept} kept as leftovers`);
  if (free) parts.push(`${free} free`);
  return parts.length ? `Portions: ${parts.join(', ')}` : 'Nobody yet';
}

/** Whether a meal needs icons at all: not when it's simply all for the person viewing. */
export function showPortions(entry: Pick<PlanEntryDto, 'servings' | 'people' | 'batch' | 'kind'>, viewerId: string): boolean {
  if (entry.batch || entry.kind === 'text') return false;
  const allTheirs = entry.people.length === 1 && entry.people[0]!.userId === viewerId && entry.people[0]!.portions >= entry.servings - 0.001;
  return !allTheirs;
}

/** The compact row on a calendar card (not interactive: the card itself opens the meal). */
export function PortionDots({ entry, viewerId, meId, members }: { entry: PlanEntryDto; viewerId: string; meId: string; members: Person[] }) {
  const names = new Map([...members.map((m) => [m.id, m.name] as const), ...entry.people.map((p) => [p.userId, p.name] as const)]);
  const slots = slotsOf(entry);
  const more = Math.ceil(entry.servings - 0.001) - slots.length;
  const summary = portionsSummary(entry, meId);
  return (
    <span className="flex flex-wrap items-center gap-0.5" title={summary}>
      {slots.map((s, i) => (
        <Dot key={i} who={s} viewerId={viewerId} names={names} size="sm" />
      ))}
      {more > 0 && <span className="text-[0.625rem] text-muted">+{more}</span>}
      <span className="sr-only">{summary}</span>
    </span>
  );
}

/**
 * The icons in a meal's sheet, each a menu. Admins can give a portion to anyone; everyone else can
 * take a free one or give theirs back.
 */
export function PortionPicker({
  entry,
  viewerId,
  meId,
  isAdmin,
  members,
  onChange,
}: {
  entry: PlanEntryDto;
  viewerId: string;
  meId: string;
  isAdmin: boolean;
  members: Person[];
  onChange: (people: { userId: string; portions: number }[]) => void;
}) {
  const names = new Map([...members.map((m) => [m.id, m.name] as const), ...entry.people.map((p) => [p.userId, p.name] as const)]);
  const slots = slotsOf(entry, 12);
  const label = (id: string) => (id === meId ? 'You' : (names.get(id) ?? 'Someone'));
  const give = (slot: number, to: string | null) => onChange(assignSlot(entry.servings, entry.people, slot, to));
  return (
    <div role="group" aria-label="Who's eating" className="flex flex-wrap items-center gap-1.5">
      {slots.map((who, i) => {
        const canChange = who !== KEPT && (isAdmin || who === null || who === meId);
        const dot = <Dot who={who} viewerId={viewerId} names={names} size="lg" />;
        const name = who === null ? 'free' : who === KEPT ? 'kept as leftovers' : label(who);
        if (!canChange) {
          return (
            <span key={i} title={who === KEPT ? 'Kept as leftovers' : `${name}'s portion`}>
              {dot}
              <span className="sr-only">
                Portion {i + 1}: {name}
              </span>
            </span>
          );
        }
        const choices: MenuEntry[] = isAdmin
          ? [
              ...members.map((m) => ({ label: label(m.id), checked: who === m.id, onSelect: () => give(i, m.id) })),
              'divider' as const,
              { label: 'Nobody yet', checked: who === null, onSelect: () => give(i, null) },
            ]
          : who === null
            ? [{ label: 'Mine', onSelect: () => give(i, meId) }]
            : [{ label: 'Not mine after all', onSelect: () => give(i, null) }];
        return (
          <Menu
            key={i}
            label={`Portion ${i + 1}: ${name}. Change who it's for`}
            items={choices}
            align="start"
            trigger={
              <>
                {dot}
                <span className="sr-only">
                  Portion {i + 1}: {name}. Change who it's for
                </span>
              </>
            }
            triggerClassName="inline-flex size-11 items-center justify-center rounded-full hover:bg-card-muted lg:size-9"
          />
        );
      })}
    </div>
  );
}
