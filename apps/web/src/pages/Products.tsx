import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatPackSize, type ProductDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, EmptyState, ErrorNote, PageHeader, Sheet, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useProducts } from '../lib/queries';
import { ProductForm } from './ProductForm';

function packLabel(p: ProductDto): string | null {
  return formatPackSize(p.packAmount, p.packUnit) || null;
}

export function ProductsPage() {
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [unnamed, setUnnamed] = useState(params.get('unnamed') === '1');
  const [adding, setAdding] = useState(false);
  const products = useProducts(q.trim(), unnamed);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const chip = (active: boolean) =>
    `min-h-11 rounded-full border px-4 text-[15px] font-semibold ${active ? 'border-ink bg-ink text-bg' : 'border-line bg-card text-ink'}`;

  return (
    <>
      <PageHeader
        title="Products"
        left={<MenuButton />}
        right={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" className="size-5" /> Add
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        <label className="relative block">
          <span className="sr-only">Search products</span>
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, brand or barcode" className="pl-10" />
        </label>
        <div className="flex gap-2">
          <button type="button" aria-pressed={!unnamed} className={chip(!unnamed)} onClick={() => setUnnamed(false)}>
            All
          </button>
          <button type="button" aria-pressed={unnamed} className={chip(unnamed)} onClick={() => setUnnamed(true)}>
            Needs a name
          </button>
        </div>
      </div>
      {products.isPending ? (
        <Spinner />
      ) : products.error ? (
        <ErrorNote error={products.error} />
      ) : products.data.length === 0 ? (
        <EmptyState title={unnamed ? 'Everything has a name' : 'No products yet'}>
          {unnamed ? 'Nice and tidy.' : 'Scan something in, or add a product by hand.'}
        </EmptyState>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {products.data.map((p) => {
            const meta = [p.brand, p.ingredientName, packLabel(p)].filter(Boolean).join(' · ');
            return (
              <Link key={p.id} to={`/products/${p.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-card-muted">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-semibold ${p.name ? '' : 'text-muted'}`}>{p.name ?? 'Unnamed product'}</span>
                  <span className="block truncate text-sm text-muted">{p.name ? meta || 'No details yet' : (p.barcodes[0] ?? 'No barcode')}</span>
                </span>
                <Icon name="chevronRight" className="size-5 text-muted" />
              </Link>
            );
          })}
        </Card>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add product">
        <ProductForm
          showCategory
          submitLabel="Add product"
          onSubmit={async (input) => {
            const p = await api.post<ProductDto>('/api/products', input);
            await qc.invalidateQueries({ queryKey: ['products'] });
            setAdding(false);
            toast.show(`Added ${p.name ?? 'the product'}.`);
            navigate(`/products/${p.id}`);
          }}
        />
      </Sheet>
    </>
  );
}
