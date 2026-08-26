/**
 * How many video prompts the collection holds — the count alone, in its own module.
 *
 * This looks like pointless indirection and is load-bearing. The gallery tab shows the number
 * before anyone opens the tab, and `seedance.ts` is 330 KB of prompt text. Importing it to read
 * `SEEDANCE.length` would make the import static again and Rollup would merge the whole payload
 * back into the main bundle — with the `lazy()` call still sitting there looking correct.
 *
 * That is the failure worth guarding against: a code-split that silently stops splitting. Nothing
 * breaks, no test fails, and the only symptom is every visitor downloading a video-prompt library
 * to see a chat box. A separate module makes the dependency impossible to reintroduce by accident.
 *
 * `seedance.test.ts` asserts this equals the real array length, so the two cannot drift.
 */
export const SEEDANCE_COUNT = 105
