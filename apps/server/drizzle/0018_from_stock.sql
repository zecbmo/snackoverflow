ALTER TABLE "meal_plan_entries" ADD COLUMN IF NOT EXISTS "from_stock" boolean;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD COLUMN IF NOT EXISTS "kept_servings" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Food already taken from stock for a meal: that meal owns it from now on.
UPDATE "meal_plan_entries" SET "from_stock" = true WHERE "kind" IN ('product', 'stock', 'ingredient') AND EXISTS (SELECT 1 FROM "stock_events" ev WHERE ev."meal_plan_entry_id" = "meal_plan_entries"."id" AND ev."type" = 'use' AND ev."undone_at" IS NULL);
