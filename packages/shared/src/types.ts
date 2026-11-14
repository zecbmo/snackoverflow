/** API response shapes shared by the server and the web app. */
import type { CalendarDate } from './dates';
import type { Channel, HouseholdSettings, IngredientInput, NotificationPrefs, Nutrition, Role } from './schemas';
import type { LocationType, ShelfLife, StockState } from './shelfLife';
import type { DisplayUnit } from './units';
import type { MealSlot } from './shopping';

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Daily calorie target, if they've set one. */
  kcalTarget: number | null;
}

export interface HouseholdDto {
  id: string;
  name: string;
  timeZone: string;
  settings: HouseholdSettings;
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
  /** Products people name can be added to Open Food Facts (OFF_CONTRIBUTE_* set). */
  offContribute: boolean;
}

/** Settings → AI and assistants (admins). Keys and tokens are never sent back, only their last characters. */
export interface AssistantSettingsDto {
  ai: { source: 'server' | 'settings' | null; keyHint: string | null; model: string; modelSource: 'server' | 'settings' | null; defaultModel: string };
  mcp: { source: 'server' | 'settings' | null; tokenHint: string | null; url: string };
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
  /** How it's sold and measured: 'ml' for liquids, 'count' for eggs, 'g' otherwise (null: not known). */
  packUnit: string | null;
  /** Category, e.g. "Dairy" (see FOOD_GROUPS). */
  foodGroup: string | null;
  trackRunningLow: boolean;
  /** Effective shelf life (own values, then the category). */
  shelfLife: ShelfLife;
  /** Days set on this ingredient itself; null means "from the category". */
  overrides: Pick<ShelfLife, 'closedDays' | 'openedDays' | 'frozenDays' | 'defrostedDays'>;
  swapGroupId: string | null;
}

export interface ProductDto {
  id: string;
  name: string | null;
  /** A cooked meal (leftovers or batch portions), made by cooking rather than bought. */
  isMeal: boolean;
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
  /** Latest known price of one pack, in pence; null when pricing is off or unknown. */
  pricePence: number | null;
  /** One item of a multipack, in grams (null: an item is the whole pack). */
  portionGrams: number | null;
  /** Category: the product's own, else its ingredient's. */
  foodGroup: string | null;
  /** The product's own category, when set (for editing). */
  ownFoodGroup: string | null;
  /** When this household added it to Open Food Facts. */
  offSharedAt: string | null;
}

