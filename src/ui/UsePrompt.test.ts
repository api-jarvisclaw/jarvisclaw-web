/**
 * "Make your own" must carry the model, not just the prompt and the mode.
 *
 * Reported from a screenshot: a Seedance 2.0 gallery prompt loaded into the composer and quoted
 * "One video from bytedance/seedance-2.0-mini costs $0.399554". The mini is the video modality
 * default, ~2.8x cheaper than the model on the card ($1.136), with different parameter ceilings.
 * The quote was real, which is why nothing looked broken — it was the price of a different model.
 *
 * These are source-level guards on purpose. The threading is the whole fix, and a unit test that
 * calls a mapping function directly stays green when a call site drops the third argument — which
 * is precisely the shape of the original defect: the panes had `item.model` in hand and printed
 * it on screen while handing it nowhere.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')

const PANES = [
  'src/ui/Gallery.tsx',
  'src/ui/SeedancePane.tsx',
  'src/ui/LibraryPane.tsx',
] as const

describe('the onUsePrompt contract', () => {
  it('declares a model parameter in every pane that forwards it', () => {
    for (const file of PANES) {
      const text = read(file)
      const declarations = text.match(/onUsePrompt: \([^)]*\) => void/g) ?? []
      expect(declarations.length, `${file} declares no onUsePrompt signature`).toBeGreaterThan(0)
      for (const decl of declarations) {
        expect(decl, `${file}: signature drops the model`).toContain('model')
      }
    }
  })

  it('passes three arguments at every call site', () => {
    /**
     * The load-bearing check. A call site that reverts to `onUsePrompt(prompt, mode)` compiles
     * against an optional third parameter and would silently resume quoting the default, so the
     * arity is asserted directly rather than left to the type system.
     */
    let sites = 0
    for (const file of PANES) {
      // Matched by scanning to the BALANCED closing paren, not by a regex.
      //
      // `onUsePrompt\([^)]*\)` stops at the first `)` it meets, which for a nested argument like
      // `gatewayModelFor(item.model)` is that call's own paren — so the match ended mid-list and
      // reported a correct 3-argument site as passing 2. The guard would have failed on exactly
      // the code it exists to require.
      const text = read(file)
      for (const m of text.matchAll(/onUsePrompt\(/g)) {
        const open = m.index! + m[0].length - 1
        let depth = 0
        let close = -1
        for (let i = open; i < text.length; i += 1) {
          if (text[i] === '(') depth += 1
          else if (text[i] === ')') {
            depth -= 1
            if (depth === 0) {
              close = i
              break
            }
          }
        }
        expect(close, `${file}: unbalanced onUsePrompt( at ${open}`).toBeGreaterThan(open)
        const call = text.slice(m.index!, close + 1)
        // Skip a zero-argument occurrence, which would be a declaration artefact rather than a
        // call. There are none today; asserted below via the site count.
        if (call.slice('onUsePrompt('.length, -1).trim() === '') continue
        sites += 1
        // Commas at depth 0 of the argument list. Counted rather than split, because an argument
        // can itself be a call: gatewayModelFor(item.model) contains no comma, but a future
        // argument might.
        let argDepth = 0
        let commas = 0
        for (const ch of call.slice('onUsePrompt('.length, -1)) {
          if (ch === '(' || ch === '[') argDepth += 1
          else if (ch === ')' || ch === ']') argDepth -= 1
          else if (ch === ',' && argDepth === 0) commas += 1
        }
        expect(commas, `${file}: \`${call}\` passes ${commas + 1} args, needs 3`).toBe(2)
      }
    }
    expect(sites, 'found no onUsePrompt call sites — this guard is scanning nothing').toBe(3)
  })

  it('resolves the published name to a gateway id at the call site', () => {
    // A pane that passes a DISPLAY name ("Seedance 2.0") as the model would set the picker to a
    // string no gateway model matches. App.tsx guards against that by ignoring an unknown id, so
    // the symptom would be the bug silently returning rather than an error.
    for (const file of ['src/ui/Gallery.tsx', 'src/ui/SeedancePane.tsx'] as const) {
      const text = read(file)
      expect(text, `${file} must translate the published name`).toContain('gatewayModelFor(')
    }
  })

  it('leaves the library collection without a model, since it publishes none', () => {
    // Explicit null, not a forgotten argument. Asserted so a later "helpfulness" fix does not
    // invent a model for prompts whose authors never recorded one.
    expect(read('src/ui/LibraryPane.tsx')).toMatch(/onUsePrompt\(item\.prompt,\s*item\.kind,\s*null\)/)
  })
})

describe('SeedancePane names its model once', () => {
  it('displays the same constant it hands to the composer', () => {
    /**
     * The heading, the detail panel and the handoff all used the literal "Seedance 2.0". The
     * handoff is what gets QUOTED and CHARGED, so it must not be able to drift from what the
     * panel claims — a page saying 2.0 while billing the mini is the defect this file is about,
     * one step removed.
     */
    const text = read('src/ui/SeedancePane.tsx')
    expect(text).toMatch(/const SEEDANCE_MODEL = '[^']+'/)
    const stray = text
      .split('\n')
      .filter((l) => /Seedance 2\.0/.test(l) && !/^\s*(\*|\/\/)/.test(l.trimStart()))
      .filter((l) => !/const SEEDANCE_MODEL/.test(l))
    expect(stray, 'a displayed model name that can drift from the one being charged').toEqual([])
  })
})

describe('App applies the model it was given', () => {
  it('sets the picker from the prompt model', () => {
    // Threading the value through three panes is inert unless App acts on it. This is the one
    // place the value stops being data and starts deciding what gets charged.
    const app = read('src/App.tsx')
    const handler = app.slice(app.indexOf('onUsePrompt={('))
    expect(handler.slice(0, 1400)).toContain('setModel(')
  })

  it('ignores a model this gateway does not serve', () => {
    // A published name that resolves to an id the catalogue lacks must not be pinned: the picker
    // would show a model that cannot run, and the generation would fail after the user had
    // already approved a charge.
    const app = read('src/App.tsx')
    const handler = app.slice(app.indexOf('onUsePrompt={('))
    expect(handler.slice(0, 1400)).toMatch(/models\.some\(/)
  })
})
