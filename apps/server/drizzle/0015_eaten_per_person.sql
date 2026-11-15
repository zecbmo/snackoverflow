ALTER TYPE "public"."plan_kind" ADD VALUE 'ingredient';--> statement-breakpoint
ALTER TYPE "public"."plan_kind" ADD VALUE 'chain';--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD COLUMN "ingredient_id" uuid;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD COLUMN "chain_item_id" uuid;--> statement-breakpoint
ALTER TABLE "meal_plan_people" ADD COLUMN "eaten_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meal_plan_people" ADD COLUMN "eaten_by" uuid;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_chain_item_id_chain_menu_items_id_fk" FOREIGN KEY ("chain_item_id") REFERENCES "public"."chain_menu_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_people" ADD CONSTRAINT "meal_plan_people_eaten_by_users_id_fk" FOREIGN KEY ("eaten_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Meals already marked cooked count as eaten for everyone who had a portion.
UPDATE "meal_plan_people" SET "eaten_at" = e."created_at" FROM "meal_plan_entries" e WHERE e."id" = "meal_plan_people"."entry_id" AND e."status" = 'cooked' AND e."batch" = false;
