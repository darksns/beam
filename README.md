# Beam

Chrome control for CLI agents, **as text**. Beam reads a page's structure and
acts on the DOM — no screenshots to decode, no debugging protocol, no separate
profile. It works in your own Chrome, in the session you are already logged
into.

<p align="center">
  <img src="docs/hero.gif" width="920" alt="An agent issues beam snap and beam set against a bound Chrome tab. The page comes back as text — no screenshot, one round trip, the session you are already in.">
</p>

```
agent / you ──► beam (CLI) ──► local hub :8777 ──► extension ──► page
        compact text ◄──────────────────────────────────────── DOM
```

A WordPress admin screen comes back as ~40 lines of text instead of a
screenshot:

```
$ beam snap
Edit page · WP
https://example.com/wp-admin/post.php?post=1420&action=edit
9 elements

h1 Edit page
@0 input:text "Title" = "Woven roots" #title
@1 input:text "Kicker" = "New collection 2026"
@2 textarea "Description" = "There is a moment…" *
@3 select "Status" = "Published" {Draft|Published}
@4 input:checkbox "Active" = "off"
@6 editable "Notes" = "rich text" #rich
@7 link "All pages" -> /wp-admin/edit.php
@8 button "Update" #publish
```

Then you write to it in one round trip:

```bash
beam set '{"label=Kicker":"New collection 2026","name=acf[field_bb]":"Woven roots"}'
```

