-- Trigram search on product names (pg_trgm is a trusted extension, in the standard Postgres images).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "off_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"status" text NOT NULL,
	"country" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"lines" integer DEFAULT 0 NOT NULL,
	"products" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "off_products" (
	"barcode" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"quantity" text,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_url" text,
	"nutrition_per_100g" jsonb,
	"scans" integer DEFAULT 0 NOT NULL,
	"search" text NOT NULL,
	"import_id" uuid
);
--> statement-breakpoint
CREATE INDEX "off_products_search_idx" ON "off_products" USING gin ("search" gin_trgm_ops);