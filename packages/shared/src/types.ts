/** API response shapes shared by the server and the web app. */
import type { CalendarDate } from './dates';
import type { Channel, NotificationPrefs, Nutrition, Role } from './schemas';
import type { LocationType, ShelfLife, StockState } from './shelfLife';
import type { DisplayUnit } from './units';

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface HouseholdDto {
  id: string;
  name: string;
  timeZone: string;
}

export interface FeaturesDto {
  push: boolean;
  vapidPublicKey: string | null;
  email: boolean;
  oidc: { enabled: boolean; displayName: string; allowPassword: boolean };
  backups: boolean;
}

export interface SessionDto {
  user: UserDto;
  household: HouseholdDto;
  features: FeaturesDto;
  today: CalendarDate;
}

export interface LocationDto {
  id: string;
  name: string;
  type: LocationType;
  icon: string | null;
  sortOrder: number;
}

export interface ShelfLifeCategoryDto extends ShelfLife {
  id: string;
  key: string;
  name: string;
  examples: string;
  defaultLocation: LocationType;
  source: string;
  notes: string;
}

export interface IngredientDto {
  id: string;
  key: string | null;
  name: string;
  aisle: string | null;
  shelfLifeCategoryId: string | null;
  densityGPerMl: number | null;
  gramsPerCount: number | null;
  countUnit: string | null;
  trackRunningLow: boolean;
  /** Effective shelf life (own values, then the category). */
  shelfLife: ShelfLife;
  /** Days set on this ingredient itself; null means "from the category". */
  overrides: Pick<ShelfLife, 'closedDays' | 'openedDays' | 'frozenDays' | 'defrostedDays'>;
}

export interface ProductDto {
  id: string;
  name: string | null;
  brand: string | null;
  imageUrl: string | null;
  barcodes: string[];
  ingredientId: string | null;
  ingredientName: string | null;
  shelfLifeCategoryId: string | null;
  packGrams: number | null;
  packAmount: number | null;
  packUnit: string | null;
  displayUnit: DisplayUnit;
  nutritionPer100g: Nutrition | null;
  learnedClosedDays: number | null;
  learnedFrozenDays: number | null;
  source: 'off' | 'manual' | 'scan';
}

export interface StockItemDto {
  id: string;
  productId: string;
  productName: string;
  brand: string | null;
  imageUrl: string | null;
  ingredientId: string | null;
  locationId: string;
  locationName: string;
  locationType: LocationType;
  state: StockState;
  bestBefore: CalendarDate | null;
  addedOn: CalendarDate;
  openedOn: CalendarDate | null;
  frozenOn: CalendarDate | null;
  fractionLeft: number;
  initialGrams: number | null;
  remainingGrams: number | null;
  displayUnit: DisplayUnit;
  densityGPerMl: number | null;
  gramsPerCount: number | null;
  addedAt: string;
  /** Which actions make sense right now, with a reason when they don't. */
  actions: {
    open: string | null;
    freeze: string | null;
    defrost: string | null;
  };
}

export type StockEventType = 'add' | 'use' | 'open' | 'move' | 'freeze' | 'defrost' | 'discard' | 'adjust';

export interface StockEventDto {
  id: string;
  type: StockEventType;
  stockItemId: string;
  productId: string;
  productName: string;
  grams: number | null;
  fraction: number | null;
  userName: string | null;
  createdAt: string;
  undoneAt: string | null;
}

/** Result of any stock change: the item as it is now and the event that can be undone. */
export interface StockChangeDto {
  item: StockItemDto;
  eventId: string;
  askStillSome?: boolean;
  askOpened?: boolean;
  message?: string;
}

export interface ScanAddResult {
  status: 'added';
  /** False when the barcode is new and still needs a name. */
  known: boolean;
  product: ProductDto;
  change: StockChangeDto;
  /** The best-before was estimated rather than typed in. */
  estimated: boolean;
}

export type ScanUseResult =
  | { status: 'used'; product: ProductDto; change: StockChangeDto; packsLeft: number }
  | { status: 'not-in-stock'; product: ProductDto | null };

export interface NotificationSettingsDto {
  prefs: NotificationPrefs;
  available: Record<Channel, boolean>;
  pushSubscribed: number;
}

export interface WasteSummaryDto {
  thisMonthGrams: number;
  lastMonthGrams: number;
  thisMonthItems: number;
}

export interface BackupDto {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface InviteDto {
  id: string;
  email: string | null;
  role: Role;
  url: string;
  expiresAt: string;
}

/** Messages pushed over the WebSocket so every phone stays in step. */
export type LiveMessage = { type: 'invalidate'; topics: LiveTopic[] };
export type LiveTopic = 'stock' | 'products' | 'ingredients' | 'locations' | 'users' | 'household' | 'notifications';

export interface NotificationDto {
  id: string;
  seq: number;
  type: string;
  title: string;
  body: string;
  url: string | null;
  actions: { action: string; title: string }[];
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationListDto {
  items: NotificationDto[];
  unread: number;
  /** The highest seq seen; ask for `after` this next time. */
  cursor: number;
}

export interface DeviceDto {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}
