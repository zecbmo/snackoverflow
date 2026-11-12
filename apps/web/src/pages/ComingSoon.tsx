import { MenuButton } from '../components/Layout';
import { EmptyState, PageHeader } from '../components/ui';

export function ComingSoonPage({ title, phase }: { title: string; phase: string }) {
  return (
    <>
      <PageHeader title={title} left={<MenuButton />} />
      <EmptyState title="Coming soon">{phase}</EmptyState>
    </>
  );
}
