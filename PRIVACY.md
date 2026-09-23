# Privacy

Beam collects nothing.

- The extension talks only to a hub on your own machine (`127.0.0.1`). No data
  is sent to the author or to any third party, and there is no analytics or
  telemetry.
- Page content the extension reads (structure, field values, text) is returned
  only to the local `beam` command that asked for it.
- The only thing stored is the hub port, in `chrome.storage`. The hub token
  lives in `~/.beam/token` on your disk.
- `upload` downloads the file at the URL you give it and puts it into a file
  input on the page you are driving; nothing else is fetched.

What you or your agent do with the output of `beam` is up to you.
