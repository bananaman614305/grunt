# Grunt interface system

The admin console extends the established identity in `site/index.html`. It is
an operational surface: familiar controls, precise information and responsive
density take priority over decorative effects.

## Tokens

| Token | Value | Purpose |
| --- | --- | --- |
| Background | `#0d121c` | Main canvas |
| Panel | `#141b28` | Navigation and grouped controls |
| Raised surface | `#1a2332` | Hover and selected controls |
| Foreground | `#ede6d8` | Primary text |
| Secondary text | `#a3adbd` | Labels and supporting information |
| Divider | `#303b4d` | Table and section boundaries |
| Accent | `#f2b531` | Grunt identity, current navigation and primary action |
| Accent foreground | `#1a1406` | Text on gold |
| Success | `#80d6ad` | Observed successful state |
| Warning | `#f2c66d` | Limited or waiting state |
| Failure | `#f29e9e` | Failed request or error |
| Activity | `#8ac9e8` | Active work |

Use the local system sans stack for the console; its information hierarchy does
not depend on remotely hosted fonts. Use a monospace stack only for identifiers,
model names, measurements and transport fields. Numeric values are tabular.

## Admin surface

- A fixed navigation column on wide screens becomes a horizontal navigation
  strip on mobile.
- Overview is a state summary followed by provider and request tables. Tables,
  dividers and carefully grouped labels carry the composition.
- Instance selection, freshness, refresh and export remain available above the
  current view.
- Selecting a request opens its timeline in a side panel on wide screens and an
  accessible full-width dialog on phones.
- Unknown, unreported, offline, unauthorized, loading and empty states have
  explicit copy. Old data remains visible with its age when refresh fails.
- Semantic states always use words as well as color. No fabricated totals,
  sparklines or implied healthy states appear without data.

## Interaction

Controls have at least a 44px touch target. Keyboard focus uses a visible gold
outline. Motion is limited to short state transitions; reduced-motion settings
disable those transitions. Untrusted server text is inserted as text, never
HTML. A successful Google session determines access; the browser stores no
provider credential or session token in local storage.
