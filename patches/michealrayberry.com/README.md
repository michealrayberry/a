# Web Controls for michealrayberry.com

`0001-web-controls-nextdns.patch` adds NextDNS Web Controls to
[ap-michealrayberry/michealrayberry.com](https://github.com/ap-michealrayberry/michealrayberry.com)
in that repository's own structure and style (Hono routes, `events` audit log,
`site_state`, the console and portal UIs, cron jobs, workerd tests).

It replaces the standalone Worker in `cloudflare/web-controls/` for production
use: the live site is already one Worker with Access and D1, so Web Controls
belongs inside it rather than beside it.

Apply (from a clean checkout of `main`):

```sh
git checkout -b web-controls-nextdns
git am path/to/0001-web-controls-nextdns.patch
npm ci && npm test        # 263 passed, 1 skipped
git push -u origin web-controls-nextdns   # open a PR; CI runs the tests
```

Verified: applies cleanly to `main` at 3ce20ed; `tsc` clean; full suite passes.
Read the README section "Web Controls (NextDNS)" it adds before deploying.
