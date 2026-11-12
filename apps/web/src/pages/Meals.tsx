/** Batch cooks and leftovers: cooked meals in stock (with the usual row actions), and recent cooks, which can be undone. */
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { StockItemDto } from '@snackoverflow/shared';
import { type Column, DataTable } from '../components/DataTable';
import { MenuButton, useMe } from '../components/Layout';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { StockItemDetail } from '../components/StockItemDetail';
import { StockRowActions } from '../components/StockRowActions';
import { useToast } from '../components/Toast';
import { PageTop } from '../components/Toolbar';
import { Button, EmptyState, Pill, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { amountLabel, dateLabel, toneClasses, toneFor } from '../lib/format';
import { type CookRow, useCooks, useStock, useStockItem } from '../lib/queries';

export function MealsPage() {
  const me = useMe();
  const stock = useStock();
  const cooks = useCooks();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [openId, openPanel, closePanel] = usePanelParam();
  const panelItem = useStockItem(openId ?? '').data?.item;
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

  const pill = (m: StockItemDto) => <Pill className={toneClasses[toneFor(m, me.today)].pill}>{dateLabel(m.bestBefore, me.today)}</Pill>;
  const columns: Column<StockItemDto>[] = [
    { key: 'status', header: <span className="sr-only">Freshness</span>, className: 'w-6 pr-0', cell: (m) => <span aria-hidden className={`inline-block size-2 rounded-full ${toneClasses[toneFor(m, me.today)].dot}`} /> },
    { key: 'name', header: 'Meal', primary: true, cell: (m) => m.productName },
    { key: 'where', header: 'Where', cell: (m) => m.locationName },
    { key: 'left', header: 'Left', className: 'whitespace-nowrap', cell: (m) => amountLabel(m) },
    { key: 'date', header: 'Use by', className: 'whitespace-nowrap', cell: pill },
  ];
  const cookDate = (c: CookRow) => new Date(c.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const undoButton = (c: CookRow) =>
    c.undoneAt ? (
      <span className="text-xs text-muted">Undone</span>
    ) : (
      <Button size="xs" variant="ghost" onClick={() => void undo(c.id)}>
        Undo cook
      </Button>
    );
  const cookColumns: Column<CookRow>[] = [
    {
      key: 'title',
      header: 'Recipe',
      cell: (c) => (
        <span className={c.undoneAt ? 'text-muted line-through' : 'font-semibold text-ink'}>
          {c.recipeId ? (
            <Link to={`/recipes/${c.recipeId}`} className="hover:underline">
              {c.title ?? 'Recipe'}
            </Link>
          ) : (
            (c.title ?? 'Recipe')
          )}
        </span>
      ),
    },
    { key: 'servings', header: 'Servings', align: 'right', className: 'tabular-nums', cell: (c) => c.servings },
    { key: 'when', header: 'Cooked', cell: cookDate },
  ];

  return (
    <>
      <PageTop title="Batch cooks & leftovers" left={<MenuButton />} />
      {stock.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Cooked meals in stock"
          columns={columns}
          rows={meals}
          rowKey={(m) => m.id}
          onOpen={(m) => openPanel(m.id)}
          openLabel={(m) => `${m.productName}, details`}
          activeKey={openId}
          actions={(m) => <StockRowActions item={m} name={m.productName} onDetails={() => openPanel(m.id)} />}
          phone={(m) => ({
            lead: <span aria-hidden className={`h-10 w-1 shrink-0 rounded-full ${toneClasses[toneFor(m, me.today)].bar}`} />,
            title: m.productName,
            meta: `${m.locationName} · ${amountLabel(m)}`,
            badge: pill(m),
            actions: <StockRowActions item={m} name={m.productName} onDetails={() => openPanel(m.id)} compact />,
          })}
          empty={
            <EmptyState title="No leftovers or portions">
              <p>
                Cook a{' '}
                <button type="button" onClick={() => navigate('/recipes')} className="font-semibold text-accent-text">
                  recipe
                </button>{' '}
                and keep the leftovers, or batch cook one for the freezer.
              </p>
            </EmptyState>
          }
        />
      )}
      {cooks.data && cooks.data.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 font-bold">Recently cooked</h2>
          <DataTable
            label="Recently cooked"
            columns={cookColumns}
            rows={cooks.data}
            rowKey={(c) => c.id}
            actions={undoButton}
            phone={(c) => ({
              title: <span className={c.undoneAt ? 'text-muted line-through' : ''}>{c.title ?? 'Recipe'}</span>,
              meta: `${c.servings} servings · ${cookDate(c)}`,
              badge: undoButton(c),
            })}
          />
        </section>
      )}
      <SidePanel open={Boolean(openId)} onClose={closePanel} title={panelItem?.productName ?? 'Loading…'}>
        {openId && <StockItemDetail id={openId} onOpenPack={openPanel} />}
      </SidePanel>
    </>
  );
}
