/** API input schemas, shared by the server (validation) and the web app (forms and types). */
import { z } from 'zod';
import { isCalendarDate } from './dates';
import { LOCATION_TYPES, STOCK_STATES } from './shelfLife';
import { MEAL_SLOTS } from './shopping';
import { FOOD_GROUPS } from './foodGroups';

export const calendarDate = z.string().refine(isCalendarDate, { message: 'Must be a date (YYYY-MM-DD)' });
export const id = z.uuid();
const name = z.string().trim().min(1, 'Required').max(120);
const optionalText = z.string().trim().max(500).nullish();
const password = z.string().min(8, 'At least 8 characters').max(200);
const email = z.email().trim().toLowerCase();
const days = z.number().int().min(0).max(3650).nullable();

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const locationType = z.enum(LOCATION_TYPES);
export const stockState = z.enum(STOCK_STATES);
export const displayUnit = z.enum(['g', 'ml', 'count']);

// --- Auth and users -----------------------------------------------------------

/** A phone signing in gets its own token instead of a cookie. */
export const deviceInput = z.object({ name: z.string().trim().min(1).max(80), platform: z.enum(['android', 'web']).default('android') });
export const loginInput = z.object({ email, password: z.string().min(1), device: deviceInput.optional() });
export const appCodeInput = z.object({ code: z.string().min(16).max(200), device: deviceInput });
export const setupInput = z.object({ householdName: name, name, email, password });
export const acceptInviteInput = z.object({ name, email, password });
export const createInviteInput = z.object({ email: email.nullish(), role: z.enum(ROLES).default('member') });
/** A daily calorie target; null clears it. */
const kcalTarget = z.number().int().min(500).max(10000).nullable();
export const updateUserInput = z.object({ name: name.optional(), role: z.enum(ROLES).optional(), kcalTarget: kcalTarget.optional() });
export const updateMeInput = z.object({
  name: name.optional(),
  email: email.optional(),
  currentPassword: z.string().optional(),
  newPassword: password.optional(),
  kcalTarget: kcalTarget.optional(),
});

/** Household-wide choices for the optimiser and pricing. */
export const householdSettingsInput = z.object({
  pricingEnabled: z.boolean(),
  /** Don't suggest a recipe cooked or planned within this many days. */
  noRepeatDays: z.number().int().min(0).max(60),
  /** Tags the optimiser never suggests (e.g. "dessert"). */
  excludedTags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30),
  /** Most extra ingredients a suggestion may need buying. */
  maxExtraIngredients: z.number().int().min(0).max(10),
});
export type HouseholdSettings = z.infer<typeof householdSettingsInput>;
export const DEFAULT_HOUSEHOLD_SETTINGS: HouseholdSettings = { pricingEnabled: false, noRepeatDays: 7, excludedTags: [], maxExtraIngredients: 3 };

export const updateHouseholdInput = z.object({
  settings: householdSettingsInput.partial().optional(),
  name: name.optional(),
  timeZone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone')
    .optional(),
});

// --- Locations, ingredients, products -----------------------------------------

export const locationInput = z.object({
  name,
  type: locationType,
  icon: z.string().trim().max(40).nullish(),
});

export const shelfLifeInput = z.object({
  closedDays: days.optional(),
  openedDays: days.optional(),
  frozenDays: days.optional(),
  defrostedDays: days.optional(),
});

export const ingredientInput = z.object({
  name,
  aisle: z.string().trim().max(60).nullish(),
  shelfLifeCategoryId: id.nullish(),
  densityGPerMl: z.number().positive().max(5).nullish(),
  gramsPerCount: z.number().positive().max(100_000).nullish(),
  countUnit: z.string().trim().max(30).nullish(),
  trackRunningLow: z.boolean().optional(),
  shelfLife: shelfLifeInput.optional(),
  foodGroup: z.enum(FOOD_GROUPS).nullish(),
});

export const nutritionInput = z
  .object({
    kcal: z.number().min(0).nullish(),
    protein: z.number().min(0).nullish(),
    carbs: z.number().min(0).nullish(),
    sugars: z.number().min(0).nullish(),
    fat: z.number().min(0).nullish(),
    saturates: z.number().min(0).nullish(),
    fibre: z.number().min(0).nullish(),
    salt: z.number().min(0).nullish(),
  })
  .partial();
export type Nutrition = z.infer<typeof nutritionInput>;

