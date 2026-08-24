# Deploying chat.jarvisclaw.ai

This is a **standalone static site**. It shares nothing with the gateway but the public
HTTP API: no shared build, no shared deploy, no shared process. The gateway can be
redeployed, rolled back, or taken down for maintenance without touching this, and vice
versa.

## Cloudflare Pages setup

Same shape as `docs.jarvisclaw.ai`.

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. Pick `api-jarvisclaw/jarvisclaw-web`
3. Build settings:
   - **Framework preset:** None
   - **Build command:** `npm install && npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `/`
4. Custom domain: `chat.jarvisclaw.ai`

`npm run build` runs `tsc --noEmit` first, so a type error fails the deploy rather than
shipping a broken bundle.

### DNS

Cloudflare adds the CNAME itself when you attach the custom domain. If adding it by hand:

```
chat.jarvisclaw.ai  CNAME  <project>.pages.dev   (proxied)
```

`chat` and `app` were both unused before this; nothing else answers on either.

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
