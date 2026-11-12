import { sql } from 'drizzle-orm';
import {
  bigserial,
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
import type { NotificationPrefs, Nutrition } from '@snackoverflow/shared';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });

export const roleEnum = pgEnum('role', ['admin', 'member']);
export const locationTypeEnum = pgEnum('location_type', ['cupboard', 'fridge', 'freezer']);
export const stockStateEnum = pgEnum('stock_state', ['closed', 'opened', 'frozen', 'defrosted']);
export const displayUnitEnum = pgEnum('display_unit', ['g', 'ml', 'count']);
export const productSourceEnum = pgEnum('product_source', ['off', 'manual', 'scan']);
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