export const productInput = z.object({
  name,
  brand: optionalText,
  imageUrl: z.url().nullish(),
  ingredientId: id.nullish(),
  shelfLifeCategoryId: id.nullish(),
  /** Pack size as sold, e.g. 2.27 + "l"; stored in grams. */
  packAmount: z.number().positive().max(1_000_000).nullish(),
  packUnit: z.string().trim().max(20).nullish(),
  nutritionPer100g: nutritionInput.nullish(),
  /** One item of a multipack (a single bar of four), in grams: lets people plan and eat one at a time. */
  portionGrams: z.number().positive().max(100_000).nullish(),
  /** Overrides the ingredient's food group; null means "from its ingredient". */
  foodGroup: z.enum(FOOD_GROUPS).nullish(),
  barcodes: z.array(z.string().trim().regex(/^[0-9A-Za-z-]{4,64}$/, 'Not a valid barcode')).optional(),
});
export const updateProductInput = productInput.partial();

// --- Stock ----------------------------------------------------------------------

export const useAmountInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('fraction'), fraction: z.number().gt(0).max(1) }),
  z.object({ kind: z.literal('grams'), grams: z.number().gt(0).max(1_000_000) }),
]);

export const useStockInput = z.object({ amount: useAmountInput });
export const discardStockInput = z.object({ amount: useAmountInput.default({ kind: 'all' }) });
export const moveStockInput = z.object({ locationId: id });
export const freezeStockInput = z.object({ locationId: id.optional() });
export const defrostStockInput = z.object({ locationId: id.optional() });
export const stillSomeInput = z.object({ answer: z.enum(['yes', 'nearly-gone', 'none']) });

