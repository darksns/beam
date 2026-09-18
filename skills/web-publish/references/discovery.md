# Working out an unknown backoffice

A procedure for a CMS or business panel you have never seen. The goal is not to
understand the whole thing: it is to find the few pieces the task needs, try
them on a test item, and write them down in an adapter.

## 1. Work out where you are

```bash
beam info
beam snap --max 60
```

Look for the engine's fingerprints: `/wp-admin/` (WordPress), `/admin/` with
`Shopify`, `/ghost/` (Ghost), `/administrator/` (Joomla), `/user/` + `node/add`
(Drupal), `/admin` with `Sylius`/`Symfony`, custom panels with no signature at
all. If it is not recognizable it does not matter: the procedure is the same.

The declared generator helps too:

```bash
beam html --max 3000 | grep -i "generator\|powered"
```

## 2. Find the creation screen

Usually a "New / Add / Create" button. Follow it and **note the final URL**,
query string included: that is the first line of the adapter.

If a builder or a wizard gets in the way, look for the escape hatch to the
standard editor (in WordPress it was *"Use the WordPress editor instead"*):
almost all of them have one.

## 3. Find the iframes

```bash
beam frames
```

If more than one frame shows up, the editor is almost certainly inside it. From
then on every command on that area needs `--frame <id>`, and refs appear as
`@<frame>:<n>`. Frame ids change when the application recreates them: re-read
them rather than reusing them.

## 4. Map the fields

```bash
beam fields                    # label, name, id, selector, value
beam fields --frame <id>       # inside the editor
```

Pick targets in this order of sturdiness:

1. `name=` — the field's `name` attribute, stable and often meaningful
2. `css=#id` — if the id is not randomly generated (watch out for `#\:r1\:`,
   `#base-ui-…`: those change on every render)
3. `label=` — convenient, but ambiguous when a label repeats
4. `@n` — only within the same sequence; it dies at the first reload

## 5. Look for the "code" editor

This is the single biggest time saver. Almost every CMS offers an
HTML/Markdown/source view of the content: an ordinary `textarea` you can pour
the whole body into at once, instead of simulating typing inside a rich editor.

Typical names to look for in the snap: `Code editor`, `HTML`, `Source`,
`Markdown`, `Text` (as opposed to `Visual`).

If it really does not exist, the body goes into the `contenteditable` with
`beam fill`, but expect to lose formatting: in that case paste ready-made HTML
and check what survives.

## 6. Media uploads

Look for an `input[type=file]` with `beam fields --hidden` (it is often hidden
behind a fake button). If the panel has a "classic" upload page, use it: it is
simpler than the drag & drop modal.

```bash
beam fields --hidden | grep -i "input:file"
beam upload "css=#the-right-one" "https://…/photo.jpg" --name "name.jpg"
```

Drag & drop is not supported. If dragging is the only way, find another one: a
dedicated upload page, a "from URL" field, or the CMS API.

## 7. Saving as a draft

Find the button that saves **without publishing**, and how the resulting status
reads. If only "Save" and "Publish" exist, check where the content ends up
before using it on anything real.

## 8. Dry run

Before touching real content, do the whole path on a fake item ("beam test,
delete me"), check that it saves and that the status is what you expect, then
delete it. Only then write the adapter.

## 9. Write the adapter

`~/.beam/adapters/<host>.json`, holding: the starting URL, any bypasses, the
field selectors, the media procedure, the save button, the verification URL and
— the most valuable part — the **traps** you hit.

```json
{
  "host": "example.com",
  "cms": "…",
  "note": "what cost me time",
  "tasks": {
    "<task-name>": {
      "url": "…",
      "prepare": ["preliminary steps"],
      "fields": { "title": "name=…", "body": "css=…" },
      "media": { "url": "…", "input": "css=…", "submit": "css=…" },
      "save_draft": "text=…",
      "verify": "…"
    }
  }
}
```

## When to stop

If after two or three attempts the panel will not cooperate — controls that do
not respond, saves that do not stick, anti-bot protections — stop and explain
what you tried. Often the right road is a different one: the CMS REST API, a CSV
import, CLI access on the server. Do not keep clicking into the void.
