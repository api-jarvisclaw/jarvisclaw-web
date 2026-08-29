/**
 * Signing in must make the session able to pay.
 *
 * It did not. `check()` set `account`, the keys loaded, and they rendered as a LIST OF BUTTONS —
 * the panel showed "test / unlimited" under "API KEY" — but `apiKey` stayed null until one was
 * clicked. `anonymous` is `wallet === null && apiKey === null`, so it stayed true and every paid
 * tool refused.
 *
 * Reported from a screenshot: the user wrote "我已经登录了，你直接调用API" and the reply was still
 * "由于这个会话没有钱包和API密钥，我无法直接调用". Both the panel and the model were telling the
 * truth. The user read a menu as a status line, which is the reasonable reading — signing in is
 * the act that grants access, and no product then asks which of your own credentials to activate.
 *
 * Source-level because the defect was an ABSENT step, not a wrong one. There was nothing to assert
 * about; the guard has to require that the step exists and that its conditions are the narrow ones.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const panel = () => readFileSync('src/ui/AccountPanel.tsx', 'utf8')

/**
 * The auto-adopt effect's body, isolated so the assertions cannot match some other code.
 *
 * Sliced to the effect's own dependency array rather than a fixed character count. A fixed window
 * is what a first version used, and at 1400 characters it ended 8 characters before `void pick(` —
 * so the "picks a key without a second click" assertion failed on correct code, and the mutation
 * that adopts an expired key SURVIVED, because the line it should have caught was outside the
 * window too. A guard whose reach depends on comment length is not measuring the code.
 */
function adoptEffect(): string {
  const text = panel()
  const at = text.indexOf('Adopt a usable key as soon as one is known')
  expect(at, 'the auto-adopt effect is gone — signing in no longer grants the ability to pay')
    .toBeGreaterThan(0)
  const end = text.indexOf('}, [account, keys, keyName])', at)
  expect(end, 'the adopt effect has no recognisable end; this guard would read the whole file')
    .toBeGreaterThan(at)
  return text.slice(at, end)
}

describe('adopting a key on sign-in', () => {
  it('picks a key without a second click', () => {
    expect(adoptEffect()).toMatch(/void pick\(/)
  })

  it('only when nothing is chosen yet', () => {
    /**
     * Without this the effect would fight the user: "use wallet instead" clears the key, and an
     * unconditional adopt would put it straight back, making the button appear broken.
     */
    expect(adoptEffect()).toContain('keyName !== null')
  })

  it('only a key that can actually pay', () => {
    /**
     * An expired or exhausted key would flip `anonymous` to false, so the session would advertise
     * paid tools, quote a price, take the user through the consent dialog and only then fail at the
     * gateway. That is strictly worse than the refusal it replaces — the panel already disables
     * those buttons for the same reason.
     *
     * Asserted against the CODE with comments stripped. Checking the raw slice for the words
     * "expired" and "exhausted" passed even when the filter was replaced by `keys[0]`, because the
     * comment above the effect explains those very words — the mutation survived while the guard
     * reported green. A guard satisfied by its own prose measures nothing.
     */
    const code = adoptEffect()
      .split('\n')
      .filter((l) => {
        const t = l.trimStart()
        return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
      })
      .join('\n')
    expect(code, 'the adopt effect body vanished under comment stripping').toContain('keys')
    expect(code).toContain('expired')
    expect(code).toContain('exhausted')
  })

  it('does nothing without an account', () => {
    // The keys array is empty then anyway, but the guard states it: a stale keys list from a
    // previous account must not be adopted after a sign-out.
    expect(adoptEffect()).toContain('account === null')
  })

  it('leaves the key list rendered, so a different one can be chosen', () => {
    // Auto-adopting the first usable key is a guess when there are several. The list has to stay
    // on screen, or that guess becomes unchangeable.
    expect(panel()).toContain('account-key-list')
  })
})

describe('the payment-capability rule it feeds', () => {
  it('is still that either rail lifts anonymous', () => {
    /**
     * Pinned because the adopt effect is only useful if `apiKey` is what `anonymous` reads. If that
     * definition changed to require a wallet, this fix would go quietly inert — the key would be
     * adopted and the session would still refuse to pay.
     */
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toMatch(/const anonymous = wallet === null && apiKey === null/)
  })
})
