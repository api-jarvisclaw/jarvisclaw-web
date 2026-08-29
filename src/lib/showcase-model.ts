/**
 * Maps a showcase/library item's published model name to the gateway id that can reproduce it.
 *
 * The gallery displays the model that made each piece — "SeeDance 2.0" is printed on the card —
 * and then "Make your own" dropped it, loading the prompt into the composer with the mode set
 * and the model left at whatever the picker happened to hold. A prompt written for
 * bytedance/seedance-2.0 was quoted against bytedance/seedance-2.0-mini, the modality default.
 *
 * That is not a cosmetic substitution. The two models differ in price by ~2.8x ($1.136 vs
 * $0.399554 measured on the quote), and the parameters a prompt relies on differ too — a 15s
 * shot list handed to a model whose ceiling is lower comes back truncated or reframed. So the
 * user was shown a price for a different model than the one whose example they clicked, and the
 * result would not have matched the card they were looking at.
 *
 * Published names are display strings ("SeeDance 2.0", "GPT Image 2"), not ids, because they are
 * what the original author credited. This is the one place that translates them.
 *
 * Deliberately returns null rather than guessing. An unrecognised name means the modality
 * default is used, which is the current behaviour — a wrong id would be worse, because it would
 * quote and charge for a model nobody named.
 */

/**
 * Published name (lowercased, punctuation-insensitive) to gateway id.
 *
 * Keyed on a normalised form so "SeeDance 2.0", "Seedance 2.0" and "seedance-2.0" all resolve.
 * The values must be ids the gateway actually serves — see modality.ts, whose tables are keyed
 * by the same strings, and whose measured prices are recorded there.
 */
const PUBLISHED_TO_ID: Record<string, string> = {
  seedance20: 'bytedance/seedance-2.0',
  seedance20fast: 'bytedance/seedance-2.0-fast',
  seedance20mini: 'bytedance/seedance-2.0-mini',
  seedance25: 'bytedance/seedance-2.5',
  seedance15pro: 'bytedance/seedance-1.5-pro',
  // Bare "SeeDance" with no version. The launch films credit it this way, and 2.0 is what
  // produced them — resolving it to the family's current default is better than falling through
  // to the modality default, which is the mini and a different model.
  seedance: 'bytedance/seedance-2.0',
  gptimage2: 'openai/gpt-image-2',
  gptimage1: 'openai/gpt-image-1',
  nanobanana: 'google/nano-banana',
  nanobananapro: 'google/nano-banana-pro',
  sora2: 'azure/sora-2',
}

/** Strip case, spaces, dots and dashes, so display spelling does not decide the lookup. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The gateway id for a published model name, or null when it is not recognised.
 *
 * An id that arrives already in gateway form (`bytedance/seedance-2.0`) is returned as-is: the
 * user's own library items carry real ids, while the showcase carries display names, and both
 * flow through the same "Make your own" button.
 */
export function gatewayModelFor(published: string | null | undefined): string | null {
  if (!published) return null
  const trimmed = published.trim()
  if (trimmed === '') return null
  // Already an id: a vendor-prefixed name is what the gateway itself returns and what the
  // library stores, so it needs no translation.
  if (trimmed.includes('/')) return trimmed
  return PUBLISHED_TO_ID[normalise(trimmed)] ?? null
}
