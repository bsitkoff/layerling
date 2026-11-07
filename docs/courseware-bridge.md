# CourseWare bridge

This fork (`bsitkoff/layerling`) adds one thing to upstream layerling: a CourseWare lesson page can embed the editor in an iframe, limit its tools, open the right design, and collect a submission. Outside that iframe the fork behaves exactly as upstream.

The CourseWare side is tracked in the private CourseWare repo, issue #1540. Tutorial lessons (Papermorph) talk to the CourseWare page, never to this editor. Their message contract is in that issue.

## The changes

| File | What it does |
|---|---|
| `apps/web/src/lib/coursewareBridge.ts` | Embed detection, origin checks, message parsing, one design per lesson key, packing a submission |
| `apps/web/src/lib/useCoursewareEmbed.ts` | The start page's half: opens the lesson's design, hides the start page |
| `apps/web/src/lib/simpleMode.ts` | Lesson tool and shape lists replace the simple mode's defaults; the embed locks simple mode on |
| `components/workplane/SecondaryToolbar.tsx` | Re-renders when the lists change |
| `components/LayerlingEditor.tsx` | Hands its command runner (the one the MCP connection uses) to the bridge |
| `app/page.tsx`, `app/layout.tsx` | Hook call, no start page or home button in the embed, boot script |
| `components/AppFooter.tsx` | The embed's only link out: **Source** (AGPL-3.0 section 13) |
| `app/courseware.css` | Source link style; empty ribbon sections hidden; a compact shape panel (small Solid/Hole card; no Wrap around a cylinder, Surface texture, texture mask or Save-as-default) so Length, Width and Height fit at 1366×768 |
| `apps/web/public/_headers`, `.assetsignore`, `wrangler.jsonc` | Cloudflare hosting |
| `scripts/generate-service-worker.mjs` | Skips the two Cloudflare files in the offline cache |

Keep it this small. Upstream ships several releases a day, and every extra touch point is a merge conflict.

## When the bridge is active

All three must hold:

1. The address has `?embed=courseware`. The flag is kept in `sessionStorage` because the editor rewrites the address.
2. The page is inside a frame.
3. The framing page's origin is in `NEXT_PUBLIC_COURSEWARE_ORIGINS` (comma-separated, set at build time; the default is `https://cscourseware.org`). Chrome reports the origin with `location.ancestorOrigins`; other browsers fall back to the referrer.

Every message in is accepted only from `window.parent` at that origin, and every message out is posted only to it.

## Messages

Envelopes:
- CourseWare → editor: `{ source: "courseware-cad", version: 1, type, ... }`
- Editor → CourseWare: `{ source: "layerling-editor", version: 1, type, ... }`

Binary fields are `ArrayBuffer`s; send them as transferables.

### CourseWare → editor

| type | fields | effect |
|---|---|---|
| `init` | `lessonKey` (required, opaque, 200 characters or fewer: make it per student **and** lesson), `title?`, `tools?`, `shapes?`, `starterLyl?`, `submittedLyl?` | Applies the limits, then opens the lesson's design: the one this browser already has for `lessonKey`; else `submittedLyl`; else `starterLyl`; else an empty design named `title`. Sending `init` again for the open key changes nothing but the limits. |
| `limits` | `tools?`, `shapes?` | Replaces the lists, e.g. for a tutorial step. |
| `load` | `lyl`, `title?` | Opens these bytes as the lesson's new design ("Start this step from a fresh copy", "Continue from my submission"). The previous design stays in this browser but is no longer the lesson's. |
| `request-submission` | `requestId`, `include3mf?`, `checkPrint?` | Packs the open design and answers with `submission` or `submission-error`. |
| `review` | `lyl`, `title?` | Grading and peer review: opens a submitted file as a throwaway copy. It never becomes a lesson's design, and the previous review copy is deleted. Send `limits` too if the reviewer should see more or fewer tools. Don't send `request-submission` in this mode. |

