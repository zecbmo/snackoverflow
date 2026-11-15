CREATE TABLE "food_favourites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "plan_kind" NOT NULL,
	"ref_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD COLUMN "nutrition" jsonb;--> statement-breakpoint
ALTER TABLE "food_favourites" ADD CONSTRAINT "food_favourites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_favourites" ADD CONSTRAINT "food_favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_meals" ADD CONSTRAINT "saved_meals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_meals" ADD CONSTRAINT "saved_meals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "food_favourites_user_food" ON "food_favourites" USING btree ("user_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "saved_meals_user_idx" ON "saved_meals" USING btree ("user_id");--> statement-breakpoint
-- Takeaways already logged get the macros of their menu item.
UPDATE "meal_plan_entries" SET "nutrition" = jsonb_strip_nulls(jsonb_build_object('kcal', c."kcal", 'protein', c."protein", 'carbs', c."carbs", 'sugars', c."sugars", 'fat', c."fat", 'saturates', c."saturates", 'fibre', c."fibre", 'salt', c."salt")) FROM "chain_menu_items" c WHERE c."id" = "meal_plan_entries"."chain_item_id" AND "meal_plan_entries"."nutrition" IS NULL;
