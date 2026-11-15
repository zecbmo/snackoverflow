/** Scaling nutrition to a serving, and adding up what's been eaten. */
import type { Nutrition } from './schemas';
import type { MacroTotals } from './types';

const KEYS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'saturates', 'fibre', 'salt'] as const;

/** Nutrition per 100g scaled to `grams`. Null when either isn't known. */
export function nutritionFor(per100g: Nutrition | null | undefined, grams: number | null | undefined): Nutrition | null {
  if (!per100g || !grams) return null;
  const out: Nutrition = {};
  let any = false;
  for (const k of KEYS) {
    const v = per100g[k];
    if (v == null) continue;
    out[k] = Math.round(((v * grams) / 100) * 10) / 10;
    any = true;
  }
  return any ? out : null;
}

/** True when protein, carbs and fat are all known. */
export function hasMacros(n: Nutrition | null | undefined): n is Nutrition & { protein: number; carbs: number; fat: number } {
  return n?.protein != null && n.carbs != null && n.fat != null;
}

/** Add up the macros of eaten foods: each with its nutrition per serving and how many servings were eaten. */
export function macroTotals(eaten: { nutritionPerServing: Nutrition | null; servings: number }[]): MacroTotals {
  const t: MacroTotals = { protein: 0, carbs: 0, fat: 0, missing: 0 };
  for (const e of eaten) {
    if (e.servings <= 0) continue;
    if (!hasMacros(e.nutritionPerServing)) {
      t.missing++;
      continue;
    }
    t.protein += e.nutritionPerServing.protein * e.servings;
    t.carbs += e.nutritionPerServing.carbs * e.servings;
    t.fat += e.nutritionPerServing.fat * e.servings;
  }
  return { protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat), missing: t.missing };
}
