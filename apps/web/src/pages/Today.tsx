import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { PlanEntryDto } from "@snackoverflow/shared";
import { addDays, formatPence } from "@snackoverflow/shared";
import { BellButton, MenuButton, useMe } from "../components/Layout";
import { useStockActions } from "../components/StockActions";
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pill,
  Spinner,
} from "../components/ui";
import {
  amountLabel,
  dateLabel,
  greeting,
  longToday,
  stateLabel,
  toneClasses,
  toneFor,
} from "../lib/format";
import {
  useCalories,
  usePlan,
  useProducts,
  useRecipes,
  useRunningLow,
  useShopping,
  useStock,
  useWasteReport,
} from "../lib/queries";
import { changeLine, weightLabel } from "./Dashboard";
import { itemTitle } from "./Shopping";
import { dayName } from "../components/AddToPlanSheet";
import { api } from "../lib/api";
import { minutesLabel } from "../lib/format";
import { useToast } from "../components/Toast";

export function TodayPage() {
  const me = useMe();
  const stock = useStock();
  const waste = useWasteReport("month").data;
  const thisMonth = waste?.periods.at(-1);
  const calories = useCalories("me").data;
  const target = me.user.kcalTarget;
  const avg7 = calories?.avg7 ?? null;
  const unnamed = useProducts("", true).data ?? [];
  const actions = useStockActions();
  const soonLimit = addDays(me.today, 3);
  const soon = (stock.data ?? []).filter(
    (i) =>
      i.state !== "frozen" &&
      i.bestBefore !== null &&
      i.bestBefore <= soonLimit,
  );
  const shown = soon.slice(0, 8);
  const wasteChange = waste
    ? changeLine(waste.changePercent, waste.periods, "month")
    : null;

  const day = usePlan(me.today, me.today, "me").data?.days[0];
  const eatenKcal = (day?.entries ?? [])
    .filter((e) => e.status === "cooked")
    .reduce((n, e) => n + (e.kcal ?? 0), 0);
  const plannedKcal = (day?.entries ?? [])
    .filter((e) => e.status !== "skipped")
    .reduce((n, e) => n + (e.kcal ?? 0), 0);
  const tonight =
    (day?.entries ?? []).find(
      (e) =>
        e.kind === "recipe" && e.status === "planned" && e.slot === "dinner",
    ) ??
    (day?.entries ?? []).find(
      (e) => e.kind === "recipe" && e.status === "planned",
    );
  const low = (useRunningLow().data ?? []).filter((l) => !l.onList);
  const qc = useQueryClient();
  const toast = useToast();

  return (
    <>
      <PageHeader
        title={greeting()}
        subtitle={longToday(me.today)}
        left={<MenuButton />}
        right={<BellButton />}
      />
      {tonight && <TonightCard entry={tonight} />}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start lg:gap-6">
        <div className="min-w-0">
          <WeekDinners />
          <section aria-labelledby="use-soon" className="mb-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 id="use-soon" className="text-2xl font-bold">
                Use soon
              </h2>
              {soon.length > 0 && (
                <Link to="/stock" className="font-semibold text-accent-text">
                  See all {soon.length}
                </Link>
              )}
            </div>
            {stock.isPending ? (
              <Spinner />
            ) : shown.length === 0 ? (
              <EmptyState title="Nothing going off in the next 3 days">
                <p>Nice. Scan your shopping in to keep it that way.</p>
              </EmptyState>
            ) : (
              <>
                {/* Phone: horizontal cards. Desktop: a table. */}
                <ul className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 lg:hidden">
                  {shown.map((item) => {
                    const t = toneClasses[toneFor(item, me.today)];
                    const freezeOk = item.actions.freeze === null;
                    return (
                      <li
                        key={item.id}
                        className="w-[46%] min-w-40 shrink-0 snap-start"
                      >
                        <Card className="flex h-full flex-col gap-2 p-4">
                          <Pill className={`self-start ${t.pill}`}>
                            {dateLabel(item.bestBefore, me.today)}
                          </Pill>
                          <Link
                            to={`/stock/${item.id}`}
                            className="text-lg font-semibold leading-snug"
                          >
                            {item.productName}
                          </Link>
                          <p className="text-muted">
                            {item.locationName}
                            {item.state === "opened"
                              ? " · opened"
                              : item.remainingGrams !== null
                                ? ` · ${amountLabel(item)}`
                                : ""}
                          </p>
                          <Button
                            className="mt-auto bg-card-muted"
                            variant="outline"
                            onClick={() =>
                              freezeOk && item.state === "closed"
                                ? void actions.freeze(item)
                                : actions.use(item)
                            }
                          >
                            {freezeOk && item.state === "closed"
                              ? "Freeze it"
                              : "Use"}
                          </Button>
                        </Card>
                      </li>
                    );
                  })}
                </ul>
                <Card className="hidden overflow-hidden lg:block">
                  <table className="w-full text-left">
                    <thead className="text-sm text-muted">
                      <tr className="border-b border-line">
                        <th className="px-5 py-3 font-medium">Item</th>
                        <th className="px-3 py-3 font-medium">Where</th>
                        <th className="px-3 py-3 font-medium">Left</th>
                        <th className="px-3 py-3 font-medium">Best before</th>
                        <th className="px-5 py-3 text-right font-medium">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((item) => (
                        <tr
                          key={item.id}
                          className="border-b border-line last:border-b-0"
                        >
                          <td className="px-5 py-3 font-semibold">
                            <Link to={`/stock/${item.id}`}>
                              {item.productName}
                            </Link>
                          </td>
                          <td className="px-3 py-3 text-muted">
                            {item.locationName}
                            {item.state !== "closed"
                              ? ` · ${stateLabel[item.state]}`
                              : ""}
                          </td>
                          <td className="px-3 py-3 text-muted">
                            {amountLabel(item)}
                          </td>
                          <td className="px-3 py-3">
                            <Pill
                              className={
                                toneClasses[toneFor(item, me.today)].pill
                              }
                            >
                              {dateLabel(item.bestBefore, me.today)}
                            </Pill>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="dark"
                                onClick={() => actions.use(item)}
                              >
                                Use
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={item.actions.freeze !== null}
                                onClick={() => void actions.freeze(item)}
                              >
                                Freeze
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </>
            )}
          </section>
        </div>

        <aside
          className="mb-6 grid grid-cols-2 gap-3 lg:flex lg:flex-col lg:gap-4"
          aria-label="At a glance"
        >
          <Card className="p-5">
            <p className="text-muted">
              {target ? "Calories today" : "Today so far"}
            </p>
            <p className="mt-1 font-display text-4xl font-bold">
              {eatenKcal.toLocaleString("en-GB")}{" "}
              <span className="whitespace-nowrap font-sans text-lg font-normal text-muted">
                {target ? `of ${target.toLocaleString("en-GB")} kcal` : "kcal"}
              </span>
            </p>
            {(target ?? plannedKcal) > 0 && (
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-card-muted"
                role="img"
                aria-label={`${eatenKcal} of ${target ?? plannedKcal} ${target ? "target" : "planned"} calories`}
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{
                    width: `${Math.min(100, (eatenKcal / (target ?? plannedKcal)) * 100)}%`,
                  }}
                />
              </div>
            )}
            <p className="mt-2 text-[0.9375rem] text-muted">
              {avg7 !== null && (
                <span className="hidden sm:inline">
                  7-day average {avg7.toLocaleString("en-GB")} ·{" "}
                </span>
              )}
              <Link to="/dashboard" className="font-semibold text-accent-text">
                Dashboard
              </Link>
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-muted">Binned this month</p>
            <p className="mt-1 font-display text-4xl font-bold">
              {thisMonth
                ? weightLabel(thisMonth.grams).replace(/ (kg|g)$/, "")
                : "–"}{" "}
              <span className="font-sans text-lg font-normal text-muted">
                {thisMonth && thisMonth.grams >= 100 ? "kg" : "g"}
                {thisMonth?.pence ? ` · ${formatPence(thisMonth.pence)}` : ""}
              </span>
            </p>
            {wasteChange && (
              <p
                className={`mt-2 text-[0.9375rem] font-semibold ${waste!.changePercent! <= 0 ? "text-fresh-green-text" : "text-muted"}`}
              >
                {wasteChange}
              </p>
            )}
            <Link
              to="/waste"
              className="mt-1 inline-block text-[0.9375rem] font-semibold text-accent-text"
            >
              Waste report
            </Link>
          </Card>

          {low.length > 0 && (
            <Card className="col-span-2 flex items-center gap-4 p-5">
              <div className="flex-1">
                <p className="text-lg font-semibold">Running low</p>
                <p className="text-muted">
                  {low
                    .map((l) =>
                      l.daysLeft
                        ? `${l.name} (about ${l.daysLeft} day${l.daysLeft === 1 ? "" : "s"})`
                        : l.name,
                    )
                    .join(", ")}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  for (const l of low)
                    await api
                      .post("/api/shopping", {
                        ingredientId: l.ingredientId,
                        reason: "running-low",
                      })
                      .catch(() => {});
                  await qc.invalidateQueries({ queryKey: ["shopping"] });
                  toast.show("Added to the shopping list.");
                }}
                className="inline-flex min-h-11 items-center rounded-xl bg-strong px-4 font-semibold text-strong-ink"
              >
                Add to list
              </button>
            </Card>
          )}

          {unnamed.length > 0 && (
            <Card className="col-span-2 flex items-center gap-4 p-5">
              <div className="flex-1">
                <p className="text-lg font-semibold">
                  {unnamed.length === 1
                    ? "1 product needs a name"
                    : `${unnamed.length} products need a name`}
                </p>
                <p className="text-muted">
                  Name it once and everyone's phone will know it.
                </p>
              </div>
              <Link
                to="/products?unnamed=1"
                className="inline-flex min-h-11 items-center rounded-xl bg-strong px-4 font-semibold text-strong-ink"
              >
                Name them
              </Link>
            </Card>
          )}
          <ShoppingSummary />
        </aside>
      </div>
    </>
  );
}

