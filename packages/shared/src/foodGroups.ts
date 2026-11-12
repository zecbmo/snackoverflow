/** Food groups, shown as "Category" in stock and on the shopping list. Ingredients get theirs from docs/data/ingredients.csv; products can override. */
export const FOOD_GROUPS = [
  'Meat',
  'Fish & Seafood',
  'Fruit',
  'Vegetables',
  'Bread & Bakery',
  'Dairy',
  'Grains & Cereals',
  'Tinned & Canned Food',
  'Frozen Food',
  'Dried Food',
  'Chilled & Prepared Food',
  'Snacks',
  'Sweets & Confectionery',
  'Sauces & Condiments',
  'Herbs & Spices',
  'Oils & Fats',
  'Drinks',
] as const;

export type FoodGroup = (typeof FOOD_GROUPS)[number];

export function isFoodGroup(s: string | null | undefined): s is FoodGroup {
  return !!s && (FOOD_GROUPS as readonly string[]).includes(s);
}
