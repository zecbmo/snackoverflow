import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { HouseholdSettings, NotificationPrefs, Nutrition } from '@snackoverflow/shared';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });

export const roleEnum = pgEnum('role', ['admin', 'member']);
export const locationTypeEnum = pgEnum('location_type', ['cupboard', 'fridge', 'freezer']);
export const stockStateEnum = pgEnum('stock_state', ['closed', 'opened', 'frozen', 'defrosted']);
export const displayUnitEnum = pgEnum('display_unit', ['g', 'ml', 'count']);
export const productSourceEnum = pgEnum('product_source', ['off', 'manual', 'scan', 'receipt']);
export const receiptSourceEnum = pgEnum('receipt_source', ['photo', 'upload', 'email', 'text', 'mcp']);
export const receiptStatusEnum = pgEnum('receipt_status', ['reading', 'waiting', 'review', 'done', 'failed']);

/** Binary column. Always hands back a Buffer (PGlite returns a plain Uint8Array). */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
});
export const mealSlotEnum = pgEnum('meal_slot', ['breakfast', 'lunch', 'dinner', 'snack']);
export const planKindEnum = pgEnum('plan_kind', ['recipe', 'product', 'stock', 'text']);
export const planStatusEnum = pgEnum('plan_status', ['planned', 'cooked', 'skipped']);
export const shoppingReasonEnum = pgEnum('shopping_reason', ['plan', 'running-low', 'manual']);
export const stockEventTypeEnum = pgEnum('stock_event_type', [
  'add',
  'use',
  'open',
  'move',
  'freeze',
  'defrost',
  'discard',
  'adjust',
]);

export const households = pgTable('households', {
  id: id(),
  name: text('name').notNull(),
  timeZone: text('time_zone').notNull().default('Europe/London'),
  /** Optimiser and pricing choices (see HouseholdSettings); missing keys use the defaults. */
  settings: jsonb('settings').$type<Partial<HouseholdSettings>>(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: roleEnum('role').notNull().default('member'),
    passwordHash: text('password_hash'),
    oidcSubject: text('oidc_subject'),
    notificationPrefs: jsonb('notification_prefs').$type<NotificationPrefs>(),
    lastLocationId: uuid('last_location_id'),
    /** Daily calorie target for the dashboard; null = none set. */
    kcalTarget: integer('kcal_target'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    uniqueIndex('users_oidc_subject_unique').on(t.oidcSubject),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the token in the cookie; the raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invites = pgTable('invites', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  email: text('email'),
  role: roleEnum('role').notNull().default('member'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const locations = pgTable(
  'locations',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: locationTypeEnum('type').notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('locations_household_idx').on(t.householdId)],
);

/** Shelf-life defaults by food category, seeded from docs/data/shelf-life-defaults.csv. */
export const shelfLifeCategories = pgTable(
  'shelf_life_categories',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    examples: text('examples').notNull().default(''),
    defaultLocation: locationTypeEnum('default_location').notNull(),
    closedDays: integer('closed_days'),
    openedDays: integer('opened_days'),
    frozenDays: integer('frozen_days'),
    defrostedDays: integer('defrosted_days'),
    freezable: boolean('freezable'),
    source: text('source').notNull().default(''),
    notes: text('notes').notNull().default(''),
  },
  (t) => [uniqueIndex('shelf_life_household_key').on(t.householdId, t.key)],
);

export const ingredients = pgTable(
  'ingredients',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Seed key (e.g. "chopped_tomatoes"); null for ingredients added by hand. */
    key: text('key'),
    name: text('name').notNull(),
    aisle: text('aisle'),
    shelfLifeCategoryId: uuid('shelf_life_category_id').references(() => shelfLifeCategories.id, {
      onDelete: 'set null',
    }),
    densityGPerMl: doublePrecision('density_g_per_ml'),
    gramsPerCount: doublePrecision('grams_per_count'),
    countUnit: text('count_unit'),
    /** Typical pack sizes in grams, from docs/data/pack-sizes.csv. */
    packSizesGrams: jsonb('pack_sizes_grams').$type<number[]>(),
    /** How packs are sold: by weight (g), volume (ml) or count, for showing pack sizes. */
    packUnit: text('pack_unit'),
    trackRunningLow: boolean('track_running_low').notNull().default(false),
    closedDays: integer('closed_days'),
    openedDays: integer('opened_days'),
    frozenDays: integer('frozen_days'),
    defrostedDays: integer('defrosted_days'),
    nutritionPer100g: jsonb('nutrition_per_100g').$type<Nutrition>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ingredients_household_idx').on(t.householdId),
    uniqueIndex('ingredients_household_key').on(t.householdId, t.key),
  ],
);

export const products = pgTable(
  'products',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** null until someone names an unknown barcode. */
    name: text('name'),
    brand: text('brand'),
    imageUrl: text('image_url'),
    ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
    shelfLifeCategoryId: uuid('shelf_life_category_id').references(() => shelfLifeCategories.id, {
      onDelete: 'set null',
    }),
    packGrams: doublePrecision('pack_grams'),
    packAmount: doublePrecision('pack_amount'),
    packUnit: text('pack_unit'),
    displayUnit: displayUnitEnum('display_unit').notNull().default('g'),
    nutritionPer100g: jsonb('nutrition_per_100g').$type<Nutrition>(),
    learnedClosedDays: integer('learned_closed_days'),
    learnedFrozenDays: integer('learned_frozen_days'),
    source: productSourceEnum('source').notNull().default('manual'),
    /** Set for cooked meals (leftovers, batch-cook portions): the recipe they came from. */
    recipeId: uuid('recipe_id'),
    /** Weight of one portion, for meals counted in portions. */
    portionGrams: doublePrecision('portion_grams'),
    createdAt: createdAt(),
  },
  (t) => [index('products_household_idx').on(t.householdId), index('products_ingredient_idx').on(t.ingredientId)],
);

export const barcodes = pgTable(
  'barcodes',
  {
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.code] }), index('barcodes_product_idx').on(t.productId)],
);

