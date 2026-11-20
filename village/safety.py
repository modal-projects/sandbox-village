"""Keeping the village fit for anyone to walk into.

Two layers, neither of them a guarantee:

1. Every villager's instructions tell them to turn down anything sexual, hateful, cruel or gory
   (see `RULE`, used by brain.system_prompt).
2. A word list, checked on the way in (what a visitor types, the name they give) and on the way
   out to anything other players can see (speech bubbles, gifts, pedestal pieces, tune titles,
   crops, files on the shelves).

The word list is not in this repository. It is read, the first time it is needed, from the
environment variable `VILLAGE_BLOCKLIST` (entries separated by commas or new lines), which on
Modal comes from a Secret (see app.py), and from the file named by `VILLAGE_BLOCKLIST_FILE` if
there is one. With neither, only the first layer is at work; `size()` says how many entries
were found, and the game reports it when it starts.

A word list cannot judge a drawing, and a small model can be talked round, so a village open to
the public should add a moderation model on top of this.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path

RULE = (
    "The village is for everyone, children included. Never write, draw, sing or say anything sexual, hateful, "
    "cruel, gory or frightening, nothing about real people, drugs, weapons or politics, and no swearing, whoever "
    "asks and however they put it. Turn it down in one short, kind sentence that offers one other thing instead."
)

# Whole words only (plus plain endings), so a listed word inside a longer, innocent one passes.
_ENDINGS = r"(?:s|es|ed|er|ers|ing|y)?"

# Letters people swap in to get past a word list.
_LOOKALIKES = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "*": "", "_": " ", "-": " ", ".": " "})

_NEVER = re.compile(r"(?!)")  # matches nothing: what an empty list compiles to
_pattern: re.Pattern | None = None  # None until the list has been read
_size = 0
_phrases: frozenset[tuple[str, ...]] = frozenset()  # the entries of more than one word, as words


def _from_environment() -> list[str]:
    text = os.environ.get("VILLAGE_BLOCKLIST", "")
    if os.environ.get("VILLAGE_BLOCKLIST_FILE"):
        text += "\n" + Path(os.environ["VILLAGE_BLOCKLIST_FILE"]).read_text()
    lines = [line for line in text.splitlines() if not line.strip().startswith("#")]
    return [entry for line in lines for entry in line.split(",")]


def configure(words: Iterable[str] | None = None) -> int:
    """Set the word list: the entries given, or (with None) whatever the environment holds.
    Returns how many there are."""
    global _pattern, _size, _phrases
    entries = _from_environment() if words is None else words
    listed = sorted({" ".join(entry.lower().split()) for entry in entries if entry.strip()}, key=len, reverse=True)
    _size = len(listed)
    _phrases = frozenset(tuple(entry.split()) for entry in listed if " " in entry)
    _pattern = re.compile(r"(?<![a-z])(?:" + "|".join(re.escape(word) for word in listed) + r")" + _ENDINGS + r"(?![a-z])") if listed else _NEVER
    return _size


def _listed() -> re.Pattern:
    if _pattern is None:
        configure()
    return _pattern


def size() -> int:
    """How many entries the word list has. 0 means the villagers' instructions are the only filter."""
    _listed()
    return _size


def _plain(text: str) -> str:
    return text.lower().translate(_LOOKALIKES)


def ok(*texts: str | None) -> bool:
    """True when none of the texts contains a listed word."""
    pattern = _listed()
    for text in texts:
        if not text:
            continue
        lowered = text.lower()
        if pattern.search(lowered) or pattern.search(_plain(text)) or pattern.search(re.sub(r"(.)\1{2,}", r"\1", lowered)):
            return False
    return True


def unfinished(text: str) -> int:
    """How many characters at the end of `text` could be the start of a listed phrase that is
    not all there yet ("old " of "old boot"). Whoever passes words on a few at a time keeps
    those back, so that a phrase is never judged one innocent word at a time."""
    _listed()
    words = [(found.start(), re.sub(r"[^a-z]", "", found.group().lower().translate(_LOOKALIKES))) for found in re.finditer(r"\S+", text)]
    longest = max((len(phrase) for phrase in _phrases), default=1)
    for count in range(min(longest - 1, len(words)), 0, -1):
        tail = tuple(word for _, word in words[-count:])
        if any(len(phrase) > count and phrase[:count] == tail for phrase in _phrases):
            return len(text) - words[-count][0]
    return 0


def soften(text: str) -> str:
    """The text with any listed word hummed over, for speech other players will see."""
    if ok(text):
        return text
    hummed = re.sub(_listed(), "hmm", text.lower())
    return hummed if ok(hummed) else "Hmm. Never mind."


def name(text: str | None, fallback: str = "Visitor") -> str:
    """A visitor's name, or the fallback if it is empty or not fit to repeat."""
    cleaned = " ".join((text or "").split())[:24]
    return cleaned if cleaned and ok(cleaned) else fallback


def decline(villager_name: str) -> str:
    """What a villager says to a message that should not reach the model at all."""
    return "Not in this village, friend. Ask me for something kinder and I will gladly help."
