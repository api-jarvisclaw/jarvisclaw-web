"""Extract the prompt library from raojiacui/prompt-engineering-text-to-image-and-video-.

That repo is MIT-licensed and the prompts in it are its author's own work, which is why it is
the only one of the five candidate sources being ingested. The other four were rejected on
licensing rather than quality — see the note in src/lib/library.ts.

## Why a parser rather than hand transcription

18 markdown files carrying ~100 prompts in FIVE different layouts. The author's format evolved
across the collection, and each variant has to be read correctly or content is silently lost:

  A. ARROW / 无限美食空间   `**Final Prompt (EN):**` then a ```yaml block of params
  B. 反乌托邦 / 头发狂想     pipe-prefixed `| [事件全貌]:` lines, `Parameters:` with `|` prefixes
  C. 魔法食物球              `**Final Prompt (EN):**` then a markdown TABLE of params
  D. 东方玄幻                `Final Prompt (EN): |` YAML-block style, indented continuation
  E. 文生图合集              plain ``` fenced prompt under `### 提示词`, no params at all

Hand-copying 100 prompts across five layouts is where transcription errors live, and a wrong
prompt is worse than an absent one: it is published as something the author wrote.

## What is deliberately NOT extracted

Editing tutorials and the Remotion stitching guide. They are prose about workflow, not prompts,
and a gallery entry whose "prompt" is a paragraph of instructions is a broken entry.

Usage: python cdn/extract_prompt_library.py <repo-dir> [--out library.json]
"""

import argparse
import json
import re
import sys
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

# Files that are tutorials, not prompt collections. Named explicitly rather than pattern-matched
# so adding a file to the repo cannot silently opt it in or out.
SKIP = {
    "README.md",
    "video-editing-guide.md",
    "Remotion视频拼接文档.md",
    "FOOD_VIDEO_TUTORIAL.md",
    "剪辑教程.md",
    "剪辑教程(1).md",
    "视频剪辑过程.md",
    "梦核视频拼接教程.md",
}

# Category per source file. Assigned from the file's own subject rather than inferred from the
# prompt text: these are curated series and the author's grouping is better than any keyword
# rule I would write. The word-boundary lesson from inferCategory applies — a classifier reading
# "food" out of "seafood platter" would scatter one coherent series across three categories.
CATEGORIES = {
    "文生图提示词合集.md": ("image-style", "图像风格转换"),
    "ARROW_Video_Prompts.md": ("cinematic", "电影分镜"),
    "反乌托邦宿舍系列AI视频提示词.md": ("dystopian", "反乌托邦叙事"),
    "超现实创意画册视频提示词.md": ("surreal", "超现实创意"),
    "魔法食物球视频提示词.md": ("food", "美食转化"),
    "无限美食空间系列提示词.md": ("food", "美食转化"),
    "东方玄幻系列AI视频提示词.md": ("xianxia", "东方玄幻"),
    "AI梦核视频提示词.md": ("dreamcore", "梦核超现实"),
    "头发狂想ASMR提示词.md": ("asmr", "ASMR 视觉"),
    "capsule-tent-video-prompts.md": ("product", "产品展开"),
}

# Which generation endpoint an entry should run against. Only the text-to-image collection is an
# image prompt; everything else in this repo is a video shot description, and sending one to the
# image endpoint produces a poster of a scene instead of the scene.
IMAGE_FILES = {"文生图提示词合集.md"}


def clean(text: str) -> str:
    """Strips the layout scaffolding without touching the prompt's own wording.

    Only leading pipes and bold markers are removed — the things the author used as a bullet in
    one variant and omitted in another. Nothing is reflowed: the line structure of a shot
    description is part of the craft, exactly as noted for the seedance collection.
    """
    lines = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        # Variant B prefixes every line with "| ".
        if line.startswith("|"):
            line = line[1:].lstrip()
        lines.append(line)
    out = "\n".join(lines).strip()
    # Collapse 3+ blank lines, which the pipe stripping can leave behind.
    return re.sub(r"\n{3,}", "\n\n", out)


