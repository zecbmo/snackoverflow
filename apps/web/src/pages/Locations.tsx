import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { LOCATION_TYPES, type LocationDto, type LocationType } from '@snackoverflow/shared';
import { Icon, locationIcon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { type Column, DataTable } from '../components/DataTable';
import { SidePanel, usePanelParam } from '../components/SidePanel';
import { PageTop } from '../components/Toolbar';
import { Button, EmptyState, ErrorNote, Field, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLocations, useStock } from '../lib/queries';

const typeLabel: Record<LocationType, string> = { cupboard: 'Cupboard', fridge: 'Fridge', freezer: 'Freezer' };

export function LocationsPage() {
  const locations = useLocations();
  const stock = useStock().data ?? [];
  const [adding, setAdding] = useState(false);
  const [openId, openPanel, closePanel] = usePanelParam();
  const editing = (locations.data ?? []).find((l) => l.id === openId) ?? null;
  const packs = (id: string) => stock.filter((s) => s.locationId === id).length;
  const columns: Column<LocationDto>[] = [
    { key: 'icon', header: <span className="sr-only">Type</span>, className: 'w-8 pr-0', cell: (l) => <Icon name={locationIcon(l.type)} className="size-4 text-muted" /> },
    { key: 'name', header: 'Name', primary: true, cell: (l) => l.name },
    { key: 'type', header: 'Type', cell: (l) => typeLabel[l.type] },
    { key: 'packs', header: 'Packs', align: 'right', className: 'tabular-nums', cell: (l) => packs(l.id) },
  ];
  return (
    <div className="max-w-3xl">
      <PageTop
        title="Locations"
        left={<MenuButton />}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" className="size-4" /> Add location
          </Button>
        }
      />
      <p className="mb-3 text-sm text-muted">The type sets the rules: things put in a freezer are frozen, with freezer dates.</p>
      <ErrorNote error={locations.error} />
      {locations.isPending ? (
        <Spinner />
      ) : (
        <DataTable
          label="Locations"
          columns={columns}
          rows={locations.data ?? []}
          rowKey={(l) => l.id}
          onOpen={(l) => openPanel(l.id)}
          openLabel={(l) => `Edit ${l.name}`}
          activeKey={openId}
          phone={(l) => ({
            lead: <Icon name={locationIcon(l.type)} className="size-5 text-muted" />,
            title: l.name,
            meta: `${typeLabel[l.type]} · ${packs(l.id)} ${packs(l.id) === 1 ? 'pack' : 'packs'}`,
            badge: <Icon name="chevronRight" className="size-4 text-muted" />,
          })}
          empty={<EmptyState title="No locations yet" />}
        />
      )}
      <SidePanel open={Boolean(openId)} onClose={closePanel} title={editing?.name ?? 'Location'}>
        {editing && <LocationEditor key={editing.id} location={editing} onDone={closePanel} />}
      </SidePanel>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add location">
        {adding && <LocationEditor key="new" location={null} onDone={() => setAdding(false)} />}
      </Sheet>
    </div>
  );
}

function LocationEditor({ location, onDone }: { location: LocationDto | null; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(location?.name ?? '');
  const [type, setType] = useState<LocationType>(location?.type ?? 'cupboard');
  const [error, setError] = useState<unknown>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['locations'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (location) await api.patch(`/api/locations/${location.id}`, { name, type });
      else await api.post('/api/locations', { name, type });
      await refresh();
      toast.show(location ? 'Saved.' : `Added ${name}.`);
      onDone();
    } catch (err) {
      setError(err);
    }
  };

  const remove = async () => {
    if (!location) return;
    try {
      await api.del(`/api/locations/${location.id}`);
      await refresh();
      toast.show(`Removed ${location.name}.`);
      onDone();
    } catch (err) {
      toast.show(errorMessage(err), { tone: 'error' });
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Field label="Name">{(id) => <TextInput id={id} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Garage freezer" />}</Field>
      <Field label="Type">
        {(id) => (
          <Select id={id} value={type} onChange={(e) => setType(e.target.value as LocationType)}>
            {LOCATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeLabel[t]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <ErrorNote error={error} />
      <Button type="submit" variant="primary">
        {location ? 'Save' : 'Add location'}
      </Button>
      {location && (
        <Button variant="danger" onClick={() => void remove()}>
          <Icon name="trash" className="size-4" /> Remove location
        </Button>
      )}
    </form>
  );
}
