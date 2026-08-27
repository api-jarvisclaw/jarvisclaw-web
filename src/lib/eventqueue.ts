/**
 * A queue that a synchronous callback can push into and an async generator can await.
 *
 * ## The problem it solves
 *
 * `streamChat` takes a plain callback and invokes it per SSE frame. `runAgent` is an async
 * generator. A generator cannot `yield` from inside a nested function, so the agent loop did
 * this instead:
 *
 *     const pending: AgentEvent[] = []
 *     result = await streamChat(req, (delta) => { pending.push(...) })
 *     yield* pending
 *
 * which is correct and also means **nothing reaches the screen until the whole response has
 * finished**. The transport was streaming the entire time; delivery was batched. Measured
 * against the free tier: an eleven-second answer arrived as one block at eleven seconds, with a
 * spinner and an empty transcript until then — indistinguishable from a hung request, and
 * reported as exactly that.
 *
 * ## Why a queue rather than restructuring the caller
 *
 * The alternative is making `streamChat` itself an async iterable and having the agent loop
 * iterate it. That is a cleaner shape in the abstract, and it is a worse change here: the
 * agent's downgrade path needs the *return value* (content, tool calls, resolved model) after
 * the stream ends, so it would have to iterate to exhaustion and then read a completion value
 * off the iterator — two mechanisms where there is now one. Tool-call assembly by index also
 * lives inside `streamChat` and produces nothing until the stream ends, so it has no per-frame
 * value to yield.
 *
 * This queue keeps `streamChat`'s callback contract untouched and inverts control only where it
 * is actually needed: between the callback and the generator.
 *
 * ## Ordering and completion
 *
 * Push order is delivery order. `close()` ends the iteration once the buffer drains, so a
 * consumer that is behind still receives every queued item before finishing — dropping the tail
 * would silently truncate the last words of an answer.
 *
 * `fail()` propagates an error to the consumer, and it is not the same as `close()`: a stream
 * that dies mid-answer must not look like one that ended.
 */
export class EventQueue<T> {
  private readonly buffer: T[] = []
  /** Resolves the pending `next()` when an item, a close or a failure arrives. */
  private wake: (() => void) | null = null
  private closed = false
  private failure: unknown = null

  /** Adds an item. Safe to call from a synchronous callback. */
  push(item: T): void {
    // After close, pushes are dropped rather than throwing. A callback can fire once more while
    // the stream tears down, and an exception thrown from inside a fetch reader's callback
    // surfaces as an unrelated network error — which is a far worse symptom than one lost frame
    // that arrived after the answer was already complete.
    if (this.closed) return
    this.buffer.push(item)
    this.signal()
  }

  /** No more items. The consumer finishes after draining what is already queued. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.signal()
  }

  /**
   * Ends the queue by raising `err` in the consumer, after it drains the buffer.
   *
   * Draining first is deliberate: a stream that fails halfway has usually already delivered
   * real text, and discarding it would take words off the screen that the user has read.
   */
  fail(err: unknown): void {
    if (this.closed) return
    this.failure = err
    this.closed = true
    this.signal()
  }

  private signal(): void {
    const w = this.wake
    if (w) {
      // Cleared BEFORE calling, not after. The waiter resumes synchronously in some engines and
      // may immediately await again, installing a new resolver — clearing afterwards would wipe
      // that new one and the next push would have nobody to wake, hanging the consumer.
      this.wake = null
      w()
    }
  }

  /**
   * Drains the queue as items arrive, ending on `close()` or raising on `fail()`.
   *
   * One consumer only. Two would race for the same single `wake` slot and each receive an
   * arbitrary half of the events, which for a token stream means interleaved nonsense. The agent
   * loop is the only caller and iterates it once per model turn.
   */
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.buffer.length > 0) {
        // shift() rather than a copy-and-clear: an item pushed while the consumer is mid-yield
        // has to be picked up by this same loop, and swapping the array out would leave it in a
        // buffer nobody reads until the next push.
        yield this.buffer.shift() as T
      }
      if (this.closed) {
        if (this.failure !== null) throw this.failure
        return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}
