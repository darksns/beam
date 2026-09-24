---
name: beam
description: Drive Chrome as text through the `beam` CLI — read a page's structure, fill forms, click, navigate. Use it for data entry in admin panels (WordPress/ACF), filling forms, checking pages, structured scraping, UI QA. No screenshots: all text, one round trip per operation.
---

# Beam

CLI: `beam` (installed in `~/.local/bin`). It talks to a local hub on
127.0.0.1:8777 that relays commands to the user's Chrome extension — so it works
**inside the session they are already logged into**, with no credentials and no
separate profile.

The hub starts by itself on the first command. If the extension does not answer,
the error is `extension not connected`: ask the user to open the Beam panel from
the Chrome toolbar icon (it shows `!` when disconnected) and press
**Reconnect**. `beam ping` returns the id, the version and the panel url.

## How to work

Do not use `beam shot`. Screenshots are for when the user wants a visual check
or a widget is undecipherable from the DOM. The normal flow is:

1. `beam open <url>` once. It uses a Chrome window of its own that stays
   unfocused, and every later `open` reuses that same tab. Do not pass `--new`.
   Do not pass `--focus` unless the person asked to look at it. Do not
   `beam close` when the task is done: the window is meant to stay.
2. `beam snap` (or `beam fields`) to read the page **once**
3. act with `set` / `do`, which do everything in a single round trip
4. re-read only what matters (`beam snap --sel ...`) to verify

`beam use <id>` is only for a tab the person already has open, and it does not
bring that tab forward. `beam focus` does, and only when they ask. A command
with nothing bound fails instead of attaching to whatever they are looking at.

## Reading

```
beam snap    [--sel CSS] [--max N] [--hidden]   # interactive elements, with @n refs
beam outline [--sel CSS] [--depth N]            # the HTML structure tree
beam fields  [--sel CSS] [--hidden] [--vlen N]  # every form field, as JSON
beam text    [--sel CSS] [--max N] [--from N]   # readable text
beam html    [--sel CSS] [--max N]              # raw HTML (use it last)
beam info | tabs | frames
beam network [filter] [--type xhr,doc,js,css,img] [--method M] [--failed] [--last N] [--clear]
```

`snap` returns lines like:

```
h2 Hero
@4 input:text "Kicker" = "New collection 2026"
@5 input:text "Title" = "Woven roots" *
@6 textarea "Description" = "There is a moment…"
@7 select "Status" = "Draft" {Draft|Published}
@8 button "Update" #publish
```

`*` = required, `(hidden)` = present but not visible (fill it anyway: handy for
closed ACF tabs), `{…}` = a select's options.

`@n` refs last until the next `snap` or a page change; after navigating, snap
again. For stable references use `name=` or `css=`.

`beam fields` returns **whole** values; on screen they are cut at 200 characters
with the real length shown, and `--json` gives them in full. Never conclude a
field is empty or short from a shortened output.

### Iframes

`beam frames` lists the injectable frames, including the ones that do not show
up in the navigation history (such as the WordPress editor canvas).

```
beam snap --frame all      # reads every frame, refs become @<frame>:<n>
beam click @583:12         # the frame comes from the ref, no extra flag
beam set --frame 583 @payload.json
```

`--frame all` is for reading only: to act, name one frame. Frame ids change when
the application recreates them — re-read them, do not reuse them.

### Network

