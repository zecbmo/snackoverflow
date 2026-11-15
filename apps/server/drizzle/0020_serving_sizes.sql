ALTER TABLE "off_products" ADD COLUMN IF NOT EXISTS "serving_grams" double precision;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "serving_grams" double precision;