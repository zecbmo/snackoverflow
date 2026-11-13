# Design guide

How Snack Overflow looks and behaves. Build new screens from these patterns and the shared components named below. The original phone-first mock-ups are kept in [`legacy/`](legacy/) for reference only; don't use them as the target any more.

The model is a desktop data tool in the style of Airtable: a collapsible sidebar, a toolbar on every list, dense tables whose row actions are always visible, and a side panel for one record. Phones get the same components in a compact list form.

## Colour

- Colours are palettes in `apps/web/src/palettes.css`, listed for the picker in `apps/web/src/lib/palettes.ts`. Each palette defines its neutrals, accent and "frozen" colour for light and dark. **Blue** is the default; people pick another per device in Settings → Appearance. Light, dark or "match device" is a separate per-device choice (`lib/theme.ts`).
- Use the tokens, never hex values in components: `bg`, `card`, `card-muted`, `ink`, `muted`, `line`, `accent`, `accent-ink`, `accent-soft`, `accent-text`, `strong`, `strong-ink`.
- **Accent** is for the one primary action on a view, the current selection and links. Everything else is neutral.
- **Freshness** colours are the same in every palette and mean only freshness: `fresh-red` (use first), `fresh-amber` (this week), `fresh-green` (fine). `frozen` marks frozen food; where the accent is already blue it is slate, and frozen pills always carry a snowflake. Freshness pills always carry words ("Tomorrow", "3 days"), never colour alone. The set passes colour-blind separation checks.
- Every text pair is at least 4.5:1 in both themes. When you add a palette, check it the same way.

## Type and density

- Inter everywhere. Bricolage Grotesque only for the "Snack Overflow" wordmark.
- Desktop (≥ 1024px wide with a mouse): 14px root size. Page titles 20px, section titles 16px, body and tables 14px, labels 12px. Controls are 28–32px tall, table rows about 40px.
- Phones: 16px root, page titles 24px, and touch targets at least 44px.
- Radii: 6px for controls, 8px for panels and tables (12px on phones). Hairline borders; one soft shadow for panels and menus.

## Layout

- **Sidebar** (`components/Layout.tsx`): 256px wide with icons and labels, or a 56px icon rail with tooltips. Collapse with the button at the top or the `[` key; remembered per device; collapsed by default below 1280px. Sections: main pages, Food, Insights, Household, then the profile at the bottom. Phones have the bottom bar (Today, Stock, Scan, Calendar, Shop) and the menu drawer instead; the drawer starts with Scan items and the main pages, then the same sections as the sidebar.
- **Page top** (`PageTop` in `components/Toolbar.tsx`): title, a short subtitle (count, date range) and the page's main actions on the right.
- **Toolbar** (`Toolbar`, `SearchBox`, `PickerMenu`, `Segmented`): Filter, Sort and Group pickers on the left, search on the right. A picker that isn't on its default is highlighted and says what it's set to. On phones the pickers scroll sideways under the search box.
- Content uses the full width beside the sidebar. Forms and reading pages cap their own width (about 46rem for settings, 65 characters for text).

## Lists: `DataTable`

- Every list of records is a `DataTable` (`components/DataTable.tsx`): a header row, optional groups (collapsible, with counts), optional checkboxes for bulk actions, and an **actions column that is always visible**. No hover-only actions.
- The record's name is a real button that opens it; clicking anywhere else on the row does the same.
- On phones the table becomes list rows: a coloured lead (freshness bar, checkbox or icon), name and one line of detail, a badge on the right, and the actions under it (the most used ones as buttons, the rest in "⋯"). Stock rows (Stock, Today's Use soon, Batch cooks) stay on one line like a table: Use and "⋯" at the end (Freeze or Defrost, Move and Bin are in the menu).
- Menus open fully on screen: placed by their measured width and kept inside the viewport.
- Bulk actions appear in a bar above the table when rows are ticked, with one Undo for the lot.
- Sort, filter and search helpers are pure functions in `lib/table.ts` with tests.

## One record: `SidePanel`

- Clicking a row opens the record in a `SidePanel` (`components/SidePanel.tsx`): 480px from the right on desktop, leaving the table usable; full screen on phones. The open record is in the address (`?open=id`), so links work and Back or Escape closes it. Recipes skip the panel on phones and open the full recipe page, whose header (Back, Cook, Batch cook, ⋯, then the title across the full width) stays at the top while scrolling.
- The same detail component is used on the record's own page (for example `StockItemDetail` on `/stock/:id`).
- `Sheet` (`components/ui.tsx`) is for short tasks and confirmations: a small centred dialog on desktop, a bottom sheet on phones.

## Menus

- `Menu` (`components/Menu.tsx`) is the "⋯" overflow menu and the base of the toolbar pickers. It opens below its button (or above, near the bottom of the screen), is keyboard-operable (arrows, Home/End, Escape) and isn't clipped by scrolling tables.

## Copy and accessibility

- UK English, short and friendly ("best-before", "Bin", "Use it up").
- Real buttons and links; every icon-only button has an `aria-label`; buttons on rows name their item ("Use Semi Skimmed Milk").
- Keyboard: everything reachable with Tab, a visible focus ring, Escape closes menus, sheets and panels.