/** This week's dinners, today first: what's planned, or a way to add one. */
function WeekDinners() {
  const me = useMe();
  const to = addDays(me.today, 6);
  const plan = usePlan(me.today, to, "me").data;
  if (!plan) return null;
  return (
    <section aria-labelledby="week-dinners" className="mb-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="week-dinners" className="text-2xl font-bold">
          This week's dinners
        </h2>
        <Link to="/plan" className="font-semibold text-accent-text">
          Open planner
        </Link>
      </div>
      <ul className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-7 lg:px-0">
        {plan.days.map((d) => {
          const dinner = d.entries.find(
            (e) => e.slot === "dinner" && e.status !== "skipped",
          );
          const day = new Date(`${d.date}T12:00:00Z`)
            .toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })
            .toUpperCase();
          const isToday = d.date === me.today;
          return (
            <li key={d.date} className="w-28 shrink-0 lg:w-auto">
              <Link
                to={
                  dinner
                    ? `/plan?date=${d.date}`
                    : `/plan?date=${d.date}&add=dinner`
                }
                aria-label={`${dayName(d.date, me.today)}: ${dinner ? dinner.title : "nothing planned, add a dinner"}`}
                className={`flex h-full min-h-28 flex-col gap-1 rounded-2xl border bg-card p-3 ${isToday ? "border-accent" : "border-line"}`}
              >
                <span className="text-xs font-semibold tracking-wider text-muted">
                  {day}
                </span>
                {dinner ? (
                  <>
                    <span className="line-clamp-3 break-words font-semibold leading-snug">
                      {dinner.title}
                    </span>
                    <span className="text-xs text-muted">
                      {dinner.status === "cooked"
                        ? "Eaten"
                        : isToday
                          ? "Tonight"
                          : (dinner.detail ?? "")}
                    </span>
                  </>
                ) : (
                  <span className="font-semibold text-accent-text">+ Add</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The shopping list at a glance: how many things, roughly what it'll cost, and the first few. */
function ShoppingSummary() {
  const me = useMe();
  const items = (useShopping().data ?? []).filter((i) => !i.checked);
  if (!items.length) return null;
  const pricing = me.household.settings.pricingEnabled;
  const priced = items.filter((i) => i.pricePence !== null);
  const total = priced.reduce((s, i) => s + i.pricePence!, 0);
  return (
    <Card className="col-span-2 hidden p-5 lg:block">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Shopping list</h2>
        <span className="text-[0.9375rem] text-muted">
          {items.length} {items.length === 1 ? "thing" : "things"}
          {pricing && priced.length ? ` · about ${formatPence(total)}` : ""}
        </span>
      </div>
      <ul>
        {items.slice(0, 5).map((i) => (
          <li
            key={i.id}
            className="flex justify-between gap-3 border-b border-line py-2.5 last:border-b-0"
          >
            <span className="min-w-0 truncate">{itemTitle(i)}</span>
            {pricing && i.pricePence !== null && (
              <span className="tabular-nums text-muted">
                {formatPence(i.pricePence)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Link
        to="/shop"
        className="mt-1 inline-flex min-h-11 items-center font-semibold text-accent-text"
      >
        Open list
      </Link>
    </Card>
  );
}

/** "Tonight · 6pm: Fish pie" with Cooked it / Skip / Move. */
function TonightCard({ entry }: { entry: PlanEntryDto }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const recipe = useRecipes().data?.find((r) => r.id === entry.recipeId);
  const label =
    entry.slot === "dinner"
      ? "Tonight · 6pm"
      : entry.slot === "lunch"
        ? "Lunch · 12:30"
        : entry.slot === "breakfast"
          ? "Breakfast"
          : "Today";
  const skip = async () => {
    await api.patch(`/api/plan/${entry.id}`, { status: "skipped" });
    await qc.invalidateQueries({ queryKey: ["plan"] });
    toast.show("Skipped.", {
      action: {
        label: "Undo",
        onClick: async () =>
          void (
            await api.patch(`/api/plan/${entry.id}`, { status: "planned" }),
            await qc.invalidateQueries({ queryKey: ["plan"] })
          ),
      },
    });
  };
  return (
    <section
      className="mb-6 rounded-[24px] bg-hero p-6 text-white lg:flex lg:items-center lg:gap-6"
      aria-label="Today's meal"
    >
      <div className="lg:flex-1">
        <div className="mb-2 flex justify-between text-sm font-semibold uppercase tracking-wider">
          <span className="text-[#b4a6ff]">{label}</span>
          {entry.people.length > 0 && (
            <span className="normal-case tracking-normal text-white/70">
              {entry.people.map((p) => p.name).join(" + ")}
            </span>
          )}
        </div>
        <h2 className="text-3xl font-bold">{entry.title}</h2>
        <p className="mt-1 text-white/75">
          {[
            `Serves ${entry.servings}`,
            minutesLabel(recipe?.totalMinutes ?? null),
            entry.kcalPerServing ? `${entry.kcalPerServing} kcal each` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="mt-5 flex gap-3 lg:mt-0">
        <button
          type="button"
          onClick={() =>
            navigate(
              `/recipes/${entry.recipeId}/cook?servings=${entry.servings}&entry=${entry.id}`,
            )
          }
          className="min-h-14 flex-1 rounded-xl bg-accent px-6 text-lg font-semibold text-accent-ink lg:min-h-12 lg:flex-none"
        >
          Cooked it
        </button>
        <button
          type="button"
          onClick={() => void skip()}
          className="min-h-14 rounded-xl border border-white/25 px-5 text-lg font-semibold lg:min-h-12"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={() => navigate(`/plan?entry=${entry.id}&date=${entry.date}`)}
          className="min-h-14 rounded-xl border border-white/25 px-5 text-lg font-semibold lg:min-h-12"
        >
          Move
        </button>
      </div>
    </section>
  );
}
