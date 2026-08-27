# Deploying ducat.jarvisclaw.ai

This is a **standalone static site**. It shares nothing with the gateway but the public
HTTP API: no shared build, no shared deploy, no shared process. The gateway can be
redeployed, rolled back, or taken down for maintenance without touching this, and vice
versa.

## How it is actually served

**A Worker with a static-assets binding, not a Pages project.** `wrangler.jsonc` in this
repo is the source of truth.

This section used to describe a Pages setup that was never built, and the gap was
expensive: two PRs merged to `main` while the live site kept serving a bundle someone had
uploaded by hand, because there was no git integration for a merge to trigger. If you are
looking for the Pages project, there isn't one —

```
$ wrangler pages project list
jarvisclaw-docs   docs.jarvisclaw.ai   git=Yes     # the docs site IS on Pages
                                                  # (no row for this site)
```

To deploy:

```
bun install && bun run build      # tsc --noEmit runs first, so a type error fails here
wrangler deploy                    # uploads dist/ and points ducat.jarvisclaw.ai at it
```

`wrangler deploy` needs `wrangler login` once per machine. There is no CI deploy on
purpose: nothing in `.github/workflows/` holds a Cloudflare credential, and a deploy that
publishes a page holding an API key is worth doing deliberately.

The config declares `ducat.jarvisclaw.ai` as a `custom_domain` route. That matters —
omitting it would let a later deploy quietly fall back to a `*.workers.dev` URL.

### DNS

Nothing to add by hand. Attaching the custom domain to the Worker is what routes the
hostname; there is no CNAME record for `ducat` on the zone, and none is needed.

### The hostname changed, and one thing must change with it

The site was served from `chat.jarvisclaw.ai`. That name is **detached**, deliberately:
every `chat.jarvisclaw.ai` URL is now dead and nothing in this repo rescues one. (I argued
for keeping it attached with a 301, since this is the page a user returns to while a paid
video renders; that was declined because the name had not been handed out widely.)

#### One loose end: `chat` answers 522, it does not stop resolving

Removing the pattern from `routes` detaches the Worker but **leaves the DNS record**, so
Cloudflare still proxies the hostname with nothing behind it. Measured after the move:

```
chat.jarvisclaw.ai   -> 522, server: cloudflare     (proxying to nothing)
ducat.jarvisclaw.ai  -> 200                          (the new site)
```

A 522 reads as "the site is broken" rather than "the site moved", which is the worse of the
two failures — and it cannot be cleaned up from here: the OAuth token `wrangler login`
issues carries `zone (read)`, not DNS write. **Delete the `chat` record in the Cloudflare
dashboard** (DNS → Records) so the name returns NXDOMAIN instead. Until that is done, anyone
holding an old link sees a Cloudflare error page.

**The gateway's `CORS_ALLOWED_ORIGINS` must name the new origin, and it must be changed
FIRST.** This is not a nicety — it is the whole difference between a working site and one
where sign-in and wallet payments fail with a 403 the browser reports without detail, and
which leaves nothing in the gateway's own logs. Anonymous and free-model traffic keeps
working throughout, so the site looks fine until someone tries to spend money.

```bash
# APPEND. Replacing the line drops the origins already there.
ssh -F ~/.ssh/prod_config prod "sudo bash -c '
cd /root/jarvisclaw
cp .env .env.bak.ducat.\$(date +%Y%m%d%H%M%S)
grep -q \"ducat.jarvisclaw.ai\" .env || sed -i \"s|^CORS_ALLOWED_ORIGINS=.*|&,https://ducat.jarvisclaw.ai|\" .env
grep -o \"CORS_ALLOWED_ORIGINS=.*\" .env'"
# then re-run deploy.sh — env is read only at container start
```

Verify before deploying the frontend (see `.claude/uat_deploy_sop.md` §2.10 for the full
three-part check, including that an unknown origin still gets a 403):

```bash
curl -si -X OPTIONS https://api.jarvisclaw.ai/v1/chat/completions \
  -H 'Origin: https://ducat.jarvisclaw.ai' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-payment' \
  | grep -i 'access-control-allow-'
```

`src/lib/host.test.ts` pins the hostname against `wrangler.jsonc`, so the constant and the
route cannot drift apart silently — but no test can check the gateway's env var from here.

### One expected console error

Cloudflare injects its analytics beacon (`static.cloudflareinsights.com/beacon.min.js`)
into the response, and our `script-src 'self'` refuses it. That refusal is the policy
working as intended, not a defect — but it means "no console errors" is the wrong check
for this site. Count errors that are not the beacon; `probe/live_probe.py` and the check
in this repo's history both do that.

## What the edge serves

`public/_headers` ships to `dist/` and Cloudflare applies it. The CSP is the part that
matters, and it is deliberately narrow: this page holds an API key in memory and drives a
payment gateway, so the damage from injected script is a stolen credential and a drained
wallet, not a defaced page.

- `connect-src` names the gateway explicitly — an injected script cannot post the user's
  key or prompts to another host.
- `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`, so stored XSS has
  nowhere to execute. `style-src` does allow inline, because the composer sets the
  textarea's height as the user types.
- `frame-ancestors 'none'` — a console that can be embedded can be clickjacked into
  approving a charge, and the consent dialog is just a button.
- `/assets/*` is immutable (hashed filenames). `index.html` deliberately is **not**, or a
  returning visitor would never see a new build.

`src/deploy.test.ts` pins all of that, and derives the expected `connect-src` host from
`DEFAULT_BASE_URL` so the two cannot drift apart silently.

## Verifying before you deploy

```bash
bun run build
python probe/serve_dist.py            # serves dist/ WITH the real _headers, port 4173
python probe/live_probe.py http://localhost:4173
```

The second step is the one that matters. Cloudflare applies `_headers` at the edge and
nothing local does, so a CSP that blocks the app's own gateway calls builds clean, passes
every unit test, and fails only in production — as an opaque browser error with no stack
trace. `serve_dist.py` reads `_headers` and sends them, so the browser enforces the
deployed policy against the deployed bundle.

Last run of that pair: anonymous chat answered, the concrete model was named, and a free
tool call ran and was labelled free — under the real CSP, against the real gateway.

## Why this is not part of the main site

Asked for explicitly, and it is the right split anyway:

- **Blast radius.** The gateway process already carries relay, billing, settlement, the
  admin dashboard, SEO pages, MCP, A2A and the discovery documents. A chat console is the
  one surface that will change most often for cosmetic reasons, and it has no business
  being a reason to restart the thing that moves USDC.
- **Failure isolation.** A static site on Pages stays up while the gateway is down, which
  is when a user most wants to read an error message rather than see a dead host.
- **No build coupling.** The gateway embeds its frontend with `go:embed`
  (`pattern web/default/dist`), so a frontend in that tree means Go builds depend on a
  bun build. This one does not touch that.
- **Deploy cadence.** Pushing a copy change here should not require a gateway image
  build, a registry push, and a container restart.

The only contract between them is the public HTTP API, and the gateway already sends
`access-control-allow-origin: *` with the x402 headers exposed — so no proxy, and no
server-side secret to protect.
