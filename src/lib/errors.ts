import type { Locale } from './i18n'
import { translate } from './strings'

/**
 * Translates an error message at the point it is DISPLAYED, not where it is thrown.
 *
 * ## Why not translate at the throw site
 *
 * These messages come from `lib/wallet.ts`, `lib/modality.ts`, `lib/account.ts` and
 * `lib/blobstore.ts` — plain modules with no React, so no hook can reach them. Threading a `t` down
 * through every signature would put the locale into the payment path, where the argument list is
 * already long and where a wrong parameter order is a wrong charge.
 *
 * There is exactly one place an error reaches the screen (Transcript's `kind: 'error'` branch), so
 * one call there covers all of them.
 *
 * ## Interpolated messages
 *
 * Four are template literals: an amount, a chain id, a status code, a model name. A static
 * catalogue cannot hold `Refusing to sign $12.30 — above your $5.00 per-signature cap`, so those
 * are matched by PATTERN and the captured values are put back into the translation. The pattern list
 * is asserted against the source in errors.test.ts — a reworded throw site would otherwise fall
 * through to English silently, and these are the messages that explain why money did not move.
 *
 * ## English is the fallback, and that is fine
 *
 * An untranslated error is readable. A crashed error renderer is a blank turn where an explanation
 * should be, so nothing here throws: unmatched input is returned unchanged.
 */

/**
 * Messages that carry a value, as a pattern with named groups.
 *
 * The key holds `{…}` placeholders that translate() fills. Order matters only in that the first
 * match wins, so no pattern here may be a prefix of another.
 */
const PATTERNS: { re: RegExp; key: string; vars: string[] }[] = [
  {
    re: /^Refusing to sign \$(.+?) — above your \$(.+?) per-signature cap\. Raise it in Limits if you meant to\.$/,
    key: 'Refusing to sign ${usd} — above your ${cap} per-signature cap. Raise it in Limits if you meant to.',
    vars: ['usd', 'cap'],
  },
  {
    re: /^The gateway quoted an invalid amount \((.+?)\)\.$/,
    key: 'The gateway quoted an invalid amount ({amount}).',
    vars: ['amount'],
  },
  {
    re: /^Unrecognised network (.+)\.$/,
    key: 'Unrecognised network {network}.',
    vars: ['network'],
  },
  {
    re: /^Your wallet is on chain (.+?) but this payment is on (.+?)\. Switch network and try again\.$/,
    key: 'Your wallet is on chain {have} but this payment is on {want}. Switch network and try again.',
    vars: ['have', 'want'],
  },
  /**
   * The "not currently servable" pattern is deliberately gone.
   *
   * It matched a sentence this app no longer produces, because the claim was measured to be
   * false: a 400 from the pricing probe does not mean the model is dead. openai/gpt-image-2
   * priced fine 50 times out of 50 while the console was telling people to pick another model.
   *
   * Its replacement relays the GATEWAY's own sentence, which cannot be matched by a fixed
   * pattern here and is therefore not translated — the gateway already answers in careful,
   * neutral language of its own. A pattern kept for a message nothing throws is worse than
   * absent: it reads as coverage.
   */
  {
    re: /^The gateway would not price this (.+?) request\. This is often temporary — try again, and if it keeps happening the request itself may need adjusting\.$/,
    key: 'The gateway would not price this {model} request. This is often temporary — try again, and if it keeps happening the request itself may need adjusting.',
    vars: ['model'],
  },
  {
    re: /^the gateway answered (.+?) when asked to price this (.+)$/,
    key: 'the gateway answered {status} when asked to price this {unit}',
    vars: ['status', 'unit'],
  },
  {
    re: /^(.+?) generation failed \((.+?)\)$/,
    key: '{what} generation failed ({status})',
    vars: ['what', 'status'],
  },
]

export function translateError(locale: Locale, message: string): string {
  const exact = translate(locale, message)
  // An exact hit means the catalogue holds this whole sentence. Checked first because it is both the
  // common case and the cheap one.
  if (exact !== message) return exact

  for (const p of PATTERNS) {
    const m = p.re.exec(message)
    if (!m) continue
    const vars: Record<string, string> = {}
    p.vars.forEach((name, i) => {
      vars[name] = m[i + 1]
    })
    const out = translate(locale, p.key, vars)
    // If the catalogue has no entry for the pattern, translate() returns the key with placeholders
    // filled — which reads as English with the right values in it, not as a broken template.
    return out
  }
  return message
}

/** The pattern keys, so the drift guard can check they are all translated. */
export function errorPatternKeys(): string[] {
  return PATTERNS.map((p) => p.key)
}