`tools` and `shapes` take an array of ids or `"all"`; leaving them out means the simple-mode defaults. The lists apply everywhere a tool can be reached in the simple mode: the ribbon, the built-in keys (group Ctrl+G, bundle Ctrl+B, ungroup Ctrl+Shift+G, align L, mirror M, fillet B, chamfer Shift+B, drop D), custom keys, and the right-click menu, whose tool entries use these ids too (`SIMPLE_MODE_MENU_TOOLS`: also `cutOut`, `punch`, `hollow`, `offset`, `deleteFace`, `carry`, ...). The Ctrl+K command search does not open in the simple mode at all (upstream). The ids are ribbon tool ids and shape catalogue ids. The defaults and examples are `SIMPLE_MODE_TOOLS` and `SIMPLE_MODE_SHAPES` in `lib/simpleMode.ts`. The clipboard group, Shapes, and File are always shown. A section whose tools are all filtered out disappears.

### Editor → CourseWare

| type | fields | when |
|---|---|---|
| `ready` | | The start page has loaded the stored designs. Send `init` after this. |
| `opened` | `lessonKey`, `from`: `local` / `submission` / `starter` / `blank` / `loaded` / `review` | The lesson's design (or the review copy, with `lessonKey` `__review__`) is open. |
| `submission` | `requestId`, `lyl`, `thumbnailPng` (or null), `threeMf` (or null), `designHash`, `objectCount`, `printCheck` | Answer to `request-submission`. |
| `submission-error` | `requestId`, `code`: `empty` / `busy` / `failed`, `message` | Nothing to submit, the student is mid-action (or the history view is open), or the export failed. `message` is shown to the student as is. |
| `error` | `message` | A file sent with `init` or `load` would not open. |

Notes on `submission`:
- `lyl` is saved **without undo history**, which keeps it small (about 110 KB for a simple design including the thumbnail).
- `designHash` is a SHA-256 of the design's object graphs and asset hashes. It ignores the project name, ids and timestamps, so an unchanged design resubmitted gives the same hash, which CourseWare's unchanged-resubmission rule can use.
- `threeMf` (only with `include3mf`) is the export window's 3MF: visible solids, holes cut, separated by colour.
- `printCheck` (only with `checkPrint`) is the editor's own print check over every object: thin walls, floating pieces, small contact with the plate, overhangs at 45°, open meshes. CourseWare can show it as a warning for no-supports lessons.

## Storage in the browser

- Designs live in this origin's IndexedDB and `localStorage`, as upstream.
- `cad.cscourseware.org` is the same *site* as `cscourseware.org`, so Chrome does not partition that storage inside the iframe.
- The map from lesson key to design id is `localStorage["layerling.coursewareLessons"]`.

## Build and deploy

```bash
npm ci
npm test && npm run typecheck
npm run export                  # → apps/web/.next-export (about 150 MB, 740 files; largest file 20.3 MiB, under the 25 MiB limit)
wrangler whoami                 # must be the work account (bridget_sitkoff@milton.edu's Account)
wrangler deploy                 # Worker "layerling-cad" at cad.cscourseware.org
```

`wrangler` is not a dependency of this repo. Use the one CourseWare already has (`courseWare/apps/edge/node_modules/.bin/wrangler`). If an old `CLOUDFLARE_API_TOKEN` is in the shell, prefix the commands with `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID`.

For CourseWare's local development, build with `NEXT_PUBLIC_COURSEWARE_ORIGINS=https://cscourseware.org,http://localhost:5173`, or run `npm run dev` with it set.

## Keeping up with upstream

```bash
git fetch upstream
git merge upstream/main         # conflicts, if any, are in the files listed above
npm test && npm run typecheck && npm run export
```

## Not done yet

- **A true read-only review.** `review` opens an editable throwaway copy: a reviewer can poke at it, but nothing goes back anywhere. Locking editing would need changes deep in the editor.
- Hiding further upstream notices in the embed if they turn out to get in the way (the welcome guide, tablet and pen hints). Simple mode already removes the footer, the "what's new" card and links out.
