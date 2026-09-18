# Security

Beam drives a Chrome that is already logged into your accounts. That is the
point of it, and it is also the whole risk: anything that can talk to the hub
can act as you. This is how that is kept shut.

## The threat that matters: a web page reaching localhost

A page you visit can send requests to `127.0.0.1`. The browser blocks it from
*reading* the answer, but a plain POST is still delivered — which would be
enough to navigate, click and fill in your own browser. Two locks prevent it:

**A token on `/cmd`.** On first run the hub writes 48 hex characters to
`~/.beam/token` with mode `0600`. Every CLI request carries it in the
`x-beam-token` header, compared in constant time. A web page cannot read that
file.

**Fetch metadata.** Any request that carries an `Origin`, a `Sec-Fetch-Site`
other than `none`, or `Sec-Fetch-Mode: cors` is refused before the token is even
looked at. Browsers attach those headers and cannot forge them; the CLI sends
none of them.

**Origin on the socket.** The WebSocket upgrade is accepted only from an
`Origin` starting with `chrome-extension://`, so a page cannot impersonate the
extension and take over the command stream. Set `BEAM_EXTENSION_ID=<id>` to
accept one specific extension and nothing else.

## What the hub does not do

It never executes a command, a shell or any code. It parses JSON, forwards it to
the extension over the socket and writes the answer back. It binds to
`127.0.0.1` only; there is no path from another machine.

## What the agent can do in a page

A closed set of operations: `snap`, `outline`, `fields`, `text`, `html`,
`click`, `fill`, `set`, `select`, `check`, `press`, `scroll`, `wait`, `upload`,
`do`. There is no `eval`, no injection of arbitrary scripts, no way to ask the
page to run code. `upload` puts bytes the service worker downloaded into an
`input[type=file]`; it cannot read files from your disk.

## Permissions

The extension declares `<all_urls>` because it is meant to work on whatever
admin panel you open. If you only ever drive a few sites, narrow
`host_permissions` in `extension/manifest.json` to those domains and reload the
extension — nothing else changes.

`tabs`, `scripting`, `webNavigation`, `alarms` and `storage` are all used:
respectively to find and bind a tab, to inject the agent, to enumerate frames,
to keep the MV3 service worker alive, and to remember the hub port.

## Things Beam deliberately refuses

- Writing into a bound tab that the person moved elsewhere. It reports the new
  url; `--force` exists but has to be typed on purpose.
- Logging in. Credentials, 2FA and CAPTCHAs are the person's job — the skills
  say so explicitly.
- Saving or publishing on its own. Both skills require an explicit request
  before pressing Publish, Update, Delete or Send.

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something exploitable,
use GitHub's private vulnerability reporting on this repository instead of a
public issue.
