import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { BackupDto, HouseholdSettings, ShelfLifeCategoryDto } from '@snackoverflow/shared';
import { Icon } from '../components/Icon';
import { MenuButton, useMe } from '../components/Layout';
import { useToast } from '../components/Toast';
import { PageTop, Segmented } from '../components/Toolbar';
import { Button, Card, ErrorNote, Field, Select, Spinner, TextInput, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { keys, useShelfLife } from '../lib/queries';
import { PALETTES, type PaletteId } from '../lib/palettes';
import { getPalette, getTheme, setPalette, setTheme, type Theme } from '../lib/theme';

export function SettingsPage() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  return (
    <>
      <PageTop title="General settings" left={<MenuButton />} />
      <div className="max-w-3xl">
        <div className="flex flex-col gap-4 [&>*]:scroll-mt-4">
          <AppearanceCard />
          <HouseholdCard />
          <PricesCard />
          <SuggestionsCard />
          {isAdmin && me.features.backups && <BackupsCard />}
          <Card className="p-4" id="assistants">
            <h2 className="mb-2 font-bold">Recipes and assistants</h2>
            <p className="text-sm">
              <span className="font-semibold">AI clean-up of imported recipes:</span>{' '}
              {me.features.ai ? 'on. Use "Tidy up with AI" after importing a link.' : 'off. Set AI_API_KEY on the server to turn it on.'}
            </p>
            <p className="mt-2 text-sm">
              <span className="font-semibold">Claude and other assistants (MCP):</span>{' '}
              {me.features.mcp ? (
                <>
                  on. Connect your assistant to <code className="rounded bg-card-muted px-1">{`${location.origin}/mcp`}</code> with the MCP_TOKEN from the server's settings.
                </>
              ) : (
                'off. Set MCP_TOKEN on the server to let your own assistant add and fix recipes, no API key needed.'
              )}
            </p>
          </Card>
          {isAdmin && (
            <Card className="p-4" id="data">
              <h2 className="font-bold">Your data</h2>
              <p className="mb-3 mt-1 text-sm text-muted">Download everything in the household as a JSON file.</p>
              <a href="/api/export" download className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-semibold hover:bg-card-muted lg:min-h-8 lg:rounded-md">
                <Icon name="download" className="size-4" /> Export data
              </a>
            </Card>
          )}
          <p className="text-center text-xs text-muted">Snack Overflow 0.1.0</p>
        </div>
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
    <Card className="p-4" id="household">
      <h2 className="mb-4 font-bold">Household</h2>
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

/** Shelf-life defaults on their own settings page. */
export function ShelfLifePage() {
  return (
    <div className="max-w-4xl">
      <PageTop title="Shelf life" left={<MenuButton />} />
      <ShelfLifeCard />
    </div>
  );
}

function ShelfLifeCard() {
  const categories = useShelfLife();
  return (
    <Card className="p-4" id="shelf-life">
      <h2 className="font-bold">Shelf-life defaults</h2>
      <p className="mb-1 mt-1 text-muted">Days each kind of food keeps. Blank means it doesn't apply. Products learn their own dates as you correct them.</p>
      <p className="mb-4 text-sm text-muted">
        Food-safety rules are fixed: opening never extends a date and defrosted food is never refrozen. Freezing food past its date is allowed after a warning.
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
    <Card className="p-4" id="backups">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold">Backups</h2>
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

function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (settings: Partial<HouseholdSettings>, message = 'Saved.') => {
    try {
      await api.patch('/api/household', { settings });
      await qc.invalidateQueries({ queryKey: keys.session });
      await qc.invalidateQueries({ queryKey: ['shopping'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      toast.show(message);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };
}

/** Optional pricing: off by default, and hidden everywhere when off. */
function PricesCard() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  const save = useSaveSettings();
  const on = me.household.settings.pricingEnabled;
  return (
    <Card className="p-4" id="prices">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-bold">Prices</h2>
          <p className="text-[0.9375rem] text-muted">
            No UK supermarket has a public price API, so prices come from your receipts, what you type in, and Open Prices (shared by Open Food Facts users). When on, the list shows an
            estimated total and meal suggestions favour cheaper extras.
          </p>
        </div>
        {isAdmin ? (
          <Toggle checked={on} label="Use prices" onChange={(v) => void save({ pricingEnabled: v }, v ? 'Prices are on.' : 'Prices are off and hidden.')} />
        ) : (
          <span className="font-semibold">{on ? 'On' : 'Off'}</span>
        )}
      </div>
    </Card>
  );
}

/** Rules for "Suggest meals" and "Plan my week". */
function SuggestionsCard() {
  const me = useMe();
  const isAdmin = me.user.role === 'admin';
  const save = useSaveSettings();
  const s = me.household.settings;
  const [noRepeat, setNoRepeat] = useState(String(s.noRepeatDays));
  const [tags, setTags] = useState(s.excludedTags.join(', '));
  const [maxExtra, setMaxExtra] = useState(String(s.maxExtraIngredients));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      noRepeatDays: Math.max(0, Math.min(60, Math.round(Number(noRepeat) || 0))),
      excludedTags: tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      maxExtraIngredients: Number(maxExtra),
    });
  };
  return (
    <Card className="p-4" id="suggestions">
      <h2 className="mb-1 font-bold">Meal suggestions</h2>
      <p className="mb-4 text-[0.9375rem] text-muted">Rules for “Suggest meals” and “Plan my week”.</p>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <Field label="Don't repeat within (days)">
          {(id) => <TextInput id={id} inputMode="numeric" disabled={!isAdmin} value={noRepeat} onChange={(e) => setNoRepeat(e.target.value)} />}
        </Field>
        <Field label="Most extra ingredients to buy">
          {(id) => (
            <Select id={id} disabled={!isAdmin} value={maxExtra} onChange={(e) => setMaxExtra(e.target.value)}>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Never suggest tags" hint="Comma separated, e.g. dessert, party">
          {(id) => <TextInput id={id} disabled={!isAdmin} value={tags} onChange={(e) => setTags(e.target.value)} />}
        </Field>
        {isAdmin && (
          <Button type="submit" className="self-start sm:col-span-3">
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

/** Light, dark or follow the device. Kept on this device only, so a phone and a laptop can differ. */
function AppearanceCard() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [palette, setPaletteState] = useState<PaletteId>(getPalette);
  const options: [Theme, string][] = [
    ['system', 'Match device'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  return (
    <Card className="p-4" id="appearance">
      <h2 className="font-bold">Appearance</h2>
      <p className="mb-3 mt-0.5 text-sm text-muted">Just for this device.</p>
      <Segmented
        label="Theme"
        value={theme}
        onChange={(value) => {
          setTheme(value);
          setThemeState(value);
        }}
        options={options.map(([value, label]) => ({ value, label }))}
      />
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium">Colours</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {PALETTES.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 ${palette === p.id ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:bg-card-muted'}`}
            >
              <input
                type="radio"
                name="palette"
                className="sr-only"
                checked={palette === p.id}
                onChange={() => {
                  setPalette(p.id);
                  setPaletteState(p.id);
                }}
              />
              {/* Light and dark swatches side by side: background with the accent on it. */}
              <span aria-hidden className="flex shrink-0 overflow-hidden rounded-lg border border-line">
                <span className="flex size-7 items-center justify-center" style={{ background: p.light.bg }}>
                  <span className="size-3.5 rounded-full" style={{ background: p.light.accent }} />
                </span>
                <span className="flex size-7 items-center justify-center" style={{ background: p.dark.bg }}>
                  <span className="size-3.5 rounded-full" style={{ background: p.dark.accent }} />
                </span>
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{p.name}</span>
                <span className="block text-xs text-muted">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}