def parse_params(block: str) -> dict[str, str]:
    """Reads generation parameters out of any of the three layouts the author used."""
    params: dict[str, str] = {}
    for raw in block.split("\n"):
        line = raw.strip()
        if not line:
            continue
        # Variant C: a markdown table row, "| aspect_ratio | 16:9 |".
        if line.startswith("|") and line.count("|") >= 3:
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) >= 2 and cells[0] and not set(cells[0]) <= {"-", ":"}:
                key = cells[0].strip("`* ")
                if key.lower() not in ("参数", "parameter", "key"):
                    params[key] = cells[1]
            continue
        # Variants A/B/D: "key: value", optionally pipe-prefixed (stripped by clean()).
        line = line.lstrip("|").strip()
        if line.lower().startswith("parameters"):
            continue
        m = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$", line)
        if m:
            params[m.group(1)] = m.group(2).strip().strip("()")
    return params


def split_sections(text: str) -> list[tuple[str, str]]:
    """Splits a file into its numbered `## N. Title` sections."""
    out = []
    parts = re.split(r"^## +(?:\d+[.、]\s*)?(.+?)\s*$", text, flags=re.MULTILINE)
    # parts[0] is the preamble; then alternating (title, body).
    for i in range(1, len(parts) - 1, 2):
        title = parts[i].strip()
        body = parts[i + 1]
        # Skip the table-of-contents and any trailing notes section.
        # Summary and spec sections. They carry a params block and no prompt, so the
        # last-resort "first fenced block" rule below would publish a parameter list as if it
        # were a prompt — which is how "统一视觉风格参数" ended up counted as an entry.
        if re.search(r"提示词目录|^目录|说明|使用建议|附录|共同特征|统一视觉|统一.*规范"
                     r"|生成工具建议|技术参数汇总|整体风格要求|重复"
                     # "通用风格指南" / "通用技术参数汇总": the author's shared-settings sections.
                     # They carry a params table and no prompt, so the last-resort rule below
                     # published one as an entry whose text began "aspect_ratio: ...".
                     r"|^通用", title):
            continue
        out.append((title, body))
    return out


def extract_prompt(body: str) -> str:
    """Pulls the prompt text out of a section, whichever layout it uses."""
    # Variant E: a plain fenced block under "### 提示词".
    m = re.search(r"###\s*提示词\s*\n+```[a-z]*\n(.*?)```", body, re.S)
    if m:
        return clean(m.group(1))

    # Variant H: "**Final Prompt (EN):**" followed by a FENCED block (无限美食空间). Checked
    # before the unfenced form below, because that one would match here too and return the
    # fence markers as part of the prompt — which it did, on all eight entries in that file.
    m = re.search(r"\*\*Final Prompt \(EN\):\*\*\s*\n+```[a-z]*\n(.*?)```", body, re.S)
    if m and m.group(1).strip():
        return clean(m.group(1))

    # Variants A/B/C: "**Final Prompt (EN):**" up to the params heading or a horizontal rule.
    m = re.search(
        r"\*\*Final Prompt \(EN\):\*\*\s*\n?(.*?)(?=\n###|\n---|\nParameters:|\Z)", body, re.S
    )
    if m and m.group(1).strip():
        return clean(m.group(1))

    # Variant D: "Final Prompt (EN): |" with an indented YAML block, and variant F: the same
    # heading with no pipe and no indent (AI梦核). One regex covers both. Without it the whole
    # dreamcore file extracted ZERO prompts while reporting no parse error, because its five
    # sections fell through to the fenced-block fallback and that file contains no fences.
    m = re.search(r"Final Prompt \(EN\):\s*\|?\s*\n(.*?)(?=\n###|\n---|\nParameters:|\Z)", body, re.S)
    if m and m.group(1).strip():
        return clean(m.group(1))

    # Variant G: a blockquoted prompt, "> **提示词**：" followed by quoted lines (头发狂想ASMR).
    # Stops before the author's 注意事项 list, which is production notes for a human — telling
    # the model "don't show his face, only the top of the head" as if it were prompt text would
    # publish shooting notes as a prompt.
    m = re.search(
        r">\s*\*\*提示词\*\*[：:]\s*\n((?:>.*\n?)+?)(?=>\s*\*\*注意事项|\n\s*\n|\Z)", body
    )
    if m:
        return clean("\n".join(re.sub(r"^>\s?", "", x) for x in m.group(1).split("\n")))

    # Last resort: the first fenced block in the section.
    m = re.search(r"```[a-z]*\n(.*?)```", body, re.S)
    if m:
        return clean(m.group(1))
    return ""