/** After adding a product to Open Food Facts. */
export interface OffShareResultDto {
  product: ProductDto;
  /** Barcodes added. */
  added: string[];
  /** Barcodes Open Food Facts already had (left as they were). */
  alreadyThere: string[];
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
  /** Category, e.g. "Dairy": the product's own, else its ingredient's. */
  foodGroup: string | null;
  /** Which actions make sense right now, with a reason when they don't. */
  actions: {
    open: string | null;
    freeze: string | null;
    defrost: string | null;
    /** Freezing is allowed but worth a second thought (past its date, doesn't freeze well). */
    freezeWarning: string | null;
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
  /**
   * When there isn't enough in stock: other food in stock that could stand in. `close` is from the
   * same swap group (tenderstem for broccoli), `loose` from the same category (pork for chicken).
   */
  swaps: { close: SwapOptionDto[]; loose: SwapOptionDto[] };
}

export interface SwapOptionDto {
  ingredientId: string;
  name: string;
  inStockGrams: number;
  /** "300g", "2 tins": the stock said the way the food is measured. */
  amount: string;
}

/** An AI suggestion for a swap group, to review: a new group, or foods to add to an existing one. */
export interface SwapGroupSuggestionDto {
  /** An existing group to add these to; null for a new group. */
  groupId: string | null;
  name: string;
  /** The foods to add (for an existing group, only ones not in it yet). */
  ingredients: { id: string; name: string }[];
  reason: string;
}

/** Two foods never offered as a swap for each other ("Pesto" and "Stock cubes"). */
export interface SwapExclusionDto {
  id: string;
  ingredients: [{ id: string; name: string }, { id: string; name: string }];
}

export interface SwapGroupDto {
  id: string;
  name: string;
  ingredients: { id: string; name: string }[];
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
/** A recipe line that can't be checked against stock or put on the shopping list. */
export interface UnmatchedLineDto {
  id: string;
  recipeId: string;
  recipeTitle: string;
  text: string;
  amount: number | null;
  unit: string | null;
}

/**
 * Recipe lines naming the same food that need fixing. `unlinked`: not linked to an ingredient.
 * `noWeight`: linked, but counted ("1 sachet") and the ingredient has no weight per item.
 * `unknownUnit`: linked, but the unit can't be turned into grams; edit the recipe.
 * `noNutrition`: linked and weighed, but nothing says what the food is made of, so recipes' calories leave it out.
 */
export interface UnmatchedGroupDto {
  /** foodKey of the lines for `unlinked`, `ingredient:<id>` otherwise. */
  key: string;
  name: string;
  problem: 'unlinked' | 'noWeight' | 'unknownUnit' | 'noNutrition';
  ingredientId: string | null;
  ingredientName: string | null;
  ignored: boolean;
  lines: UnmatchedLineDto[];
}

/** An AI suggestion for one unmatched group, for the household to review. */
export interface UnmatchedSuggestionDto {
  key: string;
  action: 'link' | 'create' | 'ignore';
  ingredientId: string | null;
  ingredientName: string | null;
  newIngredient: IngredientInput | null;
  gramsPerCount: number | null;
  nutritionPer100g: Nutrition | null;
  reason: string;
}

/** What the AI read from photos of a product's pack, for the household to check before saving. */
export interface ProductPhotoReadDto {
  name: string;
  brand: string | null;
  packAmount: number | null;
  packUnit: 'g' | 'kg' | 'ml' | 'l' | 'count' | null;
  ingredientId: string | null;
  ingredientName: string | null;
  nutritionPer100g: Nutrition | null;
}

/** Photos of one recipe waiting in the bank to be read (by AI or the household's assistant). */
export interface RecipeScanDto {
  id: string;
  status: 'waiting' | 'reading' | 'failed' | 'done';
  error: string | null;
  recipeId: string | null;
  recipeTitle: string | null;
  imageCount: number;
  createdAt: string;
}

export interface UnmatchedFixResultDto {
  linked: number;
  created: { id: string; name: string }[];
}

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
  /** The recipe line scaled to the servings being cooked ("900 grams Potatoes"). */
  text: string;
  /** The line as the recipe has it, for its own number of servings. */
  originalText: string;
  /** All of this food in stock right now (before this cook), when it is measured. */
  inStockGrams: number | null;
  ingredientName: string | null;
  /** Cooking with a swap: what the recipe says ("Broccoli"); ingredientName is what's used instead. */
  swappedFrom: string | null;
  optional: boolean;
  /** How the ingredient is measured, so amounts can be shown in ml for liquids. */
  unit: { displayUnit: 'g' | 'ml' | 'count'; densityGPerMl: number | null };
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
  /** For food and leftovers: grams in one item (servings counts items), so amounts can be shown and set by weight. */
  unitGrams: number | null;
  /** How the food is measured, for showing a weight: 'ml' for liquids. */
  displayUnit: 'g' | 'ml' | 'count';
  status: 'planned' | 'cooked' | 'skipped';
  source: 'plan' | 'scan';
  /** Who has portions of it. Servings beyond these are free: nobody's yet. */
  people: { userId: string; name: string; portions: number }[];
  /** A batch cook for the freezer: nobody is eating it, so no one gets its calories. */
  batch: boolean;
  kcalPerServing: number | null;
  /** Calories for the person being viewed (their portions only), or for the whole entry. */
  kcal: number | null;
  /** For recipes: food used instead of what the recipe says ("Tenderstem broccoli for Broccoli"). */
  swaps: { recipeIngredientId: string; ingredientId: string; from: string; to: string }[];
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
  /** How much the planned meals are short by ("20g", "300ml") after what's in stock; null when nothing is short. */
  needLabel: string | null;
  /** Category, e.g. "Vegetables" (null: unknown, such as free text). */
  foodGroup: string | null;
  reason: 'plan' | 'running-low' | 'manual';
  /** Estimated cost of this line in pence; null when pricing is off or unknown. */
  pricePence: number | null;
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
  /** Plan items taken off the list: covered now, or no longer planned. */
  removed?: number;
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

export interface PriceDto {
  id: string;
  pricePence: number;
  store: string | null;
  date: CalendarDate;
  source: string;
}

export interface ShoppingEstimateDto {
  enabled: boolean;
  totalPence: number | null;
  /** Unticked items with a price, and without. */
  priced: number;
  unpriced: number;
}

/** Dashboard: calories per day for one person (or the whole household) over the last 30 days. */
export interface CalorieStatsDto {
  personId: string | null;
  name: string;
  target: number | null;
  today: CalendarDate;
  /** Oldest first, ending today. Only meals marked eaten count. */
  days: { date: CalendarDate; kcal: number }[];
  avg7: number | null;
  avg30: number | null;
}

export interface WastePeriodDto {
  start: CalendarDate;
  label: string;
  grams: number;
  /** Value of what was binned, when pricing is on and prices are known. */
  pence: number | null;
  items: number;
}

/** Dashboard and waste report: what was binned, by week or month, item and category. */
export interface WasteReportDto {
  period: 'week' | 'month';
  pricing: boolean;
  periods: WastePeriodDto[];
  /** Against the same point in the previous week or month. */
  changePercent: number | null;
  /** `amount` says it the way the food is measured ("1.2L" for milk). */
  byItem: { name: string; grams: number; amount: string; pence: number | null; items: number }[];
  byCategory: { name: string; grams: number; pence: number | null }[];
}

/** Spending from receipts, when pricing is on. */
export interface SpendingDto {
  period: 'week' | 'month';
  periods: { start: CalendarDate; label: string; pence: number; receipts: number }[];
  changePercent: number | null;
}
