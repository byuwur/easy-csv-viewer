# byuwur/easy-csv-viewer

![easy-csv-viewer preview](prev.jpg)

**CSV, every cell in sight.**

Turn CSV, TSV, or arrays of records into a table with search, sorting, filters, and pagination.

Use it for exports, reports, and tabular data that people need to browse and copy.

One JavaScript file. One scoped stylesheet. No build step. Plain JavaScript, with no runtime dependencies.

[Open the playground](https://byuwur.github.io/easy-csv-viewer/)

Open `index.html` for the local playground; its page assets require internet access.

## Installation and usage

**Recommended: CDN.** No downloads or package manager.

```html
<link href="https://cdn.jsdelivr.net/gh/byuwur/easy-csv-viewer@latest/csv.css" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/gh/byuwur/easy-csv-viewer@latest/csv.js" defer></script>
<div id="viewer" data-theme="light"></div>
<script>
  document.addEventListener("DOMContentLoaded", () => {
    byCSVviewer(document.getElementById("viewer"), "name,score\nAndres,10\nSam,8");
  });
</script>
```

The CDN example uses `@latest` and requires internet access. Use a published tag or commit to pin a version.

**Local files:** For offline use, save `csv.js` and `csv.css` beside your HTML:

```html
<link href="csv.css" rel="stylesheet" />
<script src="csv.js" defer></script>
```

Exported HTML starters use default settings, independently of playground changes.

Use `{ delimiter: "\t" }` for TSV, or pass `[{ name: "Andres", score: 10 }]`. Without a second argument, the target's text is used. Input never becomes HTML.

## Options

| Option             | Default     | Behavior                                                                                                                          |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `delimiter`        | `","`       | One character, excluding quote, BOM, CR, and LF. No autodetection.                                                                |
| `headers`          | `true`      | First text/array row supplies names. False generates `Column 1`, etc. Record input always uses its union of own keys.             |
| `skipEmptyLines`   | `true`      | Skip physically empty lines. Quoted empty cells and delimiter-only rows remain.                                                   |
| `pageSize`         | `50`        | Rows per page, integer 1–1000; invalid values use 50.                                                                             |
| `search`           | `false`     | Global case-insensitive substring search, including hidden columns.                                                               |
| `columnFilters`    | `false`     | Per-column substring filters; combined with search using AND. Hidden filters remain active.                                       |
| `visibleColumns`   | all         | Array of zero-based indices or column names. Duplicate names match every column with that name; an empty array hides all columns. |
| `copyCells`        | `false`     | Cells become keyboard-accessible copy buttons, keeping the same text and spacing.                                                 |
| `toolbar`          | `true`      | Show the viewer header; secondary tools are configured separately.                                                                |
| `credits`          | `true`      | Show attribution in the header.                                                                                                   |
| `statusBar`        | `true`      | Show counts and metadata. Loading, errors, and empty results remain visible.                                                      |
| `columnsButton`    | `false`     | Show the column chooser.                                                                                                          |
| `sorting`          | `true`      | Cycle ascending, descending, then input order; arrows show its direction.                                                         |
| `pagination`       | `true`      | Paginate large tables. The pager appears only with multiple pages; false shows every row.                                         |
| `themeToggle`      | `true`      | Show the theme toggle.                                                                                                            |
| `fontSizeControls` | `true`      | Show text-size controls.                                                                                                          |
| `copyButton`       | `true`      | Copy original text, or CSV serialized from record/row input, including hidden/filtered rows.                                      |
| `controlsSize`     | `"regular"` | `"small"`, `"regular"`, or `"large"`; invalid values use `"regular"`.                                                             |
| `controlsCompact`  | `true`      | Keep credits beside controls; `false` stacks them. Wraps as needed.                                                               |
| `controlsPosition` | `"top"`     | Sticky `"top"` or `"bottom"` toolbar; invalid values use `"top"`.                                                                 |

## API and data contract

`byCSVviewer(element, input?, options?)` returns `{ ready, destroy }`. `ready` resolves `true` after initial rendering, or `false` on a displayed data error, cancellation, or disposal. Invalid targets or delimiters throw `TypeError`. Re-rendering disposes the previous instance; `destroy()` cancels pending work and clears the target only if the instance still owns it.

`byCSVviewer.parse(input, options?)` uses the same parser and synchronously returns `{ columns: string[], rows: unknown[][] }`. Invalid input throws `TypeError`, `SyntaxError`, or `RangeError`. Read the release version with `byCSVviewer.VERSION`. Duplicate script loads preserve the API.

CSV strings remain strings, including leading zeros and whitespace. Quoted delimiters, doubled quotes, CR/LF/CRLF, BOM, and embedded line breaks are supported. A quote must start a field; after its closing quote only a delimiter or line ending is accepted. Unequal field counts are errors.

Array/record values retain scalar types; null/missing values display as empty. Nested objects are rejected. Caller arrays are unchanged. Only own keys are used, including `__proto__`.

Column headers cycle through ascending, descending, and reset to input order. Sorting is natural and case-insensitive; ties keep input order. Reset retains active filters. Filtering leaves source data unchanged.

Cell copy preserves the exact value, including empty strings. Copy requires clipboard permission in a secure context.

`ready` describes the initial render only; it does not track later filtering, sorting, or page changes.

```javascript
const viewer = byCSVviewer(target, csv, { search: true });
const rendered = await viewer.ready; // false on data errors or cancellation.
viewer.destroy(); // Call when the host panel is removed.
```

## Appearance and limits

Style `.byCSVdocument` with `--by-view-bg`, `--by-view-text`, `--by-view-muted`, `--by-view-border`, `--by-view-accent`, and `--by-view-alt`. Set typography on the target or its class.

Wide tables scroll horizontally instead of squeezing columns. Explicit line breaks are preserved; cell copy feedback leaves values in place.

Limits: 10 million text-input characters, 100,000 data rows, and 500 columns. Pagination mounts one page of up to 1,000 rows; `pagination: false` mounts every matching row. Browser parsing/filtering yield. `.parse()` and native sorting are synchronous; large cells or records can still block.

Delimiter guessing, type inference, formulas, nested records, and spreadsheet editing are unsupported. Formula-like text is displayed and copied verbatim, never evaluated.

Requires a modern browser with ES2022 (`Object.hasOwn`), async functions, WeakMap, Intl.Collator, and CSS variables. Tests run in Chromium; other engines are unverified.

`--by-view-content-font` and `--by-view-line-height` set source/tree typography.

Use `toolbar: false` to hide the header, or disable `credits`, `themeToggle`, `fontSizeControls`, and `copyButton` individually. Content actions such as search and format-specific buttons use their own options.

Controls use monospace by default; override `--by-view-controls-font` to change it.

## Themes

The outer document and inner surfaces have independent CSS backgrounds. Both follow the selected theme unless overridden. Set `--by-view-document-bg: transparent` to reveal the host page while keeping content panels and individual controls readable. `--by-view-container-bg` sets the shared background of those panels and controls; it also accepts alpha colors or `transparent`. The toolbar and credits have no background. These overrides survive theme changes.

```css
.byCSVdocument {
  --by-view-document-bg: transparent;
}
```

`csv.css` includes all palettes in Light and Dark. Monokai is the default.

| Palette           | `data-theme`    | What it looks like                                                |
| ----------------- | --------------- | ----------------------------------------------------------------- |
| Monokai (default) | `monokai`       | Warm light and dark colors.                                       |
| GitHub            | `github`        | Familiar neutral surfaces and syntax colors.                      |
| Solarized         | `solarized`     | Warm light or deep blue-green dark surfaces.                      |
| High Contrast     | `high-contrast` | Black/white surfaces, strong text, borders, and focus indicators. |

Use a mode class and a palette name together:

```html
<div id="viewer" class="dark" data-theme="github"></div>
<!-- High Contrast Light: class="light" data-theme="high-contrast" -->
<!-- High Contrast Dark: class="dark" data-theme="high-contrast" -->
```

Rendering adds `.byCSVdocument`; its variables affect only that container and its children. The theme switch changes mode while keeping the palette; re-rendering preserves both. A named palette without a mode class starts in Light; if both mode classes are present, Dark wins.

`data-theme="light"` and `data-theme="dark"` select Monokai and override mode classes. A mode class alone, or no explicit theme, also uses Monokai.

### High Contrast

High Contrast text colors target at least [7:1 contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced.html), with [3:1 contrast for control boundaries and focus cues](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Check contrast again when you override colors.

### Make it yours

The playground's **Custom theme CSS** field edits both modes of the selected palette. Export those rules to your own stylesheet and use `data-theme="custom"` with `class="light"` or `class="dark"`. Custom drafts stay in the playground; the renderer does not store them.

Define a named palette after the viewer stylesheet. Unspecified colors inherit Monokai:

```css
.byCSVdocument.light[data-theme="ocean"] {
  --by-view-bg: #f3f8fc;
  --by-view-text: #102a43;
  --by-view-border: #486581;
  --by-view-accent: #005a9c;
}

.byCSVdocument.dark[data-theme="ocean"] {
  --by-view-bg: #102a43;
  --by-view-text: #f0f6fc;
  --by-view-border: #9fb3c8;
  --by-view-accent: #8cd3ff;
}
```

```html
<div id="viewer" class="dark" data-theme="ocean"></div>
```

Named palettes need no JavaScript registration or extra theme files.

In the playground configuration, `theme` is the mode, `palette` is its name, and `customThemeCSS` holds custom rules. Null appearance values inherit defaults. Pass only documented API options to the renderer.

**Copy CSS** exports typography and individual color overrides. Inline colors override palette variables; clear them or Reset to restore palette defaults.

Text-size controls change only this viewer, in `0.125rem` steps from `0.5rem` to `3rem`, independently of button size. **A** restores its initial size; re-rendering preserves the selected size.

### Legacy theme links

Legacy integrations can use `#byVIEWtheme` or a detected `csv.light.css` / `csv.dark.css` link. The toggle keeps its path, query, and hash and updates viewers sharing the link. Explicit container themes stay independent. Separate theme files are no longer shipped; retain your hosted legacy files to use this alternative.

## Checks

Theme tests cover both modes, container isolation, legacy links, custom CSS, and High Contrast. Clipboard tests use stubs; they do not verify real permissions.

Install Playwright outside the repository and set `NODE_PATH` to its `node_modules` directory:

```sh
node --check csv.js
node --test tests/rendering.cjs
```

`BROWSER_CHANNEL=chrome` uses installed Chrome; `CHROMIUM_EXECUTABLE_PATH` selects a Chromium executable. Otherwise, install Playwright Chromium. [GitHub Actions](.github/workflows/rendering.yml) runs the same suite.

## The easy viewers

Need another format, or a Markdown editor? Explore the family:

[Markdown](https://github.com/byuwur/easy-md-viewer) · [JSON](https://github.com/byuwur/easy-json-viewer) · [CSV & TSV](https://github.com/byuwur/easy-csv-viewer) · [Logs](https://github.com/byuwur/easy-log-viewer) · [Diff](https://github.com/byuwur/easy-diff-viewer) · [XML](https://github.com/byuwur/easy-xml-viewer) · [YAML](https://github.com/byuwur/easy-yaml-viewer) · [Source code](https://github.com/byuwur/easy-code-viewer)

[Write Markdown with easy-md-editor](https://github.com/byuwur/easy-md-editor).

## License

MIT (c) 2026 Andres Trujillo [Mateus] byUwUr. See [LICENSE](LICENSE).
