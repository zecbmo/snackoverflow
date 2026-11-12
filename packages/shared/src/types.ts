/** API response shapes shared by the server and the web app. */
import type { CalendarDate } from './dates';
import type { Channel, NotificationPrefs, Nutrition, Role } from './schemas';
import type { LocationType, ShelfLife, StockState } from './shelfLife';
import type { DisplayUnit } from './units';
import type { MealSlot } from './shopping';

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
  /** Receipts forwarded by email are picked up (RECEIPT_IMAP_HOST set). */
  receiptEmail: boolean;
  /** AI recipe clean-up is set up (AI_API_KEY). */
  ai: boolean;
  /** The MCP endpoint for assistants is on (MCP_TOKEN); it lives at APP_URL/mcp. */
  mcp: boolean;
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
  source: 'off' | 'manual' | 'scan' | 'receipt';
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
  /** A cooked meal (leftovers or batch-cook portions), counted in portions. */
  isMeal: boolean;
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
export type LiveTopic = 'stock' | 'products' | 'ingredients' | 'locations' | 'users' | 'household' | 'notifications' | 'recipes' | 'plan' | 'shopping' | 'receipts';

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

export interface RecipeIngredientDto {
  id: string;
  position: number;
  text: string;
  amount: number | null;
  unit: string | null;
  ingredientId: string | null;
  ingredientName: string | null;
  productId: string | null;
  productName: string | null;
  note: string | null;
  optional: boolean;
  /** Amount in grams, when it can be worked out. */
  grams: number | null;
  /** Grams of this ingredient in stock right now (all packs), when known. */
  inStockGrams: number | null;
}

export interface RecipeSummaryDto {
  id: string;
  title: string;
  serves: number;
  imageUrl: string | null;
  tags: string[];
  totalMinutes: number | null;
  kcalPerServing: number | null;
  ingredientCount: number;
}

export interface RecipeDto extends RecipeSummaryDto {
  steps: string[];
  sourceUrl: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: RecipeIngredientDto[];
  nutritionPerServing: Nutrition;
  /** Share of ingredient lines with known calories (0-1). */
  nutritionCoverage: number;
  updatedAt: string;
}

/** An imported or AI-tidied recipe, not yet saved, for the review screen. */
export interface RecipeDraftDto {
  title: string;
  serves: number;
  steps: string[];
  imageUrl: string | null;
  sourceUrl: string | null;
  tags: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: (RecipeIngredientInputDraft & { ingredientName: string | null; matchConfidence: 'high' | 'low' | 'none' })[];
}

export interface RecipeIngredientInputDraft {
  text: string;
  amount: number | null;
  unit: string | null;
  ingredientId: string | null;
  productId: string | null;
  note: string | null;
  optional: boolean;
}

/** The cook screen: what each line will take from stock, earliest-expiring first. */
export interface CookPlanLineDto {
  recipeIngredientId: string;
  text: string;
  ingredientName: string | null;
  optional: boolean;
  neededGrams: number | null;
  takes: {
    stockItemId: string;
    productName: string;
    locationName: string;
    state: StockState;
    bestBefore: CalendarDate | null;
    /** Grams to take, or null when the pack's size isn't known (then `fraction`). */
    grams: number | null;
    fraction: number | null;
    availableGrams: number | null;
  }[];
  /** Grams still missing after all stock is used. */
  shortGrams: number | null;
}

export interface CookPlanDto {
  recipeId: string;
  title: string;
  serves: number;
  servings: number;
  portionGrams: number | null;
  lines: CookPlanLineDto[];
}

export interface CookResultDto {
  cookId: string;
  /** Closed packs used in part: ask "Is it opened now?". */
  askOpened: StockItemDto[];
  /** Packs whose numbers ran out: ask "Is there still some left?". */
  askStillSome: StockItemDto[];
  leftovers: StockItemDto[];
}

export interface PlanEntryDto {
  id: string;
  date: CalendarDate;
  slot: MealSlot;
  kind: 'recipe' | 'product' | 'stock' | 'text';
  recipeId: string | null;
  productId: string | null;
  stockItemId: string | null;
  title: string;
  /** "From fridge", "Scanned", "Missing 1"… */
  detail: string | null;
  servings: number;
  status: 'planned' | 'cooked' | 'skipped';
  source: 'plan' | 'scan';
  people: { userId: string; name: string; portions: number }[];
  kcalPerServing: number | null;
  /** Calories for the person being viewed (their share), or for the whole entry. */
  kcal: number | null;
}

export interface PlanDayDto {
  date: CalendarDate;
  entries: PlanEntryDto[];
  kcal: number;
}

export interface PlanDto {
  from: CalendarDate;
  to: CalendarDate;
  /** Whose calendar this is; null = everyone. */
  personId: string | null;
  days: PlanDayDto[];
}

/** Food set aside for planned meals (planned meals warn, they don't lock stock). */
export interface EarmarkDto {
  ingredientId: string;
  grams: number;
  meals: { entryId: string; title: string; date: CalendarDate; grams: number }[];
}

export interface ShoppingItemDto {
  id: string;
  text: string;
  ingredientId: string | null;
  productId: string | null;
  aisle: string;
  grams: number | null;
  packs: number;
  packGrams: number | null;
  /** One pack as people say it: "2.5kg", "568ml", "12 eggs". */
  packLabel: string | null;
  surplusGrams: number | null;
  /** The spare amount, said the same way. */
  surplusLabel: string | null;
  reason: 'plan' | 'running-low' | 'manual';
  forMeals: string | null;
  checked: boolean;
  addedByName: string | null;
}

export interface RunningLowDto {
  ingredientId: string;
  name: string;
  onHandGrams: number;
  daysLeft: number | null;
  onList: boolean;
}

export interface BuildListResultDto {
  added: number;
  updated: number;
  /** Food the plan needs that's already covered by stock. */
  covered: number;
  surplus: { ingredientId: string; name: string; grams: number }[];
}

export interface EatResultDto {
  entry: PlanEntryDto;
  product: ProductDto;
  /** The stock change, when it was in stock. */
  change: StockChangeDto | null;
}

export interface ReceiptLineDto {
  id: string;
  text: string;
  quantity: number;
  pricePence: number | null;
  productId: string | null;
  productName: string | null;
  ingredientId: string | null;
  ingredientName: string | null;
  matchSource: 'alias' | 'list' | 'product' | 'ingredient' | 'none';
  confidence: 'high' | 'low' | 'none';
  /** On the shopping list. */
  onList: boolean;
  skip: boolean;
  locationId: string | null;
  bestBefore: CalendarDate | null;
}

export interface ReceiptSummaryDto {
  id: string;
  source: 'photo' | 'upload' | 'email' | 'text' | 'mcp';
  status: 'reading' | 'waiting' | 'review' | 'done' | 'failed';
  store: string | null;
  purchasedOn: CalendarDate | null;
  lineCount: number;
  totalPence: number | null;
  error: string | null;
  createdAt: string;
}

export interface ReceiptDto extends ReceiptSummaryDto {
  lines: ReceiptLineDto[];
  hasFile: boolean;
}
