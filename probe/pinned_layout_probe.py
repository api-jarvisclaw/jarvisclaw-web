"""The composer stays on screen however long the conversation gets.

The bug: after a few dozen turns the whole DOCUMENT scrolled, so the input was four
screens below the fold and had to be scrolled down to. Measured at a 780px viewport with
40 turns, `.main` grew to 5381px and the composer sat at y=5218.

Two CSS defaults caused it, and both are easy to reintroduce: a grid item AND a flex item
each default to `min-height: auto`, meaning "never shrink below my content". `.transcript`
therefore refused to shrink, `.main` outgrew its grid row, and the page scrolled.

The tell was that `.transcript.scrollHeight === .clientHeight`. It has `overflow-y: auto`
and always did — but an element allowed to grow forever never overflows, so its own
scrollbar never appeared and the document's did instead. That is why this probe asserts on
WHICH element scrolls, not merely that something does: `overflow-y: auto` looks correct in
the stylesheet while doing nothing at all.

Content is injected into the DOM rather than sent as real messages. Forty round trips would
cost money and minutes, and what is under test is the layout's response to tall content —
which is tall regardless of how it got there.
"""

import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CHAT_URL", "https://chat.jarvisclaw.ai/")

# Two viewports and both rail states. The layout is a three-column grid that drops panes at
# 1200px and 820px, so a fix that only holds at desktop width is not a fix — a phone is where
# a buried input hurts most.
VIEWPORTS = [
    ("desktop", 1440, 780),
    ("laptop", 1180, 700),
    ("phone", 420, 720),
]

STATE = """() => {
  const c = document.querySelector('.composer');
  const t = document.querySelector('.transcript');
  const m = document.querySelector('.main');
  const doc = document.scrollingElement;
  const r = c.getBoundingClientRect();
  return {
    viewportH: innerHeight,
    composerTop: Math.round(r.top),
    composerH: Math.round(r.height),
    // Fully in view, not merely intersecting: a composer whose bottom edge is cut off is
    // still a composer the user has to scroll to.
    composerFullyVisible: r.top >= 0 && r.bottom <= innerHeight + 1,
    mainH: Math.round(m.getBoundingClientRect().height),
    mainTop: Math.round(m.getBoundingClientRect().top),
    docScrolls: doc.scrollHeight > doc.clientHeight + 1,
    transcriptScrolls: t.scrollHeight > t.clientHeight + 1,
    // The grid's own row track. A SECOND row means a pane wrapped instead of hiding, which
    // halves the viewport — and the composer stays "pinned" inside its half, so every other
    // assertion here passes while the chat pane is a third of the window.
    gridRows: getComputedStyle(document.querySelector('.shell')).gridTemplateRows,
    railHidden: getComputedStyle(document.querySelector('.rail')).display === 'none',
  };
}"""

FILL = """(n) => {
  const t = document.querySelector('.transcript');
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'turn turn-agent';
    d.innerHTML = '<div class="bubble">Filler turn ' + i + ' — ' + 'text '.repeat(40) + '</div>';
    t.appendChild(d);
  }
}"""


def check(page, label: str) -> list[str]:
    empty = page.evaluate(STATE)
    page.evaluate(FILL, 40)
    page.wait_for_timeout(500)
    full = page.evaluate(STATE)

    print(f"== {label} ({empty['viewportH']}px tall) ==")
    print(f"   .main height        {empty['mainH']} -> {full['mainH']}")
    print(f"   composer top        {empty['composerTop']} -> {full['composerTop']}")
    print(f"   composer height     {empty['composerH']} -> {full['composerH']}")
    print(f"   document scrolls    {full['docScrolls']}")
    print(f"   transcript scrolls  {full['transcriptScrolls']}")
    print(f"   grid rows           {full['gridRows']}")
    print(f"   rail hidden         {full['railHidden']}")

    fails = []
    if full["docScrolls"]:
        # The original bug, stated in its own terms.
        fails.append("the document scrolls, so the composer is pushed below the fold")
    if not full["transcriptScrolls"]:
        # Without this the probe would pass on a page with no scrolling anywhere — which is
        # what a broken `overflow` looks like before the content is tall enough to notice.
        fails.append("the transcript does not scroll, so the overflow is landing elsewhere")
    if not full["composerFullyVisible"]:
        fails.append("the composer is not fully in view")
    if full["composerTop"] != empty["composerTop"]:
        fails.append(f"the composer moved {full['composerTop'] - empty['composerTop']}px")
    if full["composerH"] != empty["composerH"]:
        # A subtler form of the same defect: flex looking for something to shrink and
        # choosing the input. It stays on screen but gets thinner as the chat grows.
        fails.append(f"the composer was squeezed by {empty['composerH'] - full['composerH']}px")
    if full["mainH"] > empty["viewportH"] + 1:
        fails.append(f"main outgrew the viewport ({full['mainH']}px)")
    # The second bug this probe missed on its first run. It reported PASS on a laptop-width
    # page where .main was 330px inside a 700px window: the composer WAS pinned, just pinned
    # inside the top half of a grid that had silently grown a second row. Both breakpoints'
    # `display: none` were being overridden by the panes' own later rules, so at 1180px three
    # children competed for two columns and the third wrapped.
    #
    # Checking "is the composer pinned" was not enough, because a wrong layout can still be
    # internally consistent. The frame has to fill the window too.
    if len(full["gridRows"].split()) > 1:
        fails.append(f"the shell grid grew a second row ({full['gridRows']}) — a pane wrapped instead of hiding")
    if full["mainTop"] != 0:
        fails.append(f"main starts at y={full['mainTop']}, not at the top of the window")
    if full["mainH"] < empty["viewportH"] - 1:
        fails.append(f"main is only {full['mainH']}px of a {empty['viewportH']}px window")

    for f in fails:
        print(f"   FAIL: {f}")
    return fails


def main() -> int:
    all_fails = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, w, h in VIEWPORTS:
            page = browser.new_page(viewport={"width": w, "height": h})
            page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            # Waits for the control under test, not a timer. A fixed delay that fires before
            # hydration reports a missing composer, which is indistinguishable from the bug.
            page.wait_for_selector(".composer textarea, .composer-shell textarea", timeout=30000)
            page.wait_for_timeout(1200)
            all_fails += [f"{name}: {f}" for f in check(page, name)]
            page.close()
        browser.close()

    print()
    if all_fails:
        print(f"FAIL ({len(all_fails)}):")
        for f in all_fails:
            print(f"   {f}")
        return 1
    print("PASS: the composer is pinned at every width; the transcript scrolls inside itself.")
    return 0


sys.exit(main())
