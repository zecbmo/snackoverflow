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
  /** A local copy of Open Food Facts is kept for search as you type (OFF_DUMP_ENABLED). */
  offDump: boolean;
}

/** Settings → the local copy of Open Food Facts. */
export interface OffDumpStatusDto {
  enabled: boolean;
  /** Products sold here are kept, e.g. "united-kingdom"; null keeps every country. */
  country: string | null;
  /** Products in the local copy now. */
  products: number;
  refreshDays: number;
  last: {
    status: 'running' | 'done' | 'failed';
    startedAt: string;
    finishedAt: string | null;
    lines: number;
    products: number;
    error: string | null;
  } | null;
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
  /** How the amount is shown: "count" for food sold by the item (apples, eggs), even when the pack was bought by weight. */
  displayUnit: DisplayUnit;
  densityGPerMl: number | null;
  gramsPerCount: number | null;
  /** What one item is called ("apple", "egg"), for counted food. */
  countUnit: string | null;
  /** One item of a multipack (a bar of four), in grams; null otherwise. */
  itemGrams: number | null;
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
  /** Used and logged as eaten: the meal logged (Undo removes it and puts the food back). */
  entryId?: string;
  /** Every change made, oldest first, when it took from more than one pack (Undo all of them). */
  eventIds?: string[];
  askStillSome?: boolean;
  askOpened?: boolean;
  message?: string;
}

/** Packs merged into one: the pack that's left, and every event written (undo them newest first). */
export interface StockMergeDto {
  item: StockItemDto;
  eventIds: string[];
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
  /** Nutrition per serving, when enough of the recipe is known (as for kcalPerServing). */
  nutritionPerServing: Nutrition | null;
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

export type PlanKind = 'recipe' | 'product' | 'stock' | 'text' | 'ingredient' | 'chain';

export interface PlanEntryDto {
  id: string;
  date: CalendarDate;
  slot: MealSlot;
  kind: PlanKind;
  recipeId: string | null;
  productId: string | null;
  stockItemId: string | null;
  ingredientId: string | null;
  chainItemId: string | null;
  title: string;
  /** "From fridge", "Scanned", "McDonald's"… */
  detail: string | null;
  servings: number;
  /** For food, leftovers and ingredients: grams in one item (servings counts items), so amounts can be shown and set by weight. */
  unitGrams: number | null;
  /** How the food is measured, for showing a weight: 'ml' for liquids. */
  displayUnit: 'g' | 'ml' | 'count';
  /** What one item is called ("banana"), for counted ingredients. */
  countUnit: string | null;
  /** The meal itself: planned, cooked or done, or skipped. Whether each person has eaten is on `people`. */
  status: 'planned' | 'cooked' | 'skipped';
  source: 'plan' | 'scan';
  /** Who has portions of it, and whether they've eaten them. Servings beyond these are free: nobody's yet. */
  people: { userId: string; name: string; portions: number; eaten: boolean }[];
  /** A batch cook for the freezer: nobody is eating it, so no one gets its calories. */
  batch: boolean;
  kcalPerServing: number | null;
  /** Protein, carbs, fat (and the rest, when known) in one serving. */
  nutritionPerServing: Nutrition | null;
  /** Calories for the person being viewed (their portions only), or for the whole entry. */
  kcal: number | null;
  /** The person being viewed has eaten their portion (everyone's view: everyone with a portion has). */
  eaten: boolean;
  /** For recipes: food used instead of what the recipe says ("Tenderstem broccoli for Broccoli"). */
  swaps: { recipeIngredientId: string; ingredientId: string; from: string; to: string }[];
}

export interface PlanDayDto {
  date: CalendarDate;
  entries: PlanEntryDto[];
  /** Calories eaten so far. Never added to planned. */
  eatenKcal: number;
  /** Calories still planned (not yet eaten, not skipped). */
  plannedKcal: number;
  /** Grams of protein, carbs and fat eaten, from the foods that have them; `missing` eaten foods don't. */
  eatenMacros: MacroTotals;
}

export interface MacroTotals {
  protein: number;
  carbs: number;
  fat: number;
  /** Eaten foods with no macros known. */
  missing: number;
}

export interface PlanDto {
  from: CalendarDate;
  to: CalendarDate;
  /** Whose calendar this is; null = everyone. */
  personId: string | null;
  days: PlanDayDto[];
}

/** People ticked as having eaten a meal, and the stock changes it made (for Undo). */
export interface PlanEatDto {
  entry: PlanEntryDto;
  stockEventIds: string[];
}

/** Where a food in the Log food search comes from. */
export type FoodSource = 'leftovers' | 'stock' | 'recipe' | 'product' | 'ingredient' | 'chain' | 'quick' | 'off';

/** One thing you could log: everything needed to pick an amount and log it. */
export interface FoodResultDto {
  source: FoodSource;
  /** The id for logging: stock item (leftovers), recipe, product (stock and product), ingredient, menu item or barcode (Open Food Facts). Empty for quick calories. */
  id: string;
  title: string;
  /** "Fridge · 2 packs", "Hovis", "McDonald's · Burgers". */
  subtitle: string | null;
  kcalPerServing: number | null;
  /** What one serving is: "1 pack (400g)", "1 serving", "1 banana (120g)", "100g". */
  servingLabel: string;
  /** Grams in one serving, when known, so it can be logged by weight. */
  unitGrams: number | null;
  displayUnit: 'g' | 'ml' | 'count';
  countUnit: string | null;
  /** In the house: logging it can take it from stock (the app asks). */
  inStock: { packs: number; locationName: string } | null;
  /** Protein, carbs, fat… in one serving, when known. */
  nutritionPerServing: Nutrition | null;
  /** Starred by you (products, recipes, foods and menu items can be). */
  favourite: boolean;
  /** How much you usually have, from what you've logged before. */
  usualServings: number | null;
}

/** "My usual breakfast": several foods logged in one tap. */
export interface SavedMealDto {
  id: string;
  name: string;
  items: { title: string; servings: number; kcal: number | null }[];
  kcal: number | null;
}

/** What Log food shows before anything is typed. */
export interface FoodSuggestionsDto {
  favourites: FoodResultDto[];
  /** Had at this meal more than once lately, most often first. */
  usual: FoodResultDto[];
  /** Had lately, any meal, newest first. */
  recent: FoodResultDto[];
  meals: SavedMealDto[];
}

/** Searching Open Food Facts by name: `busy` means wait a minute (it limits searches). */
export interface OffSearchDto {
  status: 'ok' | 'busy' | 'unavailable';
  results: FoodResultDto[];
}

/** A barcode scanned in Log food: the food, and whether anyone has named it yet. */
export interface BarcodeFoodDto {
  food: FoodResultDto;
  productId: string;
  named: boolean;
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
