# WordPress

A recipe verified on WordPress 7.1 with the block editor, ACF, WPML and a page
builder that hijacks creation. The parts marked *(verified)* were actually
executed; the rest are usage notes.

## Opening the right editor

`post-new.php` can be hijacked by a builder (for example "New with Aura"). When
that happens there is always an escape hatch on the screen, along the lines of
*"Use the WordPress editor instead"*: take it and save the resulting URL in the
adapter.

```bash
beam open "https://SITE/wp-admin/post-new.php?post_type=post"
beam snap --max 40            # look for the bypass link, if there is one
```

## The body: use the code editor *(verified)*

The visual block editor lives in an iframe and every paragraph is a separate
`contenteditable`: writing block by block is slow and brittle. The code editor
takes the whole block markup at once, in an ordinary `textarea`.

```bash
beam snap --max 250 | grep -i "code editor"    # entry in the "Options" menu
beam click "@N"                                 # switches to code mode
beam fields --sel "#wpbody-content"             # ids of the two textareas
```

The ids are generated (`#inspector-textarea-control-0` for the title,
`#post-content-0` for the body): re-read them every time, do not trust saved
ones.

```bash
beam-mdconv post.md --format gutenberg > body.html
# build payload.json with {"css=#inspector...":"title","css=#post-content-0":"<body>"}
beam set --dry @payload.json
beam set @payload.json
beam click "text=Save draft"
```

Block markup is HTML plus a comment declaring the type and attributes
(`<!-- wp:paragraph -->`). If the comment is missing or malformed the editor
says "This block contains unexpected content": re-read with `beam fields --json`
and fix the markup, do not click "Resolve".

## Media and the featured image *(verified)*

The "classic" uploader is simpler than the block modal:

```bash
beam nav "https://SITE/wp-admin/media-new.php?browser-uploader"
beam upload "css=#async-upload" "https://…/photo.jpg" --name "meaningful-name.jpg"
beam click "css=#html-upload"
```

Then get the file's id and URL from the library in list mode:

```bash
beam nav "https://SITE/wp-admin/upload.php?mode=list"
beam snap --sel "#the-list tr:first-child" --max 12    # the id is in the post=NNN link
beam html --sel "#the-list tr:first-child" --max 4000  # the file's full URL
```

The id is needed in the image block markup (`{"id":NNN}` and
`class="wp-image-NNN"`), otherwise WordPress treats the image as external.

The featured image, from the post being edited:

```bash
beam click "text=Set featured image"
beam snap --sel ".media-modal" --max 30       # the file just uploaded is first
beam click "@N"                               # select it
beam click "css=.media-frame-toolbar button"  # confirm (the button at the bottom)
beam click "text=Save draft"
```

Careful: `.media-toolbar` on its own grabs the filter bar at the top; the
confirm button is in `.media-frame-toolbar`.

## ACF fields *(verified)*

- Fields in inactive tabs **are already in the DOM**: fill them without clicking
  the tab. They show as `(hidden)` in the snap, which is normal.
- Sturdiest target: `name=acf[field_xxx]`, which `beam fields` shows for every
  field. Labels repeat (how many "Title"s are there on a page?), `name`s do not.
- Repeaters: one more row is added by clicking
  `css=[data-name=NAME] a[data-event=add-row]`, and the new row's fields then
  appear with `[row-N]` in the name.
- TinyMCE wysiwyg fields are handled by `beam fill` (plain text → paragraphs).
- ACF image and file fields can **not** be set from JSON: they go through the
  media library.

## ACF link fields: the label is in a hidden input

An ACF `link` field shows only the url and the Edit/Remove buttons on screen:
**the button's label lives in a hidden input** `acf[field_x][title]` (next to
`[url]` and `[target]`). With `beam fields` and no `--hidden` those do not
appear, and you end up delivering a translated page whose buttons are still in
the original language.

```bash
beam fields --sel ".acf-fields" --hidden --json | grep "\[title\]"
```

Rule: on an ACF page, always take stock with `--hidden`.

## Translations (WPML)

**Before writing: detach the duplicate.** If the translation was created as a
copy, WPML keeps it tied to the original and opens a browser `confirm()` on
save — which **blocks the extension** (the command times out and nothing is
saved). The "Language" box has the button that fixes it:

```bash
beam click "css=#icl_translate_independent"
```

Press it once per page, before filling anything. The typical symptom when you
forget: `beam click` on save times out, the page stays on the edit url without
`&classic-editor`, and after a reload the fields are back as they were.

Each language is a separate post with its own id; the field structure is
identical. To find the ids: list the pages with the search, and the little flag
links point at `post.php?lang=xx&post=NNN`.

A scheme that works well: read the source language's fields
(`beam fields --json`), build the source-text → translation mapping, then
generate one payload per language using the same `name=` targets. Untranslatable
fields (percentages, codes, shortcodes, proper nouns) stay as they are: list
them explicitly to the user instead of translating them at random.

## Status and saving

- `#save-post` = "Save draft" in the classic editor; `text=Save draft` in the
  block one.
- The current status reads from `beam snap --sel "#submitdiv"` (classic) or from
  the "Switch to draft" / status button (blocks).
- After saving, **read the page back**: if the server has an application
  firewall, the POST can return 403 while the editor still looks full of data
  that was never saved. Typical symptom: a "403 Forbidden / LiteSpeed" page
  instead of the editor.

## Checking the front end

Checking the fields in the editor is not enough: it only says the data is in the
database. To really verify, open the preview
(`/<lang>/?page_id=<id>&preview=true`) and compare against the client's copy.

**Read the HTML, not the visible text.** Landing pages built out of components
reveal their sections on scroll: `beam text` uses `innerText`, which skips
anything not yet rendered and produces false negatives in bulk. With `beam html`
the markup is already complete, server-side.

```bash
beam nav "https://SITE/en/?page_id=57926&preview=true"
beam html --max 600000 --json    # then strip the tags and compare line by line
```

Compare with whitespace and typographic apostrophes normalized, and plan for a
second pass with no whitespace at all: text split across tags
(`<span>65</span><span>%</span>`) never matches the client's line.

This check is what surfaces the real mistakes: invented labels where the client
already had their own wording, fields the editor showed as fine but the template
does not print, copy that ended up in the wrong language.

## WP-CLI, when it is available

If the user has SSH access, for bulk data entry `wp post meta update` or a
script with `update_field()` run through `wp eval-file` is much faster and does
not go through the application firewall. The browser is the road when SSH is
not there.
