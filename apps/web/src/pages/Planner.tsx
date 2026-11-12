/**
 * The planner: each person's week as meal slots with calories. Plan recipes,
 * leftovers, products or a note; log what was eaten; build the shopping list.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  addDays,
  type CalendarDate,
  MEAL_SLOTS,
  type MealSlot,
  type PlanEntryDto,
  type UserDto,
} from "@snackoverflow/shared";
import { Icon } from "../components/Icon";
import { MenuButton, useMe } from "../components/Layout";
import { useToast } from "../components/Toast";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  IconButton,
  PageHeader,
  Select,
  Sheet,
  Spinner,
  TextInput,
} from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { amountLabel } from "../lib/format";
import {
  usePlan,
  useProducts,
  useRecipes,
  useStock,
  useSurplus,
  useUsers,
} from "../lib/queries";
import { PlanWeekSheet, SuggestSheet } from "../components/OptimiserSheets";
import { formatQuantity } from "@snackoverflow/shared";

const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

/** Monday of the week containing `d`. */
function weekStart(d: CalendarDate): CalendarDate {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return addDays(d, -((dow + 6) % 7));
}

function dayLabel(d: CalendarDate, today: CalendarDate, long = false): string {
  const date = new Date(`${d}T12:00:00Z`);
  const name = date.toLocaleDateString("en-GB", {
    weekday: long ? "long" : "short",
    timeZone: "UTC",
  });
  const num = date.getUTCDate();
  if (d === today) return `Today · ${name.slice(0, 3)} ${num}`;
  if (d === addDays(today, 1)) return `Tomorrow · ${name.slice(0, 3)} ${num}`;
  return `${name} ${num}`;
}

function rangeLabel(from: CalendarDate, to: CalendarDate): string {
  const f = new Date(`${from}T12:00:00Z`);
  const t = new Date(`${to}T12:00:00Z`);
  const month = (x: Date) =>
    x.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return f.getUTCMonth() === t.getUTCMonth()
    ? `${f.getUTCDate()} – ${t.getUTCDate()} ${month(t)}`
    : `${f.getUTCDate()} ${month(f)} – ${t.getUTCDate()} ${month(t)}`;
}

