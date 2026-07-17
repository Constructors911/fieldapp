# Shared components (Agent B)

Reusable, mobile-first building blocks. All styling lives in `components.css` (plus
`screens.css` for Clock/Today screen layouts) and uses only `styles/tokens.css` variables.
Touch targets are >= 44px (`--tap`). Import any component individually:

```js
import Card from '../components/Card.jsx';
```

## Card
White surface container with optional header.

| Prop | Type | Notes |
|---|---|---|
| `title` | string | optional header title |
| `action` | node | optional right-aligned header content (e.g. a button) |
| `className` | string | extra classes |
| `children` | node | body |

## Sheet
Bottom modal. Returns `null` when closed. Closes on overlay tap, X, or Escape.

| Prop | Type | Notes |
|---|---|---|
| `open` | bool | required |
| `title` | string | header + aria-label |
| `onClose` | fn | required |
| `children` | node | scrollable body |

## PickerSheet
`Sheet` wrapping a tap-to-select option list.

| Prop | Type | Notes |
|---|---|---|
| `open`, `title`, `onClose` | | same as Sheet |
| `options` | `[{ id, label, sub? }]` | `sub` renders as a smaller second line |
| `onSelect` | `(option) => void` | called with the tapped option object |
| `emptyText` | string | shown when `options` is empty |

## Spinner
| Prop | Type | Notes |
|---|---|---|
| `label` | string | text beside spinner (default "Loading…") |
| `size` | number | px, default 22 |
| `inline` | bool | render just the spinning dot, no wrapper/padding |

## EmptyState
| Prop | Type | Notes |
|---|---|---|
| `icon` | string | emoji/char, optional |
| `title` | string | required |
| `hint` | string | secondary line |
| `action` | node | e.g. a retry `<button className="c-btn">` |

## ErrorBanner
Renders `null` when `message` is falsy.

| Prop | Type | Notes |
|---|---|---|
| `message` | string | error text |
| `onRetry` | fn | shows a Retry button |
| `onDismiss` | fn | shows an X (only when no `onRetry`) |

## Checkbox
44px-square tappable checkbox (`role="checkbox"`).

| Prop | Type | Notes |
|---|---|---|
| `checked` | bool | |
| `onChange` | fn | called with no args |
| `disabled` | bool | |
| `label` | string | aria-label |

## Button classes (CSS only, no component)
Use `<button className="c-btn">` with modifiers: `c-btn-block` (full width),
`c-btn-big` (56px tall), `c-btn-green`, `c-btn-red`, `c-btn-ghost`.
Form helpers: `c-label`, `c-input`. Status pills: `c-pill` + `c-pill-red|orange|muted`.
