import { useParams } from 'react-router';
import { BackButton } from '../components/Layout';
import { StockItemDetail } from '../components/StockItemDetail';
import { PageHeader } from '../components/ui';
import { useStockItem } from '../lib/queries';

/** A pack on its own page (links from notifications and other screens). Stock opens the same detail in a side panel. */
export function ItemDetailPage() {
  const { id = '' } = useParams();
  const item = useStockItem(id).data?.item;
  return (
    <div className="max-w-2xl">
      <PageHeader title={item?.productName ?? 'Stock'} subtitle={item?.brand ?? undefined} left={<BackButton />} />
      <StockItemDetail id={id} />
    </div>
  );
}
