# Chrome Web Store listing

Source for every field of the store listing. The name and the summary come
from `extension/manifest.json` (`name`, `description`); the rest is pasted
into the developer dashboard. Images: `./render.sh` → the PNGs in this folder.

## Store listing tab

**Name** (manifest `name`, ≤75): `Beam — Chrome control for CLI agents`

**Summary** (manifest `description`, ≤132):
`Let your terminal and AI coding agents read and fill web pages as text, in the Chrome session you are already logged into.`

**Category**: Developer Tools · **Language**: English

**Description**:

```
Beam lets a command-line tool on your computer read a web page's structure as text and act on it: fill fields, pick options, click, wait, navigate. It works in the Chrome you already use, in the session you are already logged into.

It is built for coding agents such as Claude Code, and works with any tool that has a shell.

⚠ This extension needs its command-line companion. Install it first:
    npm install -g beam-chrome
or, in Claude Code:
    claude plugin marketplace add darksns/beam
    claude plugin install beam-chrome@beam
Setup and documentation: https://github.com/darksns/beam

HOW IT WORKS
Your agent runs `beam snap` and gets the page back as a short list of text: every field with its label, its value and a ref such as @3. It then writes many fields in one call with `beam set`, and can preview the change first with `--dry`. No screenshots to decode, no debugging port, no second browser profile, no credentials to hand over.

WHAT IT IS FOR
• Data entry in back-offices: WordPress, ACF, WooCommerce and other CMS admin panels
• Filling long forms from a spreadsheet, a JSON file or a brief
• Checking what a page shows after a deploy, as text
• Structured scraping of pages you are logged into
• Several agents at once: each session gets its own window and tab

PRIVACY AND SECURITY
• Local only: the extension talks to a small hub on 127.0.0.1 on your own machine and nothing else. No analytics, no telemetry, no account.
• A web page cannot drive it: the hub needs a token stored on your disk and refuses requests coming from a browser page.
• No code injected on demand: only the scripts inside the package run, with a fixed set of operations. There is no way to run arbitrary JavaScript in a page.
• Password fields are write-only: Beam can fill them, but only ever reports that they are set.
• Beam works in a window of its own and refuses to write into a tab you moved elsewhere.
• The network log (`beam network`) is off by default. Turn it on from the Beam panel if you need it: Chrome asks once, and the same button turns it off. It records method, URL, status, timing and content-type for the tab Beam drives only, in memory, with no bodies.

Open source, MIT licensed: https://github.com/darksns/beam
Privacy policy: https://github.com/darksns/beam/blob/main/PRIVACY.md
```

**Screenshots** (1280×800, in this order): `1-read.png`, `2-fill.png`,
`3-session.png`, `4-parallel.png`, `5-agents.png`

**Small promo tile** (440×280): `promo-tile-440x280.png`
**Marquee** (1400×560, optional): `marquee-1400x560.png`

**Official URL**: none (it needs a verified domain in Search Console)
**Homepage URL**: `https://github.com/darksns/beam`
**Support URL**: `https://github.com/darksns/beam/issues`

## Privacy practices tab

**Single purpose**:

```
Beam lets a command-line tool running on the user's own computer read the structure of a web page and fill in or click its controls, so that the user, or a coding agent they run, can automate form entry and data entry in their own browser session.
```

**Permission justifications**:

| permission | justification |
|---|---|
| `tabs` | `Beam opens, lists and reuses the tab it drives, and reads that tab's URL and title so the command-line tool knows where it is and can refuse to write into a tab the user navigated elsewhere.` |
| `scripting` | `Beam injects the content script bundled in the package into the tab it drives, to read the page's form fields and fill or click them when the local command-line tool asks. No remote code is injected.` |
| `webNavigation` | `Beam lists the frames of the page it drives, because many admin panels (for example the WordPress editor) put their forms inside iframes.` |
| `alarms` | `A periodic alarm keeps the Manifest V3 service worker able to reconnect to the local hub on 127.0.0.1, so commands do not fail after the worker goes idle.` |
| `storage` | `Beam stores the local hub port the user set in the panel; in session memory, the tab each named session drives, a short connection log shown in the panel, and, only when the user turns it on, the network log of that tab.` |
| `webRequest` (optional) | `Optional, off by default. When the user turns on the network log in the Beam panel, Beam records method, URL, status and timing of the requests made by the tab it drives, so the user can see what an action called. Bodies are never read and the only header read is the response content-type; nothing is blocked or modified, and the log stays in session memory.` |
| host `<all_urls>` | `Beam is used on whatever site the user chooses to automate (their own admin panels, on any domain), so the set of hosts cannot be fixed in advance. It only acts on the tab the user binds to a session, and only when the local command-line tool asks.` |

**Remote code**: `No, I am not using remote code.` Everything that runs is in
the package (`agent.js`, `shim.js`); the commands from the local hub are data,
passed as the argument of a fixed function.

**Data usage**: the store counts data handled only on the device too. What the
extension reads (page structure, field values, the URL and title of the tab it
drives, the optional request log) goes only to the command-line tool on the same
machine, through 127.0.0.1; nothing is sent to the developer or to third parties.
Tick **Web history**, **User activity** (the optional network log) and
**Website content**. Leave **Authentication information** unticked: password
fields are write-only since 1.7.1. Then certify the three statements: not sold
to third parties, not used or transferred for purposes unrelated to the single
purpose, not used to determine creditworthiness.

**Privacy policy URL**: `https://github.com/darksns/beam/blob/main/PRIVACY.md`

## Distribution tab

Visibility: Public · Regions: all · Pricing: free