export function PlannerPage() {
  const me = useMe();
  const isAdmin = me.user.role === "admin";
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(() =>
    weekStart(params.get("date") ?? me.today),
  );
  const to = addDays(from, 6);
  const [person, setPerson] = useState("me");
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
    const date = params.get("date");
    const slot = params.get("add");
    return date && slot && (MEAL_SLOTS as readonly string[]).includes(slot)
      ? { date, slot: slot as MealSlot }
      : null;
  });
  const [open, setOpen] = useState<PlanEntryDto | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [suggesting, setSuggesting] = useState<{
    ingredient: { id: string; name: string } | null;
  } | null>(null);
  const [planningWeek, setPlanningWeek] = useState(false);
  const surplus = useSurplus().data ?? [];
  const hint = surplus.find((h) => h.ideas > 0) ?? surplus[0];

  // Opened from a "Move" notification: show that meal.
  const entryParam = params.get("entry");
  useEffect(() => {
    if (!entryParam) return;
    void api
      .get<PlanEntryDto>(`/api/plan/${entryParam}`)
      .then(setOpen, () => {});
    setParams((p) => {
      p.delete("entry");
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
      }>("/api/shopping/build", { from: start, to });
      await qc.invalidateQueries({ queryKey: ["shopping"] });
      toast.show(
        r.added + r.updated
          ? `Added ${r.added + r.updated} thing${r.added + r.updated === 1 ? "" : "s"} to the list.`
          : "Nothing to buy: stock covers this plan.",
      );
      if (r.added + r.updated) navigate("/shop");
    } catch (e) {
      toast.show(errorMessage(e), { tone: "error" });
    }
  };

  const chips = [
    { id: "me", label: "You" },
    ...(isAdmin
      ? members
          .filter((m) => m.id !== me.user.id)
          .map((m) => ({ id: m.id, label: m.name }))
      : []),
    { id: "everyone", label: "Everyone" },
  ];

  return (
    <>
      <PageHeader
        title="Planner"
        subtitle={rangeLabel(from, to)}
        left={<MenuButton />}
        right={
          <div className="flex gap-2">
            <IconButton
              icon="chevronLeft"
              label="Previous week"
              className="size-12"
              onClick={() => setFrom(addDays(from, -7))}
            />
            <IconButton
              icon="chevronRight"
              label="Next week"
              className="size-12"
              onClick={() => setFrom(addDays(from, 7))}
            />
          </div>
        }
      />
      <div
        className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4"
        role="group"
        aria-label="Whose calendar"
      >
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={person === c.id}
            onClick={() => setPerson(c.id)}
            className={`min-h-11 shrink-0 rounded-full border px-5 text-[0.9375rem] font-semibold ${person === c.id ? "border-strong bg-strong text-strong-ink" : "border-line bg-card"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      {/* Phone: two big buttons, then the rest. Desktop: one compact row. */}
      <div className="lg:flex lg:flex-wrap lg:gap-3">
        <div className="mb-3 grid grid-cols-2 gap-3 lg:mb-4 lg:flex">
          <Button
            variant="dark"
            size="lg"
            className="lg:min-h-11 lg:px-4"
            onClick={() => setSuggesting({ ingredient: null })}
          >
            Suggest meals
          </Button>
          <Button
            size="lg"
            className="lg:min-h-11 lg:px-4"
            onClick={() => setPlanningWeek(true)}
          >
            Plan my week
          </Button>
        </div>
        <div className="mb-4 flex flex-wrap gap-3">
          <Button onClick={() => void build()}>
            <Icon name="cart" className="size-5" /> Build shopping list
          </Button>
          {from !== weekStart(me.today) && (
            <Button onClick={() => setFrom(weekStart(me.today))}>
              This week
            </Button>
          )}
        </div>
      </div>
      {hint && (
        <button
          type="button"
          onClick={() =>
            setSuggesting({
              ingredient: { id: hint.ingredientId, name: hint.name },
            })
          }
          className="mb-4 flex w-full items-center gap-3 rounded-[18px] border border-accent/40 bg-accent-soft p-5 text-left"
        >
          <span className="flex-1">
            <span className="block text-lg font-semibold">
              {formatQuantity(hint.grams)} {hint.name.toLowerCase()} spare after
              this plan
            </span>
            <span className="block text-muted">
              {hint.topIdea
                ? `${hint.topIdea.title} would use it${hint.topIdea.missing.length ? ` (needs ${hint.topIdea.missing.join(", ").toLowerCase()})` : ""}. `
                : ""}
              {hint.ideas
                ? `${hint.ideas} idea${hint.ideas === 1 ? "" : "s"}`
                : "No recipes use it yet"}
            </span>
          </span>
          <Icon name="chevronRight" className="size-5 text-accent-text" />
        </button>
      )}
      <ErrorNote error={plan.error} />
      {plan.isPending ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 lg:grid-cols-7 lg:gap-2">
          {plan.data &&
            !showEarlier &&
            plan.data.days.some(
              (d) => d.date < me.today && d.entries.length === 0,
            ) && (
              <Button
                className="lg:hidden"
                onClick={() => setShowEarlier(true)}
              >
                Show earlier days
              </Button>
            )}
          {plan.data?.days.map((day) => (
            <Card
              key={day.date}
              className={`p-4 lg:p-2 ${day.date === me.today ? "border-accent" : ""} ${!showEarlier && day.date < me.today && day.entries.length === 0 ? "hidden lg:block" : ""}`}
            >
              <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-line pb-2 lg:flex-col lg:items-start">
                <h2 className="text-xl font-bold lg:text-base">
                  {dayLabel(day.date, me.today)}
                </h2>
                <span className="font-semibold text-muted lg:text-sm">
                  {day.kcal ? `${day.kcal.toLocaleString("en-GB")} kcal` : ""}
                </span>
              </div>
              {MEAL_SLOTS.map((slot) => {
                const entries = day.entries.filter((e) => e.slot === slot);
                const kcal = entries
                  .filter((e) => e.status !== "skipped")
                  .reduce((s, e) => s + (e.kcal ?? 0), 0);
                return (
                  <section
                    key={slot}
                    className="border-b border-line py-2 last:border-b-0"
                  >
                    <div className="flex items-center gap-1">
                      <h3 className="flex-1 text-sm font-semibold uppercase tracking-wider text-muted lg:text-xs">
                        {SLOT_LABEL[slot]}
                      </h3>
                      {kcal > 0 && (
                        <span className="text-sm font-semibold lg:hidden">
                          {kcal} kcal
                        </span>
                      )}
                      {day.date === me.today && (
                        <Link
                          to={`/scan?mode=eat&slot=${slot}`}
                          aria-label={`Scan something you ate for ${slot}`}
                          className="inline-flex size-11 items-center justify-center text-accent-text lg:size-8"
                        >
                          <Icon name="scan" className="size-5" />
                        </Link>
                      )}
                      <button
                        type="button"
                        aria-label={`Add to ${slot} on ${dayLabel(day.date, me.today, true)}`}
                        onClick={() => setAdding({ date: day.date, slot })}
                        className="inline-flex size-11 items-center justify-center text-accent-text lg:size-8"
                      >
                        <Icon name="plus" className="size-5" />
                      </button>
                    </div>
                    <ul>
                      {entries.map((e) => (
                        <li key={e.id}>
                          <button
                            type="button"
                            onClick={() => setOpen(e)}
                            className="flex min-h-11 w-full items-center gap-3 text-left"
                          >
                            <span
                              aria-hidden
                              className={`size-2.5 shrink-0 rounded-full ${e.status === "cooked" ? "bg-strong" : e.status === "skipped" ? "bg-transparent" : "border border-strong"}`}
                            />
                            <span
                              className={`min-w-0 flex-1 text-[1.0625rem] lg:text-sm ${e.status === "skipped" ? "text-muted line-through" : ""}`}
                            >
                              {e.title}
                            </span>
                            <span className="whitespace-nowrap text-[0.9375rem] text-muted lg:hidden">
                              {[e.detail, e.kcal !== null ? e.kcal : null]
                                .filter((x) => x !== null && x !== "")
                                .join(" · ")}
                            </span>
                            <span className="sr-only">
                              {e.status === "cooked"
                                ? "(done)"
                                : e.status === "skipped"
                                  ? "(skipped)"
                                  : "(planned)"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <AddSheet
          target={adding}
          members={members}
          onClose={() => setAdding(null)}
        />
      )}
      {suggesting && (
        <SuggestSheet
          open
          onClose={() => setSuggesting(null)}
          defaultDate={firstFreeDinner(plan.data?.days ?? [], me.today)}
          ingredient={suggesting.ingredient}
          servings={Math.max(1, members.length)}
        />
      )}
      <PlanWeekSheet
        open={planningWeek}
        onClose={() => setPlanningWeek(false)}
        from={from}
        to={to}
        defaultServings={Math.max(1, members.length)}
      />
      {open && <EntrySheet entry={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The first day from today with no dinner planned (for "Suggest meals"). */
function firstFreeDinner(
  days: { date: CalendarDate; entries: PlanEntryDto[] }[],
  today: CalendarDate,
): CalendarDate {
  return (
    days.find(
      (d) =>
        d.date >= today &&
        !d.entries.some((e) => e.slot === "dinner" && e.status !== "skipped"),
    )?.date ?? today
  );
}

type Tab = "recipe" | "stock" | "product" | "text";

function AddSheet({
  target,
  members,
  onClose,
}: {
  target: { date: CalendarDate; slot: MealSlot };
  members: UserDto[];
  onClose: () => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("recipe");
  const [q, setQ] = useState("");
  const [servings, setServings] = useState(
    target.slot === "dinner" ? Math.max(1, members.length) : 1,
  );
  const [eaters, setEaters] = useState<Set<string>>(
    new Set(members.length > 1 ? [] : [me.user.id]),
  );
  const [text, setText] = useState("");
  const [kcal, setKcal] = useState("");
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
      await api.post("/api/plan", {
        date: target.date,
        slot: target.slot,
        servings,
        people,
        eaten: isPast,
        ...body,
      });
      await qc.invalidateQueries({ queryKey: ["plan"] });
      toast.show("Added to the plan.");
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: "error" });
    }
  };

  const shownRecipes = recipes
    .filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 30);
  const title = `${SLOT_LABEL[target.slot]}, ${new Date(`${target.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", timeZone: "UTC" })}`;

  return (
    <Sheet open onClose={onClose} title={title}>
      <div
        role="tablist"
        aria-label="What to add"
        className="mb-3 grid grid-cols-4 gap-1 rounded-xl bg-card-muted p-1"
      >
        {(
          [
            ["recipe", "Recipe"],
            ["stock", "Leftovers"],
            ["product", "Food"],
            ["text", "Note"],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-11 rounded-lg text-sm font-semibold ${tab === t ? "bg-card shadow-sm" : "text-muted"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div
          className="flex items-center gap-2"
          role="group"
          aria-label="Servings"
        >
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
            {servings}{" "}
            {tab === "recipe"
              ? servings === 1
                ? "serving"
                : "servings"
              : tab === "stock"
                ? servings === 1
                  ? "portion"
                  : "portions"
                : ""}
          </span>
          <button
            type="button"
            aria-label="More"
            onClick={() => setServings(servings + (servings >= 1 ? 1 : 0.5))}
            className="inline-flex size-11 items-center justify-center rounded-full border border-line text-xl"
          >
            +
          </button>
        </div>
      </div>
      {members.length > 1 && (
        <fieldset className="mb-3">
          <legend className="mb-1 text-sm font-medium">
            Who's eating? (optional)
          </legend>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <label
                key={m.id}
                className={`flex min-h-11 items-center gap-2 rounded-full border px-3 ${eaters.has(m.id) ? "border-strong bg-strong text-strong-ink" : "border-line"}`}
              >
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
                {m.id === me.user.id ? "You" : m.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted">
            {eaters.size
              ? `Split ${servings} between ${eaters.size}.`
              : "Nobody picked: it’s for the household."}
          </p>
        </fieldset>
      )}

      {tab !== "text" && tab !== "stock" && (
        <TextInput
          aria-label="Search"
          placeholder={tab === "recipe" ? "Search recipes" : "Search food"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="mb-2"
        />
      )}
      {tab === "recipe" && (
        <ul className="flex flex-col divide-y divide-line">
          {shownRecipes.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => void add({ kind: "recipe", recipeId: r.id })}
                className="flex min-h-12 w-full items-center justify-between gap-3 text-left"
              >
                <span className="font-medium">{r.title}</span>
                <span className="text-sm text-muted">
                  {r.kcalPerServing ? `${r.kcalPerServing} kcal` : ""}
                </span>
              </button>
            </li>
          ))}
          {!shownRecipes.length && (
            <li className="py-3 text-muted">No recipes found.</li>
          )}
        </ul>
      )}
      {tab === "stock" && (
        <ul className="flex flex-col divide-y divide-line">
          {meals.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => void add({ kind: "stock", stockItemId: m.id })}
                className="flex min-h-12 w-full items-center justify-between gap-3 text-left"
              >
                <span className="font-medium">{m.productName}</span>
                <span className="text-sm text-muted">
                  {m.locationName} · {amountLabel(m)}
                </span>
              </button>
            </li>
          ))}
          {!meals.length && (
            <li className="py-3 text-muted">
              No leftovers or batch portions in stock.
            </li>
          )}
        </ul>
      )}
      {tab === "product" && (
        <ul className="flex flex-col divide-y divide-line">
          {products
            .filter((p) => p.name)
            .slice(0, 30)
            .map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => void add({ kind: "product", productId: p.id })}
                  className="flex min-h-12 w-full items-center justify-between gap-3 text-left"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-sm text-muted">{p.brand ?? ""}</span>
                </button>
              </li>
            ))}
          {!products.length && (
            <li className="py-3 text-muted">
              Nothing found. Scan it in Eat mode, or add a note.
            </li>
          )}
        </ul>
      )}
      {tab === "text" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim())
              void add({
                kind: "text",
                text: text.trim(),
                kcalPerServing: kcal ? Number(kcal) : null,
              });
          }}
        >
          <Field label="What">
            {(id) => (
              <TextInput
                id={id}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="e.g. Lunch out, Coffee with milk"
              />
            )}
          </Field>
          <Field label="Calories each (optional)">
            {(id) => (
              <TextInput
                id={id}
                inputMode="numeric"
                value={kcal}
                onChange={(e) => setKcal(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            Add
          </Button>
        </form>
      )}
    </Sheet>
  );
}

function EntrySheet({
  entry,
  onClose,
}: {
  entry: PlanEntryDto;
  onClose: () => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(entry.date);
  const [slot, setSlot] = useState<MealSlot>(entry.slot);
  const dates = useMemo(
    () => Array.from({ length: 14 }, (_, i) => addDays(me.today, i - 1)),
    [me.today],
  );

  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["plan"] });
      await qc.invalidateQueries({ queryKey: ["stock"] });
      toast.show(message);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: "error" });
    }
  };

  return (
    <Sheet open onClose={onClose} title={entry.title}>
      <p className="mb-4 text-muted">
        {SLOT_LABEL[entry.slot]} · {entry.servings}{" "}
        {entry.kind === "recipe"
          ? "servings"
          : entry.kind === "stock"
            ? "portions"
            : ""}
        {entry.kcal !== null ? ` · ${entry.kcal} kcal` : ""}
        {entry.people.length
          ? ` · ${entry.people.map((p) => (p.userId === me.user.id ? "you" : p.name)).join(" + ")}`
          : ""}
      </p>
      {moving ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day">
              {(id) => (
                <Select
                  id={id}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                >
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
                <Select
                  id={id}
                  value={slot}
                  onChange={(e) => setSlot(e.target.value as MealSlot)}
                >
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
                    status: "planned",
                  }),
                "Moved.",
              )
            }
          >
            Move it
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {entry.status !== "cooked" &&
            (entry.kind === "recipe" && entry.recipeId ? (
              <Button
                variant="primary"
                size="lg"
                onClick={() =>
                  navigate(
                    `/recipes/${entry.recipeId}/cook?servings=${entry.servings}&entry=${entry.id}`,
                  )
                }
              >
                Cooked it
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                onClick={() =>
                  void run(
                    () => api.post(`/api/plan/${entry.id}/eat`, {}),
                    entry.kind === "text"
                      ? "Done."
                      : "Eaten, and taken out of stock.",
                  )
                }
              >
                Eaten
              </Button>
            ))}
          {entry.status === "planned" ? (
            <Button
              size="lg"
              onClick={() =>
                void run(
                  () =>
                    api.patch(`/api/plan/${entry.id}`, { status: "skipped" }),
                  "Skipped.",
                )
              }
            >
              Skip
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={() =>
                void run(
                  () =>
                    api.patch(`/api/plan/${entry.id}`, { status: "planned" }),
                  "Back on the plan.",
                )
              }
            >
              Not done yet
            </Button>
          )}
          <Button size="lg" onClick={() => setMoving(true)}>
            Move
          </Button>
          <Button
            size="lg"
            variant="danger"
            onClick={() =>
              void run(() => api.del(`/api/plan/${entry.id}`), "Removed.")
            }
          >
            Remove
          </Button>
          {entry.recipeId && (
            <Link
              to={`/recipes/${entry.recipeId}`}
              className="col-span-2 inline-flex min-h-11 items-center justify-center font-semibold text-accent-text"
            >
              Open the recipe
            </Link>
          )}
        </div>
      )}
    </Sheet>
  );
}
