# Design mock-ups

Screenshots of the Snack Overflow mock-ups. They show layout, hierarchy and visual direction; the data in them is sample data. Where a mock-up and `docs/SPEC.md` disagree, the spec wins.

**Visual direction:** warm off-white background `#F6F5F1`, near-black ink `#1A1C1A`, violet accent `#6B4EFF` for primary actions (white text on it), cards with 16–20px radius and a 1px `#E6E3DC` border. Freshness colours: green fine, amber this week, red going off, blue frozen; used for nothing else. Headings in Bricolage Grotesque (600/700), body in Inter (400/500/600). Touch targets at least 44px.

## Phone (390 × 844)

| Screen | File | Notes |
| --- | --- | --- |
| Today | `phone-01-today.png` | Tonight's meal, use-soon strip, calories and waste, running low, coming up |
| Stock | `phone-02-stock.png` | Location filters, freshness colours, one row expanded with actions |
| Scan: Add | `phone-03-scan-add.png` | Continuous scanning into a location |
| Scan: Use | `phone-03-scan-use.png` | Takes items out of stock |
| Scan: Eat | `phone-03-scan-eat.png` | Logs food to the current meal and takes it out of stock |
| Planner | `phone-04-planner.png` | Per-person day view, several items per meal slot, scan or add per slot |
| Shopping | `phone-05-shopping.png` | One list by category, reasons per item, surplus tip, put away |
| Recipes | `phone-06-recipes.png` | Cook now / Nearly there / Use it up |
| Dashboard | `phone-07-dashboard.png` | Calories over 7 days with averages, waste this month |
| Menu | `phone-08-menu.png` | Everything not in the bottom bar |

Bottom bar on phone: Today, Stock, Scan (centre), Plan, Shop. Menu button at the top left of the main screens.

## Desktop / landscape (1440 wide)

| Screen | File | Notes |
| --- | --- | --- |
| Today | `desktop-01-today.png` | Sidebar navigation, week strip, use-soon table, side column |
| Planner | `desktop-02-planner.png` | Full week grid, several items per cell, suggestions panel |

On desktop there is no bottom bar or menu button: everything is in the left sidebar. Layouts reflow at narrower widths, and the sidebar moves above the content on very narrow screens.
