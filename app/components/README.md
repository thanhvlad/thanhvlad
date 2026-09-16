# Screen rules

Every screen in this app is built to the same anatomy, so a merchant who has
learned one screen has learned them all. This is what "professional" means in
an embedded Shopify app: not decoration, but a structure the eye can predict.
Polaris is the only visual language — Shopify rejects apps that look foreign
inside the admin — so the craft is in structure, hierarchy and honesty, not in
custom CSS.

## Page anatomy, top to bottom

1. **`<Page>`** with `title`, a one-line `subtitle` that says what the screen is
   for, and at most one `primaryAction`. Secondary actions go in
   `secondaryActions` or an `actionGroups` menu, never as loose buttons below.
   List screens take `fullWidth`.
2. **Result banner** — one `Banner` for the last action's outcome, tone chosen
   by the outcome (`success` / `warning` / `critical` / `info`), never
   `success` by default. Use `useMessage` / `useErrorMessage`.
3. **Stat strip** — `InlineGrid` of `Stat` (from `~/components/Stat`) when the
   screen has figures worth leading with. Four at most. Money uses
   `formatMoney`; every figure is `numeric`.
4. **Tabs** for states of one collection (order stages, import statuses),
   each tab label carrying its count: `Awaiting order (12)`.
5. **The table** — `IndexTable` for anything a merchant scans and acts on in
   bulk. Selectable rows, `promotedBulkActions` for the two or three actions
   that matter, a `Thumb` in the first column when the row is a product, money
   right-aligned with `numeric`, status as a `StatusBadge`, and the row's own
   link on the title. Cards-in-a-column are for detail screens, never for
   lists.
6. **Empty state** via `EmptyScreen` (from `~/components/EmptyScreen`): a
   heading that names the situation, one sentence of what to do, and the one
   button that does it. Never plain grey text saying "nothing here".
7. **Pagination** through `Paginator`.

## Detail screens (an order, a product, an import)

- Two-column `Layout`: the main column carries the thing itself; the side
  column carries status, cost figures and secondary actions.
- Group related fields into `Card`s with a `SectionHeader`
  (from `~/components/SectionHeader`): heading, optional count badge, optional
  action link on the right.
- Anything that spends money or cannot be undone gets a confirmation `Modal`.
  Destructive buttons carry `tone="critical"`.

## Feedback

- Every action reports back: banner for outcomes that need reading, `Toast`
  (App Bridge `shopify.toast.show`) for "Saved." level confirmations.
- Long jobs show `JobProgress`.
- Buttons show `loading` while their fetcher is busy, and are `disabled` when
  the action would be meaningless (nothing selected, already done).

## Copy

- Every string goes through `t()`. New keys live in the screen's own module
  under `app/lib/i18n-modules/`, namespaced by screen (`orders.table.customer`),
  with English and Vietnamese both written.
- Labels name the merchant's world, not the app's internals: "Supplier cost",
  not "PO total"; "Send to supplier", not "Place PO".
- Sentence case. Buttons are verbs. Errors say what went wrong and what to do.

## What not to do

- No inline `style={}` except to remove an underline from a `Link`.
- No custom CSS classes on app screens.
- No `Text` as a button; no `Button variant="plain"` where a `Link` reads.
- No stacking five full-width buttons in a card as "quick actions" — use an
  `ActionList` or a list of `Link`s with descriptions.
- No two components for the same job. Before writing a helper, look here.
