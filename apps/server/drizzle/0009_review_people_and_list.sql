ALTER TABLE "meal_plan_entries" ADD COLUMN "batch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD COLUMN "food_group" text;