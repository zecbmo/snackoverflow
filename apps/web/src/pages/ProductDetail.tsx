import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ProductDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { BackButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Pill, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { amountLabel, dateLabel, toneClasses, toneFor } from '../lib/format';
import { useLocations, useProduct, useProductStock, useProducts } from '../lib/queries';
import { ProductForm } from './ProductForm';

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const product = useProduct(id);
  const packs = useProductStock(id);
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [merging, setMerging] = useState(false);

  if (product.isPending) return <Spinner />;
  if (product.error) return <ErrorNote error={product.error} />;
  const p = product.data;
  const inStock = packs.data ?? [];

  const remove = async () => {
    try {
      await api.del(`/api/products/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['products'] });
      toast.show('Product deleted.');
      navigate('/products');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <>
      <PageHeader title={p.name ?? 'Unnamed product'} subtitle={p.brand ?? undefined} left={<BackButton to="/products" />} />
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card className="p-5">
          <h2 className="mb-4 text-lg font-bold">Details</h2>
          <ProductForm
            key={p.id}
            product={p}
            showCategory
            submitLabel="Save changes"
            onSubmit={async (input) => {
              await api.patch<ProductDto>(`/api/products/${p.id}`, input);
              await Promise.all([qc.invalidateQueries({ queryKey: ['products'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
              toast.show('Saved.');
            }}
          />
        </Card>
        <div className="flex flex-col gap-5">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">In stock</h2>
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <Icon name="plus" className="size-4" /> Add a pack
              </Button>
            </div>
            {inStock.length === 0 ? (
              <p className="text-muted">None in stock.</p>
            ) : (
              <ul className="divide-y divide-line">
                {inStock.map((s) => {
                  const tone = toneClasses[toneFor(s, me.today)];
                  return (
                    <li key={s.id}>
                      <Link to={`/stock/${s.id}`} className="flex min-h-14 items-center gap-3 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{s.locationName}</span>
                          <span className="block text-sm text-muted">
                            {s.state} · {amountLabel(s)}
                          </span>
                        </span>
                        <Pill className={tone.pill}>{dateLabel(s.bestBefore, me.today)}</Pill>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card className="p-5">
            <h2 className="mb-2 text-lg font-bold">Best-before</h2>
            <p className="text-muted">
              {p.learnedClosedDays !== null ? `Learned: usually ${p.learnedClosedDays} days.` : 'Estimated from its ingredient or category.'}
              {p.learnedFrozenDays !== null && ` In the freezer: about ${p.learnedFrozenDays} days.`}
            </p>
            <p className="mt-2 text-sm text-muted">Change a pack's date and the app learns it for next time.</p>
          </Card>
          <Card className="flex flex-col gap-3 p-5">
            <h2 className="text-lg font-bold">Tidy up</h2>
            <Button onClick={() => setMerging(true)}>Merge into another product…</Button>
            <Button variant="danger" disabled={inStock.length > 0} onClick={() => void remove()}>
              <Icon name="trash" className="size-5" /> Delete product
            </Button>
            {inStock.length > 0 && <p className="text-sm text-muted">Use or bin what's in stock before deleting.</p>}
          </Card>
        </div>
      </div>
      <AddPackSheet open={adding} onClose={() => setAdding(false)} productId={p.id} />
      <MergeSheet open={merging} onClose={() => setMerging(false)} product={p} />
    </>
  );
}

function AddPackSheet({ open, onClose, productId }: { open: boolean; onClose: () => void; productId: string }) {
  const locations = useLocations().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [locationId, setLocationId] = useState('');
  const [count, setCount] = useState('1');
  const [bestBefore, setBestBefore] = useState('');
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const n = Math.max(1, Math.min(50, Math.round(Number(count) || 1)));
      await api.post('/api/stock', { productId, locationId: locationId || locations[0]?.id, count: n, bestBefore: bestBefore || null });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      toast.show(n === 1 ? 'Added a pack.' : `Added ${n} packs.`);
      setBestBefore('');
      setCount('1');
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add a pack">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Where">
          {(id) => (
            <Select id={id} value={locationId || locations[0]?.id || ''} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="How many packs">
          {(id) => <TextInput id={id} type="number" min={1} max={50} value={count} onChange={(e) => setCount(e.target.value)} />}
        </Field>
        <Field label="Best-before" hint="Leave empty and we'll estimate it.">
          {(id) => <TextInput id={id} type="date" value={bestBefore} onChange={(e) => setBestBefore(e.target.value)} />}
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" size="lg" disabled={locations.length === 0}>
          Add to stock
        </Button>
      </form>
    </Sheet>
  );
}

function MergeSheet({ open, onClose, product }: { open: boolean; onClose: () => void; product: ProductDto }) {
  const [q, setQ] = useState('');
  const results = useProducts(q.trim()).data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const merge = async (into: ProductDto) => {
    try {
      await api.post(`/api/products/${product.id}/merge`, { intoId: into.id });
      await Promise.all([qc.invalidateQueries({ queryKey: ['products'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
      toast.show(`Merged into ${into.name ?? 'the other product'}.`);
      onClose();
      navigate(`/products/${into.id}`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Merge into…">
      <p className="mb-3 text-muted">Its barcodes and stock move to the product you pick, then this one is removed.</p>
      <Field label="Find the product">
        {(id) => <TextInput id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />}
      </Field>
      <ul className="mt-3 flex flex-col gap-2">
        {results
          .filter((r) => r.id !== product.id)
          .slice(0, 20)
          .map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => void merge(r)} className="flex min-h-12 w-full items-center rounded-xl border border-line px-4 text-left hover:bg-card-muted">
                <span className="flex-1 truncate font-medium">{r.name ?? 'Unnamed product'}</span>
                {r.brand && <span className="text-sm text-muted">{r.brand}</span>}
              </button>
            </li>
          ))}
      </ul>
    </Sheet>
  );
}
