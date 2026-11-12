/** The buttons on every stock row: Use, Freeze (or Defrost), Move and Bin, plus a "⋯" menu for the rest. */
import type { StockItemDto } from '@snackoverflow/shared';
import { Icon } from './Icon';
import { Menu, type MenuEntry } from './Menu';
import { useStockActions } from './StockActions';
import { Button } from './ui';

export function StockRowActions({
  item,
  name,
  onDetails,
  compact: _compact = false,
  size = 'xs',
}: {
  item: StockItemDto;
  /** For the buttons' accessible names: "Use Semi Skimmed Milk". */
  name: string;
  onDetails?: () => void;
  /** Kept for callers; the row is the same on phones now (Move is always in the menu). */
  compact?: boolean;
  size?: 'xs' | 'sm' | 'md';
}) {
  const actions = useStockActions();
  const frozen = item.state === 'frozen';
  const more: MenuEntry[] = [];
  more.push({ label: 'Move…', icon: 'move', onSelect: () => actions.move(item) });
  if (item.actions.open === null) more.push({ label: 'Mark as opened', icon: 'bottle', onSelect: () => void actions.open(item) });
  if (onDetails) more.push({ label: 'Details and history', icon: 'external', onSelect: onDetails });
  return (
    <>
      <Button size={size} variant="dark" aria-label={`Use ${name}`} onClick={() => actions.use(item)}>
        Use
      </Button>
      {frozen ? (
        <Button size={size} aria-label={`Defrost ${name}`} onClick={() => void actions.defrost(item)}>
          Defrost
        </Button>
      ) : (
        <Button
          size={size}
          aria-label={`Freeze ${name}`}
          disabled={item.actions.freeze !== null}
          title={item.actions.freeze ?? undefined}
          onClick={() => void actions.freeze(item)}
        >
          Freeze
        </Button>
      )}
      <Button size={size} variant="danger" aria-label={`Bin ${name}`} title="Bin it" onClick={() => void actions.discard(item)} className="px-2 lg:px-1.5">
        <Icon name="trash" className="size-4" />
      </Button>
      {more.length > 0 && <Menu label={`More for ${name}`} items={more} />}
    </>
  );
}
