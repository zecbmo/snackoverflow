import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { LOCATION_TYPES, type LocationDto, type LocationType } from '@snackoverflow/shared';
import { Icon, locationIcon } from '../components/Icon';
import { MenuButton } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, EmptyState, ErrorNote, Field, PageHeader, Select, Sheet, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLocations } from '../lib/queries';

const typeLabel: Record<LocationType, string> = { cupboard: 'Cupboard', fridge: 'Fridge', freezer: 'Freezer' };

export function LocationsPage() {
  const locations = useLocations();
  const [editing, setEditing] = useState<LocationDto | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Locations"
        left={<MenuButton />}
        right={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Icon name="plus" className="size-5" /> Add
          </Button>
        }
      />
      <p className="mb-4 text-muted">The type sets the rules: things put in a freezer are frozen, with freezer dates.</p>
      {locations.isPending ? (
        <Spinner />
      ) : locations.error ? (
        <ErrorNote error={locations.error} />
      ) : locations.data.length === 0 ? (
        <EmptyState title="No locations yet" />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {locations.data.map((l) => (
            <button key={l.id} type="button" onClick={() => setEditing(l)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-card-muted">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-card-muted">
                <Icon name={locationIcon(l.type)} className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{l.name}</span>
                <span className="block text-sm text-muted">{typeLabel[l.type]}</span>
              </span>
              <Icon name="chevronRight" className="size-5 text-muted" />
            </button>
          ))}
        </Card>
      )}
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add location' : 'Edit location'}>
        {editing !== null && (
          <LocationEditor key={editing === 'new' ? 'new' : editing.id} location={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        )}
      </Sheet>
    </>
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
      <Button type="submit" variant="primary" size="lg">
        {location ? 'Save' : 'Add location'}
      </Button>
      {location && (
        <Button variant="danger" onClick={() => void remove()}>
          <Icon name="trash" className="size-5" /> Remove location
        </Button>
      )}
    </form>
  );
}