export const adjustStockInput = z
  .object({
    bestBefore: calendarDate.nullable().optional(),
    locationId: id.optional(),
    /** Set the amount left as a fraction of the pack (0-1). */
    fractionLeft: z.number().min(0).max(1).optional(),
    remainingGrams: z.number().min(0).max(1_000_000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

export const addStockInput = z.object({
  productId: id,
  locationId: id,
  count: z.number().int().min(1).max(50).default(1),
  bestBefore: calendarDate.nullish(),
});

export const scanInput = z.object({
  barcode: z.string().trim().regex(/^[0-9A-Za-z-]{4,64}$/, 'Not a valid barcode'),
  locationId: id.optional(),
  /** When the scan really happened, for scans queued offline and synced later. */
  scannedAt: z.iso.datetime({ offset: true }).optional(),
  /** Eat mode: which meal to log it to (defaults to the meal for the time of day). */
  slot: z.enum(MEAL_SLOTS).optional(),
});

// --- Notifications ----------------------------------------------------------------

export const NOTIFICATION_TYPES = ['weeklySummary', 'expiresTomorrow', 'mealTime', 'runningLow', 'listChanged', 'receiptReady'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** app = the in-app inbox (the bell) and the Android app's notifications. */
export const CHANNELS = ['app', 'push', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const notificationPrefsInput = z.object({
  // Partial: types added later fall back to their defaults.
  channels: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.array(z.enum(CHANNELS))),
  quietStart: timeOfDay.nullable(),
  quietEnd: timeOfDay.nullable(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsInput>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  channels: { weeklySummary: ['app', 'push', 'email'], expiresTomorrow: ['app', 'push'], mealTime: ['app', 'push'], runningLow: ['app'], listChanged: [], receiptReady: ['app'] },
  quietStart: '22:00',
  quietEnd: '07:00',
};

export const pushSubscriptionInput = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

export type LocationInput = z.infer<typeof locationInput>;
export type IngredientInput = z.infer<typeof ingredientInput>;
export type ProductInput = z.infer<typeof productInput>;
export type UseAmountInput = z.infer<typeof useAmountInput>;
export type AdjustStockInput = z.infer<typeof adjustStockInput>;

// --- Recipes and cooking ------------------------------------------------------------

export const recipeIngredientInput = z.object({
  /** The line as written in the recipe ("2 large Maris Pipers, peeled"). */
  text: z.string().trim().min(1).max(300),
  amount: z.number().positive().max(100_000).nullish(),
  unit: z.string().trim().max(30).nullish(),
  ingredientId: id.nullish(),
  productId: id.nullish(),
  note: z.string().trim().max(200).nullish(),
  optional: z.boolean().default(false),
});

export const recipeInput = z.object({
  title: z.string().trim().min(1, 'Required').max(200),
  serves: z.number().int().min(1).max(100).default(4),
  steps: z.array(z.string().trim().min(1).max(4000)).max(100).default([]),
  imageUrl: z.url().nullish(),
  sourceUrl: z.url().nullish(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30).default([]),
  prepMinutes: z.number().int().min(0).max(10_000).nullish(),
  cookMinutes: z.number().int().min(0).max(10_000).nullish(),
  ingredients: z.array(recipeIngredientInput).max(100).default([]),
});
export type RecipeInput = z.infer<typeof recipeInput>;
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInput>;

export const importRecipeInput = z.object({ url: z.url() });

/** What was really used for one recipe line when cooking. */
export const cookLineInput = z.object({
  /** Packs to take from, with grams (or a share of the pack when its size isn't known). */
  takes: z
    .array(
      z.object({
        stockItemId: id,
        grams: z.number().positive().max(1_000_000).optional(),
        fraction: z.number().gt(0).max(1).optional(),
      }),
    )
    .max(20),
});

export const cookInput = z.object({
  servings: z.number().positive().max(500),
  /** The planned meal being cooked, which is then marked as cooked. */
  mealPlanEntryId: id.optional(),
  lines: z.array(cookLineInput).max(200).default([]),
  /** Portions to keep, per location: leftovers, or the whole batch for a batch cook. */
  leftovers: z
    .array(z.object({ locationId: id, portions: z.number().int().min(1).max(200) }))
    .max(10)
    .default([]),
});
export type CookInput = z.infer<typeof cookInput>;

// --- Planner ---------------------------------------------------------------------------

export const mealSlot = z.enum(MEAL_SLOTS);
const people = z.array(z.object({ userId: id, portions: z.number().positive().max(50) })).max(20);

export const planEntryInput = z
  .object({
    date: calendarDate,
    slot: mealSlot,
    kind: z.enum(['recipe', 'product', 'stock', 'text']),
    recipeId: id.nullish(),
    productId: id.nullish(),
    stockItemId: id.nullish(),
    text: z.string().trim().max(200).nullish(),
    servings: z.number().positive().max(100).default(1),
    kcalPerServing: z.number().min(0).max(10_000).nullish(),
    /** Who's eating it; leave out for the whole household. */
    people: people.default([]),
    /** Log it as eaten straight away (e.g. adding a banana you just had). */
    eaten: z.boolean().default(false),
  })
  .refine(
    (v) =>
      (v.kind === 'recipe' && v.recipeId) ||
      (v.kind === 'product' && v.productId) ||
      (v.kind === 'stock' && v.stockItemId) ||
      (v.kind === 'text' && v.text),
    'Pick what to plan',
  );
export type PlanEntryInput = z.infer<typeof planEntryInput>;

export const updatePlanEntryInput = z.object({
  date: calendarDate.optional(),
  slot: mealSlot.optional(),
  servings: z.number().positive().max(100).optional(),
  status: z.enum(['planned', 'cooked', 'skipped']).optional(),
  people: people.optional(),
});

/** Eating planned leftovers or a product takes it out of stock. */
export const eatPlanEntryInput = z.object({ fromStock: z.boolean().default(true) });

// --- Shopping list ------------------------------------------------------------------------

export const shoppingItemInput = z
  .object({
    text: z.string().trim().max(200).optional(),
    ingredientId: id.nullish(),
    productId: id.nullish(),
    packs: z.number().int().min(1).max(99).default(1),
    reason: z.enum(['manual', 'running-low']).default('manual'),
  })
  .refine((v) => v.text || v.ingredientId || v.productId, 'Say what to get');

export const updateShoppingItemInput = z.object({
  checked: z.boolean().optional(),
  packs: z.number().int().min(1).max(99).optional(),
  text: z.string().trim().min(1).max(200).optional(),
});

export const buildListInput = z.object({ from: calendarDate, to: calendarDate });
export const putAwayInput = z.object({ itemIds: z.array(id).max(200).optional() });

// --- Receipts ---------------------------------------------------------------------------

export const receiptTextInput = z.object({ text: z.string().trim().min(3).max(50_000) });

/** Lines read from a receipt by an assistant (MCP) or AI. */
export const receiptLinesInput = z.object({
  store: z.string().trim().max(80).nullish(),
  date: calendarDate.nullish(),
  lines: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(99).default(1),
        pricePence: z.number().int().min(0).max(1_000_000).nullish(),
      }),
    )
    .max(300),
});
export type ReceiptLinesInput = z.infer<typeof receiptLinesInput>;

export const updateReceiptLineInput = z.object({
  productId: id.nullish(),
  ingredientId: id.nullish(),
  quantity: z.number().int().min(1).max(99).optional(),
  skip: z.boolean().optional(),
  locationId: id.optional(),
  bestBefore: calendarDate.nullish(),
});