/** One per pack. Finished packs keep their row (fraction 0) so history and undo work. */
export const stockItems = pgTable(
  'stock_items',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    state: stockStateEnum('state').notNull().default('closed'),
    bestBefore: day('best_before'),
    addedOn: day('added_on').notNull(),
    openedOn: day('opened_on'),
    frozenOn: day('frozen_on'),
    defrostedOn: day('defrosted_on'),
    fractionLeft: doublePrecision('fraction_left').notNull().default(1),
    initialGrams: doublePrecision('initial_grams'),
    remainingGrams: doublePrecision('remaining_grams'),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('stock_items_household_active_idx').on(t.householdId, t.finishedAt),
    index('stock_items_product_idx').on(t.productId),
  ],
);

export type StockSnapshot = Pick<
  typeof stockItems.$inferSelect,
  | 'locationId'
  | 'state'
  | 'bestBefore'
  | 'openedOn'
  | 'frozenOn'
  | 'defrostedOn'
  | 'fractionLeft'
  | 'remainingGrams'
  | 'finishedAt'
>;

/** Audit log of every stock change; powers undo, waste stats and usage estimates. */
export const stockEvents = pgTable(
  'stock_events',
  {
    id: id(),
    /** Strict order of events, for undo (timestamps can tie). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    stockItemId: uuid('stock_item_id')
      .notNull()
      .references(() => stockItems.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    type: stockEventTypeEnum('type').notNull(),
    /** Grams taken out (use/discard) or added (add); null when the pack size is unknown. */
    grams: doublePrecision('grams'),
    /** Share of the pack taken out or added. */
    fraction: doublePrecision('fraction'),
    fromLocationId: uuid('from_location_id'),
    toLocationId: uuid('to_location_id'),
    /** The pack as it was before this event, for undo. null for "add". */
    before: jsonb('before').$type<StockSnapshot>(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Link to a meal plan entry (used from phase 4). */
    mealPlanEntryId: uuid('meal_plan_entry_id'),
    /** The cook this use or leftover belongs to, so a whole cook can be undone. */
    cookId: uuid('cook_id'),
    createdAt: createdAt(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
  },
  (t) => [
    index('stock_events_household_time_idx').on(t.householdId, t.createdAt),
    index('stock_events_item_idx').on(t.stockItemId),
  ],
);

export const pushSubscriptions = pgTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
});

/** Which scheduled notifications have gone out, so each is sent once. */
export const notificationLog = pgTable(
  'notification_log',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** e.g. the date it was for. */
    key: text('key').notNull(),
    sentAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type, t.key] })],
);

