CREATE TABLE "swap_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"other_ingredient_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swap_exclusions" ADD CONSTRAINT "swap_exclusions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_exclusions" ADD CONSTRAINT "swap_exclusions_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_exclusions" ADD CONSTRAINT "swap_exclusions_other_ingredient_id_ingredients_id_fk" FOREIGN KEY ("other_ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "swap_exclusions_pair" ON "swap_exclusions" USING btree ("household_id","ingredient_id","other_ingredient_id");