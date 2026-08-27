/**
 * How many prompts the library holds — the count alone, in its own module.
 *
 * The same load-bearing indirection as `seedance-count.ts`, for the same reason: the gallery tab
 * shows this number before anyone opens the tab, and `library.ts` is 152 KB of prompt text.
 * Importing it to read `LIBRARY.length` would make the import static again and Rollup would merge
 * the whole payload back into the main bundle — with the `lazy()` call still sitting there looking
 * correct.
 *
 * That failure is silent: nothing breaks, no test fails, and the only symptom is every visitor
 * downloading a prompt library to see a chat box.
 *
 * `library.test.ts` asserts this equals the real array length, so the two cannot drift.
 */
export const LIBRARY_COUNT = 119
