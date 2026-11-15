/**
 * Settings → Shopping staples: the foods the household always wants in, each with the level to
 * keep. Below its level a staple puts itself on the shopping list. Staples are made from the
 * stock side panel; here their levels are changed (click a row) or they're taken off.
 */
import type { StapleDto } from '@snackoverflow/shared';
import { Link } from 'react-router';
import { type Column, DataTable } from '../components/DataTable';
import { MenuButton } from '../components/Layout';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { stapleAmount, StapleSettings, useStaples } from '../components/StapleSettings';
import { PageTop } from '../components/Toolbar';
import { EmptyState, ErrorNote, Pill, Spinner } from '../components/ui';

function Status({ s }: { s: StapleDto }) {
  if (!s.low) return <span className="text-muted">Enough in</span>;
  return <Pill className="bg-accent-soft text-accent-text">{s.onList ? 'Low · on the list' : 'Low'}</Pill>;
}

export function StaplesPage() {
  const staples = useStaples();
  const [openId, openPanel, closePanel] = usePanelParam();
  const open = staples.data?.find((s) => s.id === openId);

  const columns: Column<StapleDto>[] = [
    { key: 'name', header: 'Food', primary: true, cell: (s) => s.name },
    { key: 'min', header: 'Keep at least', align: 'right', className: 'whitespace-nowrap tabular-nums', cell: (s) => stapleAmount(s, s.min) },
    { key: 'have', header: 'In stock', align: 'right', className: 'whitespace-nowrap tabular-nums', cell: (s) => (s.have > 0 ? stapleAmount(s, s.have) : 'None') },
    { key: 'status', header: 'Now', className: 'whitespace-nowrap', cell: (s) => <Status s={s} /> },
  ];

  return (
    <div className="max-w-3xl">
      <PageTop title="Shopping staples" subtitle={staples.data ? `${staples.data.length}` : undefined} left={<MenuButton />} />
      <p className="mb-4 text-sm text-muted">
        Food you always want in. When there's less than its level in stock, it goes on the shopping list by itself. To add one, open a food in{' '}
        <Link to="/stock" className="font-semibold text-accent-text hover:underline">
          Stock
        </Link>{' '}
        and switch on Shopping staple.
      </p>
      {staples.isPending ? (
        <Spinner />
      ) : staples.error ? (
        <ErrorNote error={staples.error} />
      ) : (
        <DataTable
          label="Shopping staples"
          columns={columns}
          rows={staples.data}
          rowKey={(s) => s.id}
          onOpen={(s) => openPanel(s.id)}
          openLabel={(s) => `${s.name}: change its level`}
          activeKey={openId}
          phone={(s) => ({
            title: s.name,
            meta: `Keep at least ${stapleAmount(s, s.min)} · ${s.have > 0 ? `${stapleAmount(s, s.have)} in stock` : 'none in stock'}`,
            badge: s.low ? <Status s={s} /> : undefined,
          })}
          empty={<EmptyState title="No staples yet">Open a food in Stock and switch on Shopping staple. Milk, bread, eggs: whatever you never want to run out of.</EmptyState>}
        />
      )}
      <SidePanel open={Boolean(open)} onClose={closePanel} title={open?.name ?? 'Staple'} subtitle="Shopping staple">
        {open && <StapleSettings key={open.id} staple={open} />}
      </SidePanel>
    </div>
  );
}