def extract_params(body: str) -> dict[str, str]:
    """Pulls the generation parameters, whichever layout they use."""
    # A fenced yaml/params block.
    m = re.search(r"生成参数[^\n]*\n+```[a-z]*\n(.*?)```", body, re.S)
    if m:
        return parse_params(m.group(1))
    # A table or pipe/plain list following the params heading.
    m = re.search(r"生成参数[^\n]*\n(.*?)(?=\n## |\n---\s*\n## |\Z)", body, re.S)
    if m:
        return parse_params(m.group(1))
    return {}


def extract_intent(body: str) -> str | None:
    """The author's own 用途 / 适用场景 line, when there is one.

    Kept because it is what makes a prompt findable: "将产品平面图转换为工业设计草图" tells a
    reader what this is FOR, which a wall of style adjectives does not.
    """
    m = re.search(r">\s*\*\*用途\*\*[：:]\s*(.+)", body)
    if m:
        return m.group(1).strip()
    m = re.search(r"###\s*适用场景\s*\n+((?:\s*[-*]\s*.+\n?)+)", body)
    if m:
        items = [re.sub(r"^\s*[-*]\s*", "", x).strip() for x in m.group(1).strip().split("\n")]
        return "；".join(i for i in items if i)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo", help="path to the cloned repo")
    ap.add_argument("--out", default="library.json")
    args = ap.parse_args()

    repo = Path(args.repo)
    entries = []
    unparsed = []

    for md in sorted(repo.glob("*.md")):
        if md.name in SKIP:
            continue
        if md.name not in CATEGORIES:
            print(f"  ! {md.name} has no category assignment — skipped, add it explicitly")
            continue
        cat, cat_label = CATEGORIES[md.name]
        kind = "image" if md.name in IMAGE_FILES else "video"
        text = md.read_text(encoding="utf-8")
        sections = split_sections(text)
        got = 0
        for title, body in sections:
            prompt = extract_prompt(body)
            if not prompt or len(prompt) < 60:
                unparsed.append(f"{md.name} :: {title} (len={len(prompt)})")
                continue
            entries.append({
                "title": title,
                "prompt": prompt,
                "category": cat,
                "categoryLabel": cat_label,
                "kind": kind,
                "params": extract_params(body),
                "intent": extract_intent(body),
                "sourceFile": md.name,
            })
            got += 1
        print(f"  {md.name:<44} {got:>3} prompts  [{cat}]")

    print(f"\nextracted {len(entries)} prompts across "
          f"{len({e['category'] for e in entries})} categories")
    if unparsed:
        print(f"\nNOT extracted ({len(unparsed)}) — each of these is content lost, so it is "
              f"listed rather than counted:")
        for u in unparsed:
            print(f"   {u}")

    # Length distribution: a prompt this collection considers complete runs to thousands of
    # characters, so a very short one usually means the parser grabbed a fragment.
    lens = sorted(len(e["prompt"]) for e in entries)
    if lens:
        print(f"\nprompt length: min={lens[0]} p50={lens[len(lens)//2]} max={lens[-1]}")

    Path(args.out).write_text(
        json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