`beam network` lists the requests made by the bound tab (and Beam's own tab)
since it was bound: status, method, type, time, url. Bodies and headers are not
captured. `--type xhr` keeps fetch/XHR calls only, `--failed` keeps errors and
status >= 400, `--clear` empties the log after printing it. To see what one
action calls: `beam network --clear`, act, then `beam network --type xhr`.
Recording starts when a tab is bound: the very first `open` of a new Beam
window misses its initial load, so `beam reload` if that matters.

## Acting

```
beam open <url> [--new] [--focus]   its own window, unfocused; reuses that tab
beam focus                          bring the Beam window forward
beam nav <url> | reload | back | forward | close | use <tab> [--focus]
beam click <target>
beam hover <target>
beam fill <target> <value>
beam select <target> <value>         # by value or by visible label
beam check <target> [on|off]
beam press <Key>
beam wait [--sel CSS] [--text T] [--timeout ms]
beam scroll [--sel CSS] [--by N]
beam upload <target> <url>           # downloads a file into an input[type=file]
beam shot [--out file.jpg]           # screenshot to a file, only when truly needed
beam reloadext                       # reload the extension after editing it
```

**Targets**: `@12` · `css=.my-class` · `text=Update` · `label=Kicker` ·
`name=acf[field_abc]` · `title=Heading Settings`. A bare string is tried as CSS,
then as text, then as a label.

## Batch — the fast path

Filling many fields in one round trip:

```bash
beam set '{"label=Kicker":"New collection 2026","name=acf[field_bb]":"Woven roots"}'
beam set @hero-copy.json        # the same object, from a file
beam set --dry @hero-copy.json  # preview: shows the diff, writes nothing
```

Always go through `--dry` before a bulk write.

Mixed sequences (tab clicks, waits, fills):

```bash
beam do '[
  {"op":"click","target":"text=Identity"},
  {"op":"wait","sel":".acf-field[data-name=identity_title]"},
  {"op":"fill","target":"label=Title","value":"Made by nature."},
  {"op":"snap","sel":".acf-fields"}
]'
```

A failing step stops the sequence and reports the steps already done; put
`"optional": true` on steps that may be missing.

## WordPress / ACF

- Fields in inactive ACF tabs are already in the DOM: fill them without clicking the tab.
- The sturdiest identifier is `name=acf[field_xxx]`, which `beam fields` shows for every field.
- TinyMCE wysiwyg fields are handled (plain text → `<p>` paragraphs).
- Repeater rows are added with a click: `{"op":"click","target":"css=[data-name=stops] a[data-event=add-row]"}`.
- Images and files can **not** be set from here: they go through the media library.
- Do not click "Update"/"Publish" on your own initiative: ask first — saving is visible to the outside world.

### Beaver Builder / VamTam

The wrench is not in the page until the pointer is over the module. Beaver
Builder builds the overlay on `mousemove` (it checks `clientX`/`clientY`), and
the control is a `<span title="Heading Settings">`, not a button — `snap` never
lists it. The layout usually lives in the builder iframe.

```bash
beam frames
beam hover --frame ID "css=.fl-module"          # first module; narrow the selector to pick one
# @ID:n span "Heading Settings" .fl-block-settings
beam click --frame ID "title=Heading Settings"  # or click the @ID:n from hover
beam snap                                       # the settings form opens in the parent frame
```

`hover` also forces `:hover` styles (a synthetic event does not). One hover
replaces the previous one. The Beam window's tab is already the active tab of
that window, so it has layout without being focused. `beam focus` only if the
person wants to watch. If hover says there is no layout, the bound tab is one
of theirs and it is not the tab on screen: do not switch to it.

In one round trip, inside the iframe:

```bash
beam do --frame ID '[
  {"op":"hover","target":"css=.fl-node-abc.fl-module"},
  {"op":"click","target":"title=Heading Settings"}
]'
```

## The tab guard

Beam stays bound to the tab named by `use`/`open`/`nav`. `open` keeps that tab
in Beam's own unfocused window and reuses it. If the person moves that tab
elsewhere, every **write** command is refused and the new url is reported:
re-bind with `beam use <id>` after looking at `beam tabs`. `--force` exists but
is only for after you have checked where you are writing. Do not close the
Beam tab at the end of a task.

## Limits

- Does not work on `chrome://` pages, the Web Store, or built-in PDFs.
- No drag & drop, and no virtualized lists (React recycling nodes).
- `hover` sends pointer events; it does not drag.
- A tab that is not the selected tab of its window has no layout. Beam's own
  window keeps its tab selected, so hover works there without focusing the
  window. `beam focus` is how a person asks to see it.
- If a click causes a full navigation, wait with `beam wait` and snap again: the
  previous refs are gone.