/** Signed-in phones (the Android app). Each has its own long-lived token, sent as a Bearer header. */
export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the token; the raw token only ever lives on the phone. */
    tokenHash: text('token_hash').notNull().unique(),
    name: text('name').notNull(),
    platform: text('platform').notNull().default('android'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

/** One-time codes that hand a single sign-on login from the phone's browser back to the app. */
export const appLoginCodes = pgTable('app_login_codes', {
  codeHash: text('code_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** In-app notification inbox (the bell). The Android app checks it in the background. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    /** Strictly increasing, so phones can ask for "everything after N". */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    url: text('url'),
    actions: jsonb('actions').$type<{ action: string; title: string }[]>(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notifications_user_seq_idx').on(t.userId, t.seq)],
);

export const recipes = pgTable(
  'recipes',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    serves: integer('serves').notNull().default(4),
    steps: jsonb('steps').$type<string[]>().notNull().default([]),
    imageUrl: text('image_url'),
    sourceUrl: text('source_url'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    prepMinutes: integer('prep_minutes'),
    cookMinutes: integer('cook_minutes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recipes_household_idx').on(t.householdId)],
);

export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    id: id(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** The line as written. */
    text: text('text').notNull(),
    amount: doublePrecision('amount'),
    unit: text('unit'),
    ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    note: text('note'),
    optional: boolean('optional').notNull().default(false),
    /** The amount in grams, for matching and nutrition; null when it can't be worked out. */
    grams: doublePrecision('grams'),
  },
  (t) => [index('recipe_ingredients_recipe_idx').on(t.recipeId), index('recipe_ingredients_ingredient_idx').on(t.ingredientId)],
);

/** A recipe cooked (or batch cooked): the uses and leftovers it made share its id, for undo. */
export const cooks = pgTable('cooks', {
  id: id(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
  servings: doublePrecision('servings').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
});

/** One thing in a meal slot: a recipe, a product (a banana, a Snickers), leftovers from stock, or free text. */
export const mealPlanEntries = pgTable(
  'meal_plan_entries',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    date: day('date').notNull(),
    slot: mealSlotEnum('slot').notNull(),
    kind: planKindEnum('kind').notNull(),
    recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** Leftovers or a batch-cook portion already in stock. */
    stockItemId: uuid('stock_item_id').references(() => stockItems.id, { onDelete: 'set null' }),
    text: text('text'),
    /** Servings of a recipe, packs of a product, portions of leftovers. */
    servings: doublePrecision('servings').notNull().default(1),
    /** Calories per serving for free-text entries, if someone knows. */
    kcalPerServing: doublePrecision('kcal_per_serving'),
    status: planStatusEnum('status').notNull().default('planned'),
    /** How it got here: planned ahead, or logged by scanning in Eat mode. */
    source: text('source').notNull().default('plan'),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('meal_plan_household_date_idx').on(t.householdId, t.date)],
);

/** Who is eating a planned meal, and how much of it. No rows = the whole household. */
export const mealPlanPeople = pgTable(
  'meal_plan_people',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => mealPlanEntries.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portions: doublePrecision('portions').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.userId] })],
);

/** The one shared shopping list. */
export const shoppingItems = pgTable(
  'shopping_items',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** Free text, or the name to show. */
    text: text('text').notNull(),
    /** Grams the plan is short by (plan items). */
    grams: doublePrecision('grams'),
    packs: integer('packs').notNull().default(1),
    packGrams: doublePrecision('pack_grams'),
    /** Grams left over after this plan once the packs are bought. */
    surplusGrams: doublePrecision('surplus_grams'),
    reason: shoppingReasonEnum('reason').notNull().default('manual'),
    /** What the plan needs it for ("Fish pie, roast veg"). */
    forMeals: text('for_meals'),
    checked: boolean('checked').notNull().default(false),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('shopping_household_idx').on(t.householdId)],
);

/** A receipt being imported: read into lines, reviewed, then added to stock. */
export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    source: receiptSourceEnum('source').notNull(),
    /** reading: AI is reading it; waiting: needs reading (no AI key: send to your assistant); review; done; failed. */
    status: receiptStatusEnum('status').notNull(),
    store: text('store'),
    purchasedOn: day('purchased_on'),
    /** The photo or PDF, kept only until the receipt has been reviewed. */
    file: bytea('file'),
    fileType: text('file_type'),
    /** Pasted or emailed text. */
    rawText: text('raw_text'),
    error: text('error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [index('receipts_household_idx').on(t.householdId)],
);

export const receiptLines = pgTable(
  'receipt_lines',
  {
    id: id(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** Line total in pence. */
    pricePence: integer('price_pence'),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
    /** How it was matched: alias (learned), list, product, ingredient, none. */
    matchSource: text('match_source').notNull().default('none'),
    confidence: text('confidence').notNull().default('none'),
    /** Not food (bags, toiletries) or left out by the person reviewing. */
    skip: boolean('skip').notNull().default(false),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    bestBefore: day('best_before'),
  },
  (t) => [index('receipt_lines_receipt_idx').on(t.receiptId)],
);

/** Receipt wording this household has matched before ("TES SEMI SKM MLK 4PT" -> that milk). */
export const receiptAliases = pgTable(
  'receipt_aliases',
  {
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'cascade' }),
    /** Learned as "not food": skip it next time. */
    skip: boolean('skip').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.key] })],
);

/** Prices paid, mostly from receipts (used by the optimiser when pricing is on). */
export const prices = pgTable(
  'prices',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    store: text('store'),
    /** Price of one item, in pence. */
    pricePence: integer('price_pence').notNull(),
    date: day('date').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('prices_product_idx').on(t.productId)],
);
