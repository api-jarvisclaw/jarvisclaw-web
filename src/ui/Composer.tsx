import { useRef, useState } from 'react'

export function Composer({
  busy,
  anonymous,
  onSend,
}: {
  busy: boolean
  anonymous: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    if (busy || text.trim() === '') return
    onSend(text)
    setText('')
    // Height is set inline as the user types, so it has to be reset explicitly or the
    // box stays as tall as the message that was just sent.
    if (ref.current) ref.current.style.height = 'auto'
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <textarea
          ref={ref}
          value={text}
          placeholder="Ask anything…"
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. IME composition must be excluded or
            // committing a Chinese/Japanese candidate with Enter sends a half-typed
            // message instead of accepting the word.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="send-btn" onClick={submit} disabled={busy || text.trim() === ''}>
          {busy ? 'Working…' : 'Send'}
        </button>
      </div>
      <div className="hint">
        {anonymous
          ? 'Free tier — no key needed. Paid APIs will ask before spending anything.'
          : 'Signed in. Paid API calls are charged to your wallet, with a prompt above your per-call limit.'}
      </div>
    </div>
  )
}
