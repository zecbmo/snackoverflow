CREATE TABLE "app_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_scan_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"file" "bytea" NOT NULL,
	"file_type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"error" text,
	"recipe_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "swap_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingredients" ADD COLUMN "swap_group_id" uuid;--> statement-breakpoint
ALTER TABLE "meal_plan_entries" ADD COLUMN "swaps" jsonb;--> statement-breakpoint
ALTER TABLE "recipe_scan_images" ADD CONSTRAINT "recipe_scan_images_scan_id_recipe_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."recipe_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_scans" ADD CONSTRAINT "recipe_scans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_scans" ADD CONSTRAINT "recipe_scans_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_scans" ADD CONSTRAINT "recipe_scans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_groups" ADD CONSTRAINT "swap_groups_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_scan_images_scan_idx" ON "recipe_scan_images" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "recipe_scans_household_idx" ON "recipe_scans" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "swap_groups_household_idx" ON "swap_groups" USING btree ("household_id");--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_swap_group_id_swap_groups_id_fk" FOREIGN KEY ("swap_group_id") REFERENCES "public"."swap_groups"("id") ON DELETE set null ON UPDATE no action;