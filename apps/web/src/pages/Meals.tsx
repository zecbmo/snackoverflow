import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, EmptyState, PageHeader, Pill, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { amountLabel, dateLabel, toneClasses, toneFor } from '../lib/format';
import { useCooks, useStock } from '../lib/queries';
import { StockActionsRow } from './Stock';

/** Batch cooks and leftovers: cooked meals in stock, and recent cooks (which can be undone). */
export function MealsPage() {
  const me = useMe();
  const stock = useStock();
  const cooks = useCooks();
  const qc = useQueryClient();
  const toast = useToast();
  const meals = (stock.data ?? []).filter((s) => s.isMeal);

  const undo = async (id: string) => {
    try {
      await api.post(`/api/cooks/${id}/undo`, {});
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show('Cook undone. Everything is back in stock.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <>
      <PageHeader title="Batch cooks & leftovers" left={<MenuButton />} />
      {stock.isPending ? (
        <Spinner />
      ) : meals.length === 0 ? (
        <EmptyState title="No leftovers or portions">
          <p>
            Cook a{' '}
            <Link to="/recipes" className="font-semibold text-accent-text">
              recipe
            </Link>{' '}
            and keep the leftovers, or batch cook one for the freezer.
          </p>
        </EmptyState>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {meals.map((m) => (
            <li key={m.id}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <Link to={`/stock/${m.id}`} className="flex-1">
                    <span className="block text-lg font-semibold">{m.productName}</span>
                    <span className="block text-muted">
                      {m.locationName} · {amountLabel(m)}
                    </span>
                  </Link>
                  <Pill className={toneClasses[toneFor(m, me.today)].pill}>{dateLabel(m.bestBefore, me.today)}</Pill>
                </div>
                <StockActionsRow item={m} />
              </Card>
            </li>
          ))}
        </ul>
      )}
      {cooks.data && cooks.data.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-bold">Recently cooked</h2>
          <Card className="p-2">
            <ul>
              {cooks.data.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <span className={`flex-1 ${c.undoneAt ? 'text-muted line-through' : ''}`}>
                    {c.recipeId ? (
                      <Link to={`/recipes/${c.recipeId}`} className="font-medium">
                        {c.title ?? 'Recipe'}
                      </Link>
                    ) : (
                      (c.title ?? 'Recipe')
                    )}{' '}
                    <span className="text-sm text-muted">
                      · {c.servings} servings · {new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  </span>
                  {!c.undoneAt && (
                    <Button size="sm" variant="ghost" onClick={() => void undo(c.id)}>
                      Undo
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </>
  );
}
