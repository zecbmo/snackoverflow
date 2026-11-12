import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { BackupDto, ShelfLifeCategoryDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorNote, Field, PageHeader, Select, Spinner, TextInput } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { keys, useShelfLife } from '../lib/queries';

export function SettingsPage() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  return (
    <>
      <PageHeader title="Settings" left={<MenuButton />} />
      <div className="flex flex-col gap-5">
        <HouseholdCard />
        <ShelfLifeCard />
        {isAdmin && me.features.backups && <BackupsCard />}
        {isAdmin && (
          <Card className="p-5">
            <h2 className="text-lg font-bold">Your data</h2>
            <p className="mb-3 mt-1 text-muted">Download everything in the household as a JSON file.</p>
            <a href="/api/export" download className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-card px-4 font-semibold hover:bg-card-muted">
              <Icon name="download" className="size-5" /> Export data
            </a>
          </Card>
        )}
        <p className="text-center text-sm text-muted">Snack Overflow 0.1.0</p>
      </div>
    </>
  );
}

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/London'];
  }
}

function HouseholdCard() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(me.household.name);
  const [timeZone, setTimeZone] = useState(me.household.timeZone);
  const [error, setError] = useState<unknown>(null);
  const zones = timeZones();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.patch('/api/household', { name, timeZone });
      await Promise.all([qc.invalidateQueries({ queryKey: ['household'] }), qc.invalidateQueries({ queryKey: keys.session })]);
      toast.show('Saved.');
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-4 text-lg font-bold">Household</h2>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Name">{(id) => <TextInput id={id} required disabled={!isAdmin} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Time zone" hint="Used for best-before dates and notification times.">
          {(id) => (
            <Select id={id} disabled={!isAdmin} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {!zones.includes(timeZone) && <option value={timeZone}>{timeZone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorNote error={error} />
        {isAdmin ? (
          <Button type="submit" variant="primary" className="self-start">
            Save
          </Button>
        ) : (
          <p className="text-sm text-muted">Only admins can change these.</p>
        )}
      </form>
    </Card>
  );
}

const DAY_FIELDS = [
  ['closedDays', 'Closed'],
  ['openedDays', 'Opened'],
  ['frozenDays', 'Frozen'],
  ['defrostedDays', 'Defrosted'],
] as const;

function ShelfLifeCard() {
  const categories = useShelfLife();
  return (
    <Card className="p-5">
      <h2 className="text-lg font-bold">Shelf-life defaults</h2>
      <p className="mb-1 mt-1 text-muted">Days each kind of food keeps. Blank means it doesn't apply. Products learn their own dates as you correct them.</p>
      <p className="mb-4 text-sm text-muted">
        Food-safety rules are fixed: opening never extends a date, food is frozen by its date, and defrosted food is never refrozen.
      </p>
      {categories.isPending ? (
        <Spinner />
      ) : categories.error ? (
        <ErrorNote error={categories.error} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-2 pr-3 font-medium">Food</th>
                {DAY_FIELDS.map(([, label]) => (
                  <th key={label} className="w-20 px-1 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {categories.data.map((c) => (
                <ShelfLifeRow key={c.id} category={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ShelfLifeRow({ category }: { category: ShelfLifeCategoryDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState(() =>
    Object.fromEntries(DAY_FIELDS.map(([k]) => [k, category[k] === null ? '' : String(category[k])])) as Record<(typeof DAY_FIELDS)[number][0], string>,
  );

  const save = async (key: (typeof DAY_FIELDS)[number][0]) => {
    const raw = values[key].trim();
    const value = raw === '' ? null : Number(raw);
    if (value === category[key]) return;
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      toast.show('Use a whole number of days.', { tone: 'error' });
      return;
    }
    try {
      await api.patch(`/api/shelf-life/${category.id}`, { [key]: value });
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
      toast.show(`Saved ${category.name.toLowerCase()}.`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  return (
    <tr>
      <td className="py-2 pr-3">
        <span className="block font-medium">{category.name}</span>
        <span className="block text-xs text-muted">{category.examples}</span>
      </td>
      {DAY_FIELDS.map(([key, label]) => (
        <td key={key} className="px-1 py-2">
          <TextInput
            aria-label={`${category.name}: ${label.toLowerCase()} days`}
            inputMode="numeric"
            value={values[key]}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            onBlur={() => void save(key)}
            className="px-2 text-center"
          />
        </td>
      ))}
    </tr>
  );
}

function BackupsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const backups = useQuery({ queryKey: ['household', 'backups'], queryFn: () => api.get<{ enabled: boolean; backups: BackupDto[] }>('/api/backups') });
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await api.post('/api/backups');
      await qc.invalidateQueries({ queryKey: ['household', 'backups'] });
      toast.show('Backup done.');
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const size = (b: number) => (b > 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Backups</h2>
          <p className="text-sm text-muted">Made every night and kept for a couple of weeks.</p>
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>
      {backups.isPending ? (
        <Spinner />
      ) : backups.error ? (
        <ErrorNote error={backups.error} />
      ) : backups.data.backups.length === 0 ? (
        <p className="text-muted">No backups yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {backups.data.backups.map((b) => (
            <li key={b.name} className="flex min-h-12 items-center gap-3 py-1">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {new Date(b.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="block text-sm text-muted">{size(b.sizeBytes)}</span>
              </span>
              <a
                href={`/api/backups/${encodeURIComponent(b.name)}`}
                download
                aria-label={`Download backup from ${new Date(b.createdAt).toLocaleDateString('en-GB')}`}
                className="inline-flex size-11 items-center justify-center rounded-full hover:bg-card-muted"
              >
                <Icon name="download" className="size-5" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
