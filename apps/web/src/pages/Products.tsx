/** Every product the household has scanned or added: what it is, its pack size, barcodes and price. */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { formatPackSize, formatPence, type ProductDto } from '@snackoverflow/shared';
import { type Column, DataTable } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { Menu, PickerMenu } from '../components/Menu';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { useToast } from '../components/Toast';
import { PageTop, SearchBox, Toolbar } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Sheet, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useProduct, useProducts } from '../lib/queries';
import { ProductDetail } from './ProductDetail';
import { ProductForm } from './ProductForm';

function packLabel(p: ProductDto): string {
  return formatPackSize(p.packAmount, p.packUnit) || '';
}

export function ProductsPage() {
  const me = useMe();
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [show, setShow] = useState<'all' | 'unnamed'>(params.get('unnamed') === '1' ? 'unnamed' : 'all');
  const [adding, setAdding] = useState(false);
  const products = useProducts(q.trim(), show === 'unnamed');
  const [openId, openPanel, closePanel] = usePanelParam();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const pricing = me.household.settings.pricingEnabled;

  const columns: Column<ProductDto>[] = [
    { key: 'name', header: 'Name', primary: true, className: 'max-w-[20rem]', cell: (p) => <span className={p.name ? '' : 'text-muted'}>{p.name ?? 'Unnamed product'}</span> },
    { key: 'brand', header: 'Brand', cell: (p) => p.brand ?? '' },
    { key: 'ingredient', header: 'Ingredient', cell: (p) => p.ingredientName ?? <span className="text-fresh-amber-text">Not linked</span> },
    { key: 'pack', header: 'Pack', className: 'whitespace-nowrap', cell: packLabel },
    { key: 'barcode', header: 'Barcode', className: 'whitespace-nowrap tabular-nums', cell: (p) => (p.barcodes.length ? `${p.barcodes[0]}${p.barcodes.length > 1 ? ` +${p.barcodes.length - 1}` : ''}` : '') },
  ];
  if (pricing) columns.push({ key: 'price', header: 'Price', align: 'right', className: 'tabular-nums', cell: (p) => (p.pricePence !== null ? formatPence(p.pricePence) : '') });

  return (
    <>
      <PageTop
        title="Products"
        subtitle={products.data ? `${products.data.length}` : undefined}
        left={<MenuButton />}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" className="size-4" /> Add product
          </Button>
        }
      />
      <Toolbar search={<SearchBox value={q} onChange={setQ} placeholder="Name, brand or barcode" label="Search products" />}>
        <PickerMenu
          label="Filter"
          icon="filter"
          value={show}
          defaultValue="all"
          onChange={setShow}
          options={[
            { value: 'all', label: 'All products' },
            { value: 'unnamed', label: 'Needs a name' },
          ]}
        />
      </Toolbar>
      <ErrorNote error={products.error} />
      {products.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Products"
          columns={columns}
          rows={products.data ?? []}
          rowKey={(p) => p.id}
          onOpen={(p) => openPanel(p.id)}
          openLabel={(p) => p.name ?? 'Unnamed product'}
          activeKey={openId}
          actions={(p) => (
            <Menu
              label={`More for ${p.name ?? 'this product'}`}
              items={[
                { label: 'Edit', icon: 'edit', onSelect: () => openPanel(p.id) },
                { label: 'Open full page', icon: 'external', onSelect: () => navigate(`/products/${p.id}`) },
              ]}
            />
          )}
          phone={(p) => ({
            title: <span className={p.name ? '' : 'text-muted'}>{p.name ?? 'Unnamed product'}</span>,
            meta: p.name ? [p.brand, p.ingredientName, packLabel(p)].filter(Boolean).join(' · ') || 'No details yet' : (p.barcodes[0] ?? 'No barcode'),
            badge: pricing && p.pricePence !== null ? <span className="text-sm text-muted">{formatPence(p.pricePence)}</span> : <Icon name="chevronRight" className="size-4 text-muted" />,
          })}
          empty={
            <EmptyState title={show === 'unnamed' ? 'Everything has a name' : q ? 'Nothing matches' : 'No products yet'}>
              {show === 'unnamed' ? 'Nice and tidy.' : q ? 'Try a different word or barcode.' : 'Scan something in, or add a product by hand.'}
            </EmptyState>
          }
        />
      )}
      <ProductPanel id={openId} onClose={closePanel} />
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add product">
        <ProductForm
          showCategory
          submitLabel="Add product"
          onSubmit={async (input) => {
            const p = await api.post<ProductDto>('/api/products', input);
            await qc.invalidateQueries({ queryKey: ['products'] });
            setAdding(false);
            toast.show(`Added ${p.name ?? 'the product'}.`);
            openPanel(p.id);
          }}
        />
      </Sheet>
    </>
  );
}

function ProductPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const p = useProduct(id ?? '').data;
  return (
    <SidePanel open={Boolean(id)} onClose={onClose} title={p ? (p.name ?? 'Unnamed product') : 'Loading…'} subtitle={p?.brand ?? undefined}>
      {id && <ProductDetail id={id} stacked onDeleted={onClose} />}
    </SidePanel>
  );
}
