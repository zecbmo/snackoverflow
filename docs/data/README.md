# Seed data

Starting defaults the app ships with. Every value is a **default the user can override**, and the app learns from those edits (see the spec, "Scan in"). None of this replaces the date printed on a pack.

| File | What it is |
| --- | --- |
| `shelf-life-defaults.csv` | Days an item keeps by category: closed, opened, frozen and defrosted |
| `unit-conversions.csv` | Fixed unit sizes, densities for volume → grams, and typical weights for counted items |
| `pack-sizes.csv` | Typical UK supermarket pack sizes, used to round shopping-list amounts to whole packs |
| `ingredients.csv` | The starting ingredient list: aisle, which shelf-life category, density and count keys (from `unit-conversions.csv`), pack-size key, "track running low", and alternative names used to match scanned products. It holds no numbers of its own |

## Safety rules (from UK food-safety guidance — hard-code these, don't make them editable defaults)

- Food can be frozen any time up to midnight on its use-by date. ([FSA](https://www.food.gov.uk/news-updates/campaigns-0/germwatch/science-fsw/freezing)) The app warns when freezing something past its date (or food that doesn't freeze well) but leaves the choice to the household, because best-before dates are often only about quality.
- Defrosted food must be used within 24 hours and not refrozen; raw food defrosted and then cooked can be frozen again, and reheated only once. ([FSA](https://www.food.gov.uk/news-updates/campaigns-0/germwatch/science-fsw/freezing))
- Food in the freezer stays safe but loses quality; the FSA suggests eating frozen food within 3–6 months. ([resource.co, reporting FSA](https://resourcemedia.eco/article/how-using-your-freezer-pause-button-could-help-fight-against-food-waste-11217))
- Leftovers: cool and refrigerate within 2 hours, eat within 2 days or freeze. Rice dishes: 1 day. Reheat only once. ([FSA](https://www.food.gov.uk/research/fy2-wave-9-chapter-6-eating-at-home), [FSA Christmas guidance](https://www.food.gov.uk/print/pdf/node/3381))
- Perishable food with no storage instructions: refrigerate and eat within 2 days. Opened tins: move the contents into a container, never store food in the opened can. ([Food Standards Scotland](https://www.foodstandards.gov.scot/consumers/food-safety/at-home/storage))
- An "eat within X days of opening" instruction never extends past the use-by date: new best-before = the earlier of (current date, today + opened days).

## How the app applies the table

- **Scan in (closed):** best-before = today + `closed_days`, unless the product has a learned value.
- **Opened:** best-before = min(current best-before, today + `opened_days`).
- **Frozen:** best-before = today + `frozen_days`. When `freezable` is `no`, freezing still works after a warning.
- **Defrosted:** best-before = today + `defrosted_days` (1 for anything perishable).
- An empty cell means "not applicable"; the app falls back to the closed value or hides the action.

## Where the numbers come from

The `source` column on each row says how firm it is:

- `FSA` / `FSS`: UK Food Standards Agency / Food Standards Scotland guidance (links above).
- `Which`: Which? freezing guide ([1](https://www.which.co.uk/news/article/surprising-foods-you-cant-freeze-and-a-reminder-of-what-you-can-a6OC96w04H0B), [2](https://www.which.co.uk/news/article/how-to-freeze-and-defrost-food-safely-a83yo6z3mxc1)).
- `label`: typical wording on UK packs for that category; real packs vary (the FSA notes cheddar brands say anything from 3 to 7 days once opened).
- `estimate`: a reasonable default with no single authoritative source. Expect users to correct these; the learning feature exists for exactly this.

Unit conversions and pack sizes are typical values, not sourced measurements; treat them all as `estimate`.
