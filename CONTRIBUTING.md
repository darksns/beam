# Contributing to Beam

Thanks for looking. Bug reports, site adapters, docs fixes and code are all
welcome.

## Setup

```bash
git clone https://github.com/darksns/beam.git
cd beam
npm install        # jsdom, for the tests
bash install.sh    # links beam into ~/.local/bin
```

Load `extension/` unpacked from `chrome://extensions` (Developer mode on), and
check it with `beam tabs`. After editing anything under `extension/`, run
`beam reloadext` instead of reloading by hand.

## Where things live

| you want to change… | look in |
|---|---|
| a command's flags or output format | `bin/beam` |
| what `snap` / `fields` / `set` see and do in a page | `extension/agent.js` |
| tabs, frames, the socket, injection | `extension/background.js` |
| TinyMCE / jQuery / Select2 handling | `extension/shim.js` |
| the hub (HTTP + WebSocket relay) | `server/server.js` |
| what an agent is told to do | `skills/` |

## Tests

```bash
npm test
```

`test/agent.test.js` runs the agent against a simulated DOM with jsdom;
`test/hub.test.js` starts a real hub and pretends to be the extension. A change
to the agent or the hub should come with a test next to the existing ones. CI
runs both on Node 18, 20 and 22.

## Ground rules

- **No arbitrary code in the page.** The agent exposes a closed set of
  operations; there is no `eval` and there will not be one. New capabilities
  are new operations.
- **The hub stays a relay.** It never executes commands, shells or code, and it
  binds to `127.0.0.1` only. Changes around the token, fetch-metadata checks or
  the WebSocket `Origin` need a test proving the door is still shut.
- **Text first.** Output is read by agents: keep it compact and stable. If you
  change a line format, update `skills/beam/SKILL.md` too.
- **No dependencies at runtime.** The CLI, hub and extension use Node and
  browser built-ins only; `jsdom` is a dev dependency for tests.

## Site adapters

An adapter is a JSON note on how a given backoffice is driven — see
`examples/adapters/wordpress.test.json`. Adapters for other CMSs and admin
panels (PrestaShop, Shopify, Strapi, Drupal…) are a great first contribution:
add one under `examples/adapters/` with a real, working `tasks` entry. Strip
any private URLs, ids or credentials.

## Pull requests

- One change per PR, with a short description of *why*.
- Run `npm test` before opening it.
- Bump versions only in release PRs (`package.json` and
  `extension/manifest.json` move together).

## Security issues

Do not open a public issue for something exploitable — see
[SECURITY.md](SECURITY.md).
