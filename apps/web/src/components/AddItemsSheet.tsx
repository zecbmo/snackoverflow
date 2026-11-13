/**
 * Add stock by hand, several things at once, without a barcode: type a food and press Enter (with
 * the same suggestions as the shopping list), set how many and where, then add them all. Not tied
 * to the shopping list. Best-before dates are estimated as usual unless one is set.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { StockChangeDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { useIngredients, useLocations, useProducts } from '../lib/queries';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { Button, Select, Sheet, TextInput } from './ui';

type Row = {
  key: number;
  label: string;
  productId?: string;
  ingredientId?: string;
  text?: string;
  count: number;
  /** '' = its usual place. */
  locationId: string;
  bestBefore: string;
};

let nextKey = 1;

export function AddItemsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ingredients = useIngredients().data ?? [];
  const products = (useProducts('').data ?? []).filter((p) => p.name && !p.isMeal);
  const locations = useLocations().data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const t = text.trim().toLowerCase();
  const product = t ? products.find((p) => p.name!.toLowerCase() === t) : undefined;
  const ingredient = t && !product ? ingredients.find((i) => i.name.toLowerCase() === t) : undefined;
  const suggestions =
    t.length >= 2 && !product && !ingredient
      ? [
          ...products.filter((p) => p.name!.toLowerCase().includes(t)).map((p) => ({ key: `p${p.id}`, label: p.name!, productId: p.id })),
          ...ingredients.filter((i) => i.name.toLowerCase().includes(t)).map((i) => ({ key: `i${i.id}`, label: i.name, ingredientId: i.id })),
        ]
          // One suggestion per name: a product you've bought wins over the plain food of the same name.
          .filter((x, i, all) => all.findIndex((y) => y.label.toLowerCase() === x.label.toLowerCase()) === i)
          .slice(0, 8)
      : [];

  const push = (r: Omit<Row, 'key' | 'count' | 'locationId' | 'bestBefore'>) => {
    setRows((rs) => [...rs, { ...r, key: nextKey++, count: 1, locationId: '', bestBefore: '' }]);
    setText('');
  };
  const addTyped = () => {
    if (!text.trim()) return;
    if (product) push({ label: product.name!, productId: product.id });
    else if (ingredient) push({ label: ingredient.name, ingredientId: ingredient.id });
    else push({ label: text.trim(), text: text.trim() });
  };
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const total = rows.reduce((n, r) => n + r.count, 0);

  const save = async () => {
    setBusy(true);
    try {
      const changes = await api.post<StockChangeDto[]>('/api/stock/add-many', {
        items: rows.map((r) => ({
          ...(r.productId ? { productId: r.productId } : r.ingredientId ? { ingredientId: r.ingredientId } : { text: r.text }),
          count: r.count,
          ...(r.locationId ? { locationId: r.locationId } : {}),
          ...(r.bestBefore ? { bestBefore: r.bestBefore } : {}),
        })),
      });
      await qc.invalidateQueries({ queryKey: ['stock'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      toast.show(`Added ${changes.length} to stock.`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            for (const c of [...changes].reverse()) await api.post(`/api/events/${c.eventId}/undo`).catch(() => {});
            await qc.invalidateQueries({ queryKey: ['stock'] });
          },
        },
      });
      setRows([]);
      onClose();
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add items" wide>
      <p className="mb-3 text-sm text-muted">Type what you're putting away and press Enter. Dates are estimated unless you set one.</p>
      {rows.length > 0 && (
        <div className="mb-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm" aria-label="Items to add">
            <thead>
              <tr className="border-b border-line bg-card-muted/60 text-left text-xs text-muted">
                <th scope="col" className="h-8 px-3 font-medium">
                  Item
                </th>
                <th scope="col" className="h-8 px-3 font-medium">
                  Packs
                </th>
                <th scope="col" className="h-8 px-3 font-medium">
                  Where
                </th>
                <th scope="col" className="h-8 px-3 font-medium">
                  Best before
                </th>
                <th scope="col" className="h-8 px-3">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-1.5 font-semibold">
                    {r.label}
                    {r.text && <span className="block text-xs font-normal text-muted">New: remembered from now on</span>}
                  </td>
                  <td className="w-20 px-3 py-1.5">
                    <TextInput
                      aria-label={`Packs of ${r.label}`}
                      inputMode="numeric"
                      value={String(r.count)}
                      onChange={(e) => set(r.key, { count: Math.max(1, Math.min(50, Number(e.target.value.replace(/\D/g, '')) || 1)) })}
                      className="text-center"
                    />
                  </td>
                  <td className="w-40 px-3 py-1.5">
                    <Select aria-label={`Where ${r.label} goes`} value={r.locationId} onChange={(e) => set(r.key, { locationId: e.target.value })}>
                      <option value="">Usual place</option>
                      {locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="w-40 px-3 py-1.5">
                    <TextInput type="date" aria-label={`Best before for ${r.label}`} value={r.bestBefore} onChange={(e) => set(r.key, { bestBefore: e.target.value })} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${r.label}`}
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                      className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink lg:size-7 lg:rounded-md"
                    >
                      <Icon name="close" className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          addTyped();
        }}
      >
        <label className="flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-line bg-card px-3 focus-within:border-solid focus-within:border-accent lg:min-h-9 lg:rounded-md lg:px-2.5">
          <Icon name="plus" className="size-4 shrink-0 text-muted" />
          <span className="sr-only">Add an item</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add an item and press Enter"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted lg:text-sm"
          />
        </label>
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Suggestions">
            {suggestions.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => push({ label: s.label, ...('productId' in s ? { productId: s.productId } : { ingredientId: s.ingredientId }) })}
                className="min-h-10 rounded-full border border-line bg-card px-3 text-sm hover:bg-card-muted lg:min-h-7"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </form>
      <Button variant="primary" className="w-full" disabled={busy || rows.length === 0} onClick={() => void save()}>
        {busy ? 'Adding…' : rows.length ? `Add ${total} to stock` : 'Add to stock'}
      </Button>
    </Sheet>
  );
}
