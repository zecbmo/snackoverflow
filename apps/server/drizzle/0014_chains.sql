CREATE TABLE "chain_menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_key" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"section" text,
	"serving" text,
	"serving_g" double precision,
	"kcal" double precision NOT NULL,
	"fat" double precision,
	"saturates" double precision,
	"carbs" double precision,
	"sugars" double precision,
	"fibre" double precision,
	"protein" double precision,
	"salt" double precision,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"source_url" text,
	"retrieved_on" date,
	"seed_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_menu_items" ADD CONSTRAINT "chain_menu_items_chain_key_chains_key_fk" FOREIGN KEY ("chain_key") REFERENCES "public"."chains"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_menu_items_key" ON "chain_menu_items" USING btree ("chain_key","key");--> statement-breakpoint
CREATE INDEX "chain_menu_items_chain_idx" ON "chain_menu_items" USING btree ("chain_key","sort_order");