It was built to be driven by [Claude Code](https://claude.com/claude-code) — the
repo ships two skills — but the CLI is plain Node and works on its own.

## Install

Two parts: the CLI (with the two skills), and the Chrome extension.

### As a Claude Code plugin

```bash
claude plugin marketplace add darksns/beam
claude plugin install beam-chrome@beam
```

or, inside a session: `/plugin install beam-chrome --marketplace darksns/beam`.

The plugin puts `beam` and `beam-mdconv` on the PATH of Claude's shell and
loads the skills as `beam-chrome:beam` and `beam-chrome:web-publish`. It works
in Claude Code only: it needs a local shell, Node 18+ and Chrome, which
claude.ai and the mobile apps do not have. Updates: `claude plugin update beam-chrome@beam`.

Then the extension (below). In the plugin's shell, `beam extension` copies it
to `~/.beam/extension`: load that folder.

### From npm, or from a clone

```bash
npm install -g beam-chrome
bash "$(npm root -g)/beam-chrome/install.sh"
```

or

```bash
git clone https://github.com/darksns/beam.git
cd beam
bash install.sh
```

The installer prints the path of the `extension/` folder to load.

Use **one** of the two ways: with both, the two skills show up twice.

### The extension

Once, in Chrome:

1. open `chrome://extensions`
2. turn on **Developer mode**
3. **Load unpacked** → the `extension/` folder (or `~/.beam/extension`, after
   `beam extension`)

Check it: `beam tabs`.

An update moves the plugin to a new folder, and Chrome drops an unpacked
extension whose folder has gone: that is why `beam extension` copies it to a
place that stays put. After an update, `beam extension && beam reloadext`. If
the CLI says the running hub is an older version, `beam server --stop`: the next
command starts the new one.

Load **one** copy of the extension only. If two are loaded (a leftover folder
and this repo), the last one to connect takes the hub; the leftover panel says
**Another copy is connected** and stops retrying, instead of the two copies
stealing the socket from each other.

The installer links `beam` and `beam-mdconv` into `~/.local/bin`, creates
`~/.beam/` (hub token and site adapters) and, if Claude Code is installed, links
the two skills into `~/.claude/skills/`. The hub starts by itself on every
command. The toolbar icon opens a panel with the connection state, an editable
hub port, the version, the **network log** switch, the sessions, a debug dump,
and two buttons: **Reconnect** and **Release tab**. A red `!` on the icon means the connection dropped, or that
another copy took the hub.

Requires Node 18+ and Chrome (or any Chromium with MV3 extensions).

## Use

```bash
beam open https://example.com/wp-admin/post.php?post=1420&action=edit
beam snap
beam fields --json
beam set --dry @payload.json     # preview the diff
beam set @payload.json
```

`open` works in a separate Chrome window that stays unfocused, and reuses one
tab. `beam focus` brings that window forward. Two agents in parallel export
different `BEAM_SESSION` names (or pass `--session`); each name gets its own
window and tab, and will not take a tab another session owns. With no name,
everyone shares the session `default`.

Read: `snap` · `outline` · `fields` · `text` · `html` · `info` · `ping` · `tabs` · `frames` · `sessions` · `network`
Act: `open` · `focus` · `nav` · `reload` · `back` · `forward` · `close` · `use` · `click` · `hover` · `fill` · `select` · `check` · `press` · `upload` ·
`set` · `do` · `wait` · `scroll` · `shot`

Targets are `@12` (a ref from the last snap), `@3:12` (ref 12 inside frame 3),
`css=.klass`, `text=Update`, `label=Title`, `name=post_title`, `title=Heading Settings`.

The WordPress editor lives in a frame. `beam frames` lists them, `beam snap --frame all` reads every one, and `--frame <id>` writes into one.

Markdown for a CMS field goes through the converter: `beam-mdconv post.md --format gutenberg|html|text [--json]`.

`beam help` has the full list; `skills/beam/SKILL.md` is the reference an agent
reads, and `skills/web-publish/` covers content work inside a CMS.

## How it is built

| piece | file | job |
|---|---|---|
| CLI | `bin/beam` | builds the command, sends it over HTTP, formats the answer |
| converter | `bin/beam-mdconv` | Markdown → Gutenberg blocks / HTML / text |
| hub | `server/server.js` | HTTP for the CLI, WebSocket for Chrome. 127.0.0.1 only, executes nothing |
| service worker | `extension/background.js` | holds the socket, manages tabs, injects the agent |
| agent | `extension/agent.js` | lives in the isolated world: reads the structure, acts on the DOM |
| page shim | `extension/shim.js` | MAIN world: TinyMCE / jQuery / Select2, reached from the agent via the DOM |
| panel | `extension/popup.html` · `popup.js` | connection state and quick commands |

The agent exposes a **closed** set of operations (snap, outline, fields, text,
html, click, hover, fill, set, select, check, press, scroll, wait, upload, do). There is
no path to running arbitrary code in the page.

**Adapters** in `~/.beam/adapters/<host>.json` are notes on how a given
backoffice is driven; the `web-publish` skill uses them so the same panel is
never explored twice. `examples/adapters/` has a commented one.

## Why it is fast

- One `snap` of an admin screen is ~40 lines of text instead of an image.
- `set` and `do` perform dozens of operations in a single round trip.
- `@n` refs avoid repeating long selectors.

## What it runs and touches

- **Processes**: the `beam` CLI (Node) and the hub (`server/server.js`), which
  the CLI starts detached on the first command and leaves running. `beam server
  --stop` stops it.
- **Network**: the hub listens on `127.0.0.1:8777` (`BEAM_PORT` changes it) and
  talks only to the CLI and the extension. The one outbound fetch is `upload`,
  which downloads the URL you give it to put the file into a page. No telemetry.
- **Files**: `~/.beam/token` (the hub token, 0600), `~/.beam/adapters/` (site
  notes the `web-publish` skill writes), `~/.beam/extension/` (after `beam
  extension`), screenshots from `shot` (the system temp folder, or `--out`)
  and the `@payload.json` files you pass in.
  `install.sh` also links into `~/.local/bin` and `~/.claude/skills/`.
- **Browser**: the extension acts only in the tab bound to a session, and only
  with the closed set of operations listed above.
- **Where your data goes**: what Beam reads from a page comes back only to the
  local CLI. What it types into a page goes to that page's own site when the
  form is saved or submitted: the sites you point it at, in your session. The
  skills ask before saving, publishing or submitting anything.

## Security

Beam drives a browser that is logged into your accounts, so the doors are shut
by default — see [SECURITY.md](SECURITY.md) for the details and
[PRIVACY.md](PRIVACY.md) for what stays on the machine.

- The hub binds to `127.0.0.1`, executes nothing, and relays messages only.
- `/cmd` requires the token in `~/.beam/token` (0600, generated on first run)
  and refuses any request carrying browser fetch metadata: **a web page cannot
  drive your browser through this port.**
- The WebSocket only accepts an `Origin` of `chrome-extension://…`; set
  `BEAM_EXTENSION_ID` to pin one specific extension. A second copy with a
  different id takes over and the leftover is told to stop retrying.
- The hub pings the extension every 15s and drops a socket that stops
  answering, so a dead service worker fails the next command immediately
  instead of making it wait out its timeout.
- Beam refuses to write if the bound tab was moved elsewhere by the person: it
  reports first, `--force` second.
- The extension asks for `<all_urls>`, like any automation extension. To narrow
  it, list only the domains you need in `host_permissions`.
- `webRequest`, which `beam network` needs, is optional: it is off until you
  press **Enable network log** in the panel, and the same button takes it back.
- Saving, publishing and submitting forms stay actions an agent asks about
  first: that rule is written into both skills.
- Password fields are write-only: `snap`, `fields`, `html` and `set --dry`
  report `<hidden, N chars>` instead of the value, so a password never reaches
  the agent's context.

## Test

```bash
npm install     # jsdom, for the agent tests
npm test
```

`test/agent.test.js` runs the agent against a simulated ACF DOM:
snap, fields, fill by label/name/ref, select, check, contenteditable, bulk and
`--dry` set, input/change events, frame-prefixed refs, the style fallback when a
tab has no layout, outline, `do` sequences, `wait`, escaped `cssPath`, TinyMCE
and jQuery through the page shim, hover on a Beaver-style wrench, and `title=`
on a control that is still hidden.
`test/hub.test.js` starts a real hub, pretends to be the extension, and checks
the handshake, WebSocket framing up to 200 KB payloads, that an unauthorized
or page-originated request is refused, that a leftover copy is told it was
replaced, and that a silent socket is dropped instead of timing out.

## Contributing

Issues, site adapters and pull requests are welcome — start from
[CONTRIBUTING.md](CONTRIBUTING.md). Questions and ideas go in
[Discussions](https://github.com/darksns/beam/discussions).

## License

MIT — see [LICENSE](LICENSE).
