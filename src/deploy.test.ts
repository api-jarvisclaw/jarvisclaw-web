import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { DEFAULT_BASE_URL } from './lib/gateway'

/**
 * The deployed headers, pinned.
 *
 * public/_headers is served by Cloudflare Pages and is not exercised by anything else in
 * this repo: a mistake in it cannot fail a build, and the symptom in production is an
 * opaque browser error rather than a stack trace. These tests are the only thing that
 * reads it.
 *
 * The CSP is not decoration here. This page holds an API key in memory and drives a
 * payment gateway, so the damage from injected script is a stolen credential and a
 * drained wallet.
 */

const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')

function directive(name: string): string {
  const csp = headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? ''
  const found = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `) || d === name)
  return found ?? ''
}

describe('deployed CSP', () => {
  it('allows the gateway the app actually calls', () => {
    // The single most breakable line in the file: if connect-src and DEFAULT_BASE_URL
    // ever disagree, every request fails in the browser while every test here still
    // passes. Deriving the expectation from the constant is what couples them.
    expect(directive('connect-src')).toContain(DEFAULT_BASE_URL)
  })

  it('does not allow connections to arbitrary hosts', () => {
    // A wildcard would defeat the purpose: an injected script could then post the user's
    // key and prompts anywhere.
    //
    // Each source is checked on its own rather than by substring. A bare `https:` is the
    // wildcard scheme and must be rejected, while `https://api.jarvisclaw.ai` merely
    // starts with those characters — a naive "does not contain https:" reads the correct
    // policy as the broken one.
    const sources = directive('connect-src').split(/\s+/).slice(1)
    expect(sources.length).toBeGreaterThan(0)
    for (const src of sources) {
      expect(src).not.toBe('*')
      expect(src).not.toBe('https:')
      expect(src).not.toBe('http:')
      expect(src).not.toBe('data:')
      // A host-level wildcard such as https://*.example.com is just as broad in effect.
      expect(src).not.toContain('*')
    }
  })

  it('gives scripts no inline or eval escape', () => {
    // style-src needs 'unsafe-inline' (the composer sets textarea height inline as the
    // user types). Scripts must not inherit that exemption, or stored XSS has somewhere
    // to execute.
    const script = directive('script-src')
    expect(script).not.toContain('unsafe-inline')
    expect(script).not.toContain('unsafe-eval')
    expect(script).toContain("'self'")
  })

  it('refuses to be framed', () => {
    // A console that can be embedded can be clickjacked into approving a charge — the
    // consent dialog is a button, and a button is all that is needed.
    expect(directive('frame-ancestors')).toContain("'none'")
    expect(headers).toMatch(/X-Frame-Options:\s*DENY/)
  })

  it('blocks form submission and plugin content', () => {
    expect(directive('form-action')).toContain("'none'")
    expect(directive('object-src')).toContain("'none'")
  })

  it('serves every font the stylesheet asks for from an origin it permits', () => {
    // The failure this catches is invisible in dev and silent in CI: a stylesheet that
    // @imports Google Fonts builds fine and passes every other test here, then the
    // deployed page drops to a fallback face because font-src is 'self'. Nobody sees it
    // until they look at production, and it reads as a design regression rather than a
    // policy one.
    //
    // Checked in the direction that can actually break: for each remote host the CSS
    // references, the policy must name it. Fonts bundled by the build are 'self' and
    // reference no host at all, so the correct setup asserts trivially.
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    const remoteHosts = [...css.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1])
    const fontPolicy = `${directive('font-src')} ${directive('style-src')} ${directive('default-src')}`
    for (const host of remoteHosts) {
      expect(fontPolicy).toContain(host)
    }
  })
})

describe('deployed caching', () => {
  it('caches hashed assets immutably', () => {
    expect(headers).toContain('/assets/*')
    expect(headers).toMatch(/max-age=31536000, immutable/)
  })

  it('does not pin index.html', () => {
    // index.html names the hashed bundles. Caching it immutably would leave returning
    // visitors on an old build indefinitely, with no way to push a fix.
    const assetRule = headers.slice(headers.indexOf('/assets/*'))
    expect(assetRule).not.toContain('index.html')
  })
})
