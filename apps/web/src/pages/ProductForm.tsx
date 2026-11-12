/** The product fields, shared by "Add product" and the product screen. */
import { type FormEvent, useState } from 'react';
import { FOOD_GROUPS, type ProductDto, type ProductInput } from '@snackoverflow/shared';
import { Button, ErrorNote, Field, Select, TextInput } from '../components/ui';
import { useIngredients, useShelfLife } from '../lib/queries';

const PACK_UNITS = [
  ['g', 'g'],
  ['kg', 'kg'],
  ['ml', 'ml'],
  ['l', 'litres'],
  ['count', 'items'],
] as const;

export function ProductForm({
  product,
  showCategory = false,
  submitLabel,
  onSubmit,
}: {
  product?: ProductDto;
  showCategory?: boolean;
  submitLabel: string;
  onSubmit: (input: ProductInput) => Promise<void>;
}) {
  const ingredients = useIngredients().data ?? [];
  const categories = useShelfLife().data ?? [];
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [packAmount, setPackAmount] = useState(product?.packAmount != null ? String(product.packAmount) : '');
  const [packUnit, setPackUnit] = useState(product?.packUnit ?? 'g');
  const [ingredientId, setIngredientId] = useState(product?.ingredientId ?? '');
  const [categoryId, setCategoryId] = useState(product?.shelfLifeCategoryId ?? '');
  const [foodGroup, setFoodGroup] = useState(product?.ownFoodGroup ?? '');
  const ingredientGroup = ingredients.find((i) => i.id === ingredientId)?.foodGroup ?? null;
  const [codes, setCodes] = useState(product?.barcodes.join(', ') ?? '');
  const [itemGrams, setItemGrams] = useState(product?.portionGrams != null ? String(product.portionGrams) : '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const amount = packAmount.trim() === '' ? null : Number(packAmount);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      setError(new Error('Pack size must be a number.'));
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        name,
        brand: brand.trim() || null,
        packAmount: amount,
        packUnit: amount === null ? null : packUnit,
        portionGrams: itemGrams.trim() === '' ? null : Number(itemGrams),
        ingredientId: ingredientId || null,
        ...(showCategory ? { shelfLifeCategoryId: categoryId || null } : {}),
        foodGroup: (foodGroup || null) as ProductInput['foodGroup'],
        barcodes: codes
          .split(/[\s,]+/)
          .map((c) => c.trim())
          .filter(Boolean),
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const knownUnit = PACK_UNITS.some(([u]) => u === packUnit);
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Name">{(id) => <TextInput id={id} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Semi-skimmed milk" />}</Field>
      <Field label="Brand">{(id) => <TextInput id={id} value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Optional" />}</Field>
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field label="Pack size">
          {(id) => <TextInput id={id} inputMode="decimal" value={packAmount} onChange={(e) => setPackAmount(e.target.value)} placeholder="e.g. 500" />}
        </Field>
        <Field label="Unit">
          {(id) => (
            <Select id={id} value={packUnit} onChange={(e) => setPackUnit(e.target.value)}>
              {!knownUnit && <option value={packUnit}>{packUnit}</option>}
              {PACK_UNITS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="One item weighs (g)" hint="For multipacks, so you can plan and eat one bar or yoghurt at a time. Leave empty if an item is the whole pack.">
        {(id) => <TextInput id={id} inputMode="decimal" value={itemGrams} onChange={(e) => setItemGrams(e.target.value)} placeholder="e.g. 48" />}
      </Field>
      <Field label="Ingredient" hint="What recipes call it. Leave empty for things like snacks.">
        {(id) => (
          <Select id={id} value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}>
            <option value="">None</option>
            {ingredients.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Category" hint={`Leave on "From its ingredient" unless it's different.`}>
        {(id) => (
          <Select id={id} value={foodGroup} onChange={(e) => setFoodGroup(e.target.value)}>
            <option value="">From its ingredient{ingredientGroup ? ` (${ingredientGroup})` : ''}</option>
            {FOOD_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {showCategory && (
        <Field label="Shelf-life category">
          {(id) => (
            <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">From ingredient</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="Barcodes" hint="Separate several with commas.">
        {(id) => <TextInput id={id} inputMode="numeric" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="Optional" />}
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
