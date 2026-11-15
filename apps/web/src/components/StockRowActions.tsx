/** The buttons on every stock row: Use, Freeze (or Defrost), Add to shopping list and Bin, plus a "⋯" menu for the rest. */
import { useQueryClient } from '@tanstack/react-query';
import type { StockItemDto } from '@snackoverflow/shared';
import { api, errorMessage } from '../lib/api';
import { useShopping } from '../lib/queries';
import { Icon } from './Icon';
import { Menu, type MenuEntry } from './Menu';
import { useStockActions } from './StockActions';
import { useToast } from './Toast';
import { Button } from './ui';

/** Freeze and Defrost share a width, so Use and Bin line up down the table. */
const SAME_WIDTH = 'min-w-[5rem]';

export function StockRowActions({
  item,
  name,
  packs,
  onDetails,
  compact = false,
  size = 'xs',
}: {
  item: StockItemDto;
  /** For the buttons' accessible names: "Use Semi Skimmed Milk". */
  name: string;
  /** Every pack on the row, for "Change amount" (defaults to just this one). */
  packs?: StockItemDto[];
  onDetails?: () => void;
  /**
   * Phones: just Use and "⋯" on the row (Freeze or Defrost, Move and Bin are in the menu), so
   * each item takes one line, like a table.
   */
  compact?: boolean;
  size?: 'xs' | 'sm' | 'md';
}) {
  const actions = useStockActions();
  const qc = useQueryClient();
  const toast = useToast();
  // On the list already (and not yet bought): nothing to add.
  const shopping = useShopping().data;
  const onList = (shopping ?? []).some((i) => !i.checked && (i.productId === item.productId || (item.ingredientId !== null && i.ingredientId === item.ingredientId)));
  const addToList = async () => {
    try {
      await api.post('/api/shopping', { productId: item.productId, packs: 1 });
      await qc.invalidateQueries({ queryKey: ['shopping'] });
      toast.show(`Added ${name} to the shopping list.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
  const frozen = item.state === 'frozen';
  const more: MenuEntry[] = [];
  more.push({ label: 'Change amount…', icon: 'edit', onSelect: () => actions.changeAmount(packs ?? [item]) });
  more.push({ label: 'Move…', icon: 'move', onSelect: () => actions.move(item) });
  if (item.actions.open === null) more.push({ label: 'Mark as opened', icon: 'bottle', onSelect: () => void actions.open(item) });
  if (onDetails) more.push({ label: 'Details and history', icon: 'external', onSelect: onDetails });
  if (compact) {
    const first: MenuEntry[] = frozen
      ? [{ label: 'Defrost', onSelect: () => void actions.defrost(item) }]
      : [{ label: 'Freeze', disabled: item.actions.freeze !== null, hint: item.actions.freeze ?? undefined, onSelect: () => void actions.freeze(item) }];
    return (
      <>
        <Button size="sm" variant="dark" aria-label={`Use ${name}`} onClick={() => actions.use(item)}>
          Use
        </Button>
        <Menu
          label={`More for ${name}`}
          items={[
            ...first,
            { label: onList ? 'On the shopping list' : 'Add to shopping list', icon: 'cart', disabled: onList || item.isMeal, onSelect: () => void addToList() },
            ...more,
            'divider',
            { label: 'Bin it', icon: 'trash', danger: true, onSelect: () => void actions.discard(item) },
          ]}
          triggerClassName="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-card-muted hover:text-ink"
        />
      </>
    );
  }
  return (
    <>
      <Button size={size} variant="dark" aria-label={`Use ${name}`} onClick={() => actions.use(item)}>
        Use
      </Button>
      {frozen ? (
        <Button size={size} aria-label={`Defrost ${name}`} onClick={() => void actions.defrost(item)} className={SAME_WIDTH}>
          Defrost
        </Button>
      ) : (
        <Button
          size={size}
          aria-label={`Freeze ${name}`}
          disabled={item.actions.freeze !== null}
          title={item.actions.freeze ?? undefined}
          onClick={() => void actions.freeze(item)}
          className={SAME_WIDTH}
        >
          Freeze
        </Button>
      )}
      <Button
        size={size}
        aria-label={onList ? `${name} is on the shopping list` : `Add ${name} to the shopping list`}
        title={onList ? 'Already on the shopping list' : 'Add to the shopping list'}
        disabled={onList || item.isMeal}
        onClick={() => void addToList()}
        className="px-2 lg:px-1.5"
      >
        <Icon name={onList ? 'check' : 'cart'} className="size-4" />
      </Button>
      <Button size={size} variant="danger" aria-label={`Bin ${name}`} title="Bin it" onClick={() => void actions.discard(item)} className="px-2 lg:px-1.5">
        <Icon name="trash" className="size-4" />
      </Button>
      {more.length > 0 && <Menu label={`More for ${name}`} items={more} />}
    </>
  );
}
