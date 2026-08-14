"""The <style> block in index.html actually parses, and its rules survive.

WHY THIS FILE EXISTS. index.html has now had a CSS comment terminate early
twice, and both times a reviewer's parse was the only thing that caught it. The
failure is silent in every way a browser or a screenshot can show: the tokenizer
recovers from the garbage by swallowing everything up to the next `{`, which
takes the following rule's SELECTOR with it, and that rule is then simply not in
the stylesheet. The page renders, the layout degrades slightly, and nothing
errors.

The second occurrence is the reason for the second test. The commit that FIXED
the first one reintroduced it, in the paragraph describing the fix -- the
comment could not tell the story without writing the terminator as a literal,
and writing one inside a comment ends the comment. That is this project's own
"a blanket sed rewrites the sentences that describe the rename", arrived at from
another direction: check the prose that documents a fix after making it.

Balance alone would not have caught either one on its own merits, so both tests
are here:

  * `test_style_comments_balance` catches the unterminated / doubly-terminated
    case, which is what actually happened twice.
  * `test_known_selectors_survive_a_comment_strip` catches the wider class --
    a comment that swallows a rule WITHOUT unbalancing, which balance cannot
    see. Stripping comments and looking for the selector is the same question
    the browser answers, asked cheaply.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

INDEX = Path(__file__).resolve().parents[1] / "netviz" / "static" / "index.html"

# Selectors that must be in the stylesheet after comments are removed. Chosen to
# be spread through the block rather than clustered: a comment that runs away
# swallows only up to the NEXT `{`, so one selector per area of the block is
# what localizes the damage. `.tuner-actions` is here because it is the rule
# that has been lost twice.
REQUIRED_SELECTORS = (
    "#stage",
    "#rail",
    ".rail-row",
    ".menu-item",
    ".rules-legend",
    ".tuner-panel",
    ".tuner-head",
    ".tuner-actions",
    ".tuner-mark",
    ".tuner-row",
    ".confirm-box",
)


def style_block() -> str:
    """The contents of index.html's one <style> element."""
    html = INDEX.read_text(encoding="utf-8")
    blocks = re.findall(r"<style>(.*?)</style>", html, re.S)
    assert len(blocks) == 1, f"expected exactly one <style> block, found {len(blocks)}"
    return blocks[0]


def strip_comments(css: str) -> str:
    """Remove `/* ... */` the way a CSS tokenizer does: an unterminated comment
    runs to end of input, and a stray terminator is left in place as garbage
    (which is exactly how it then eats the next selector)."""
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def test_style_comments_balance():
    """Every comment opens and closes exactly once.

    Counted rather than parsed, because the two failures this has actually had
    were a count mismatch: 40 open / 41 close in the original, and 42 / 43 when
    the fix reintroduced it. CSS has no nested comments, so a mismatch is
    always a bug -- either a comment that never ends or a terminator loose in
    the stylesheet, and both eat a rule.
    """
    css = style_block()
    opens = css.count("/*")
    closes = css.count("*/")
    assert opens == closes, (
        f"unbalanced CSS comments in index.html: {opens} `/*` against "
        f"{closes} `*/`. A stray terminator ends its comment early and the "
        f"prose after it is parsed as a selector, which swallows the next "
        f"rule whole. If a comment needs to WRITE a terminator to explain "
        f"something, that explanation belongs in CLAUDE.md."
    )


def test_no_comment_terminator_outside_a_comment():
    """The sharper form of the same check, and the one that names the offender.

    Walks the block and reports the line of the first `*/` that is not closing
    an open comment -- the count above says something is wrong, this says
    where.
    """
    css = style_block()
    depth = 0
    line = 1
    i = 0
    while i < len(css):
        if css[i] == "\n":
            line += 1
            i += 1
            continue
        if css.startswith("/*", i):
            depth += 1
            i += 2
            continue
        if css.startswith("*/", i):
            assert depth > 0, (
                f"index.html <style>, line ~{line}: a `*/` that closes nothing. "
                f"Everything after it up to the next `{{` is parsed as a "
                f"selector, so the next rule is dropped."
            )
            depth -= 1
            i += 2
            continue
        i += 1
    assert depth == 0, "index.html <style>: a comment is never closed"


@pytest.mark.parametrize("selector", REQUIRED_SELECTORS)
def test_known_selectors_survive_a_comment_strip(selector):
    """Each selector is still in the stylesheet with the comments removed.

    Balance is not enough on its own: a comment can be perfectly balanced and
    still be positioned so that a rule falls inside it, which no count can see.
    This asks the question the browser asks -- is the selector in the CSS at
    all -- and it is what catches a rule commented out by accident during an
    edit.

    Deliberately a substring test on the stripped text rather than a real CSS
    parse: the failure being guarded against is a rule VANISHING, and a
    dependency-free check that fails loudly for the right reason beats a
    parser this repo would have to vendor.
    """
    css = strip_comments(style_block())
    assert selector in css, (
        f"{selector} is not in index.html's stylesheet once comments are "
        f"stripped. Either the rule was deleted, or a comment ran away and "
        f"swallowed it."
    )
