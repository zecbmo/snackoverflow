CREATE TYPE "public"."display_unit" AS ENUM('g', 'ml', 'count');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('cupboard', 'fridge', 'freezer');--> statement-breakpoint
CREATE TYPE "public"."product_source" AS ENUM('off', 'manual', 'scan');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."stock_event_type" AS ENUM('add', 'use', 'open', 'move', 'freeze', 'defrost', 'discard', 'adjust');--> statement-breakpoint
CREATE TYPE "public"."stock_state" AS ENUM('closed', 'opened', 'frozen', 'defrosted');--> statement-breakpoint
CREATE TABLE "barcodes" (
	"household_id" uuid NOT NULL,
	"code" text NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "barcodes_household_id_code_pk" PRIMARY KEY("household_id","code")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"time_zone" text DEFAULT 'Europe/London' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"aisle" text,
	"shelf_life_category_id" uuid,
	"density_g_per_ml" double precision,
	"grams_per_count" double precision,
	"count_unit" text,
	"pack_sizes_grams" jsonb,
	"track_running_low" boolean DEFAULT false NOT NULL,
	"closed_days" integer,
	"opened_days" integer,
	"frozen_days" integer,
	"defrosted_days" integer,
	"nutrition_per_100g" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"email" text,
	"role" "role" DEFAULT 'member' NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "location_type" NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_log_user_id_type_key_pk" PRIMARY KEY("user_id","type","key")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text,
	"brand" text,
	"image_url" text,
	"ingredient_id" uuid,
	"shelf_life_category_id" uuid,
	"pack_grams" double precision,
	"pack_amount" double precision,
	"pack_unit" text,
	"display_unit" "display_unit" DEFAULT 'g' NOT NULL,
	"nutrition_per_100g" jsonb,
	"learned_closed_days" integer,
	"learned_frozen_days" integer,
	"source" "product_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shelf_life_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"examples" text DEFAULT '' NOT NULL,
	"default_location" "location_type" NOT NULL,
	"closed_days" integer,
	"opened_days" integer,
	"frozen_days" integer,
	"defrosted_days" integer,
	"freezable" boolean,
	"source" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"household_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"type" "stock_event_type" NOT NULL,
	"grams" double precision,
	"fraction" double precision,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"before" jsonb,
	"user_id" uuid,
	"meal_plan_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"state" "stock_state" DEFAULT 'closed' NOT NULL,
	"best_before" date,
	"added_on" date NOT NULL,
	"opened_on" date,
	"frozen_on" date,
	"defrosted_on" date,
	"fraction_left" double precision DEFAULT 1 NOT NULL,
	"initial_grams" double precision,
	"remaining_grams" double precision,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"password_hash" text,
	"oidc_subject" text,
	"notification_prefs" jsonb,
	"last_location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_shelf_life_category_id_shelf_life_categories_id_fk" FOREIGN KEY ("shelf_life_category_id") REFERENCES "public"."shelf_life_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shelf_life_category_id_shelf_life_categories_id_fk" FOREIGN KEY ("shelf_life_category_id") REFERENCES "public"."shelf_life_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_life_categories" ADD CONSTRAINT "shelf_life_categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_events" ADD CONSTRAINT "stock_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_events" ADD CONSTRAINT "stock_events_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_events" ADD CONSTRAINT "stock_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_events" ADD CONSTRAINT "stock_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "barcodes_product_idx" ON "barcodes" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ingredients_household_idx" ON "ingredients" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredients_household_key" ON "ingredients" USING btree ("household_id","key");--> statement-breakpoint
CREATE INDEX "locations_household_idx" ON "locations" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "products_household_idx" ON "products" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "products_ingredient_idx" ON "products" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shelf_life_household_key" ON "shelf_life_categories" USING btree ("household_id","key");--> statement-breakpoint
CREATE INDEX "stock_events_household_time_idx" ON "stock_events" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_events_item_idx" ON "stock_events" USING btree ("stock_item_id");--> statement-breakpoint
CREATE INDEX "stock_items_household_active_idx" ON "stock_items" USING btree ("household_id","finished_at");--> statement-breakpoint
CREATE INDEX "stock_items_product_idx" ON "stock_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_subject_unique" ON "users" USING btree ("oidc_subject");