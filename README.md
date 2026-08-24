# jarvisclaw-web

A browser agent with its own wallet. 4000+ callable APIs and 80+ models, paid per call
over x402.

The web counterpart to the [`jarvisclaw` CLI](https://www.npmjs.com/package/jarvisclaw):
same gateway, same tools, same spend gates — but a first run that costs a URL instead of
`npx`.

## The point

Open it and ask a question. No account, no API key, no card. The gateway's anonymous free
tier answers, the agent searches the catalogue for you, and anything that costs money asks
first.

```
you: find an API for ethereum gas prices

✓ search_apis  free
  → Gas Oracle (id 4217) $0.011500/call

Gas Oracle gives EIP-1559 estimates in gwei. Want me to call it?
```

## Running it

```bash
bun install
bun run dev      # http://localhost:5173
```

Talks to `https://api.jarvisclaw.ai` directly from the browser — the gateway sends
`access-control-allow-origin: *` and exposes the x402 headers, so there is no proxy and no
server-side secret. Point the sidebar's Base URL at a self-hosted gateway if you have one.

```bash
bun run test        # unit tests
bun run typecheck
bun run build

python probe/live_probe.py    # drives a real browser against the real gateway
```

The live probe is deliberately unstubbed. The unit tests prove the parser and the gates;
only a real run proves the browser can reach the gateway anonymously, that CORS permits
it, and that a free model's streamed tool call survives parsing.

## How it works

```
src/lib/gateway.ts   HTTP + SSE. Auth header rules, stream parsing, error classification.
src/lib/route.ts     Model selection with downgrade.
src/lib/tools.ts     What the agent can do, and what each thing costs.
src/lib/spend.ts     The two spend gates.
src/lib/agent.ts     The loop: message in, tool calls and an answer out.
src/ui/              Console, composer, consent dialog, sidebar.
```

### Three things that are easy to get wrong

**Anonymous means no header, not an empty one.** The free tier recognises a request by the
*absence* of any `Authorization` header. A placeholder — `Bearer anonymous`, `Bearer none`,
even `Bearer ` — is treated as a real credential, fails to resolve, and answers 401. One
function (`authHeaders`) owns that decision.

**A model list is never as true as it looks.** Measured on the live gateway on
2026-08-24: `auto/free` resolved to `zai/glm-4-flash` and the request came back
`Unknown model: zai/glm-4-flash` — while that same model requested *by name* worked fine.
So the free tier's own resolution can hand back a name its chosen channel cannot serve. A
client that trusts one virtual model name has no first run at all when that happens.

`ModelRouter` treats "this model is unservable right now" as an ordinary event: it retires
the model, moves to the next candidate, and says so in the transcript. The candidate list
is read from the gateway each session rather than written in this repo, so a retired or
repriced model stops being offered without a code change. A rate limit does *not* retire a
model — 429 says nothing about the model, and retiring on it would burn the whole list
during one busy minute.

**Two spend gates, and they are different kinds of gate.** Above the per-call limit
($0.05) the user is *asked*. At the session limit ($1.00) the run *stops* — not a prompt.
A session that has spent its budget must not be able to talk its way past it, or a long
run of individually-cheap approved calls adds up to an amount nobody agreed to.

The price shown in the consent dialog is read from the catalogue *before* the call. A
charge the user learns about afterwards is not one they consented to, which is why a failed
price lookup refuses the call rather than proceeding.

### The API key is not persisted

It lives in component state and nowhere else. A key can mint more keys and read the
account, so a key saved by this page would outlive the session on a shared machine.

## Licence

MIT © 2026 JarvisClaw
