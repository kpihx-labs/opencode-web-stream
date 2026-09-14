"""Phonetic encoding module supporting Soundex and Double Metaphone (EN/FR friendly)."""

import re
import unicodedata
from typing import Tuple, List, Set


def normalize_token(token: str) -> str:
    """Normalize token by stripping accents and converting to uppercase alphanumeric."""
    if not token:
        return ""
    token = unicodedata.normalize("NFKD", token)
    token = "".join(c for c in token if not unicodedata.combining(c))
    token = re.sub(r"[^A-Za-z0-9]", "", token)
    return token.upper()


def soundex(word: str) -> str:
    """Compute standard Soundex code (Letter + 3 digits)."""
    norm = normalize_token(word)
    if not norm:
        return ""

    first_char = norm[0]
    tail = norm[1:]

    mapping = {
        "B": "1", "F": "1", "P": "1", "V": "1",
        "C": "2", "G": "2", "J": "2", "K": "2", "Q": "2", "S": "2", "X": "2", "Z": "2",
        "D": "3", "T": "3",
        "L": "4",
        "M": "5", "N": "5",
        "R": "6"
    }

    encoded = []
    last_code = mapping.get(first_char, "")

    for ch in tail:
        code = mapping.get(ch, "")
        if code:
            if code != last_code:
                encoded.append(code)
                last_code = code
        else:
            if ch in "AEIOUY":
                last_code = ""

    code_str = "".join(encoded)
    res = (first_char + code_str + "000")[:4]
    return res


def double_metaphone(word: str) -> Tuple[str, str]:
    """
    Simplified bilingual (English/French/General) Double Metaphone approximation.
    Returns (primary, secondary).
    """
    norm = normalize_token(word)
    if not norm:
        return ("", "")

    # French & English common phonetics replacements
    # Ph -> F, Tch -> CH, X -> KS/S, Qu -> K
    w = norm
    w = re.sub(r"^GN", "N", w)
    w = re.sub(r"^KN", "N", w)
    w = re.sub(r"^PN", "N", w)
    w = re.sub(r"^WR", "R", w)
    w = re.sub(r"^PS", "S", w)

    # Replace dipthongs & blends
    w = w.replace("PH", "F")
    w = w.replace("QU", "K")
    w = w.replace("CK", "K")
    w = w.replace("SCH", "SK")
    w = w.replace("CH", "X")
    w = w.replace("SH", "X")
    w = w.replace("TH", "T")
    w = w.replace("TCH", "X")
    w = w.replace("DZ", "Z")
    w = w.replace("TS", "S")

    primary: List[str] = []
    secondary: List[str] = []
    length = len(w)
    i = 0

    while i < length:
        ch = w[i]
        nxt = w[i + 1] if i + 1 < length else ""

        if ch in "AEIOUY":
            if i == 0:
                primary.append("A")
                secondary.append("A")
            i += 1
            continue

        if ch == "B":
            primary.append("P")
            secondary.append("P")
            if nxt == "B":
                i += 2
            else:
                i += 1
            continue

        if ch == "C":
            if nxt in "EIY":
                primary.append("S")
                secondary.append("S")
            else:
                primary.append("K")
                secondary.append("K")
            i += 2 if nxt == "C" else 1
            continue

        if ch == "D":
            if nxt == "G" and (i + 2 < length and w[i + 2] in "EIY"):
                primary.append("J")
                secondary.append("J")
                i += 2
            else:
                primary.append("T")
                secondary.append("T")
                i += 2 if nxt == "D" else 1
            continue

        if ch == "G":
            if nxt in "EIY":
                primary.append("J")
                secondary.append("K")
            else:
                primary.append("K")
                secondary.append("K")
            i += 2 if nxt == "G" else 1
            continue

        if ch == "J":
            primary.append("J")
            secondary.append("A")
            i += 2 if nxt == "J" else 1
            continue

        if ch == "X":
            primary.append("KS")
            secondary.append("S")
            i += 1
            continue

        if ch in "FKLMNPRSTVWZ":
            primary.append(ch)
            secondary.append(ch)
            if nxt == ch:
                i += 2
            else:
                i += 1
            continue

        i += 1

    prim_str = "".join(primary)[:8]
    sec_str = "".join(secondary)[:8]
    return (prim_str, sec_str or prim_str)


def extract_keywords(path_or_text: str) -> List[str]:
    """Split path/text into alphanumeric tokens."""
    raw = re.split(r"[/\\_.\-\s@#:$~]+", path_or_text)
    res: List[str] = []
    for part in raw:
        # Split CamelCase
        sub = re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z][a-z]|\b)", part)
        if sub:
            for s in sub:
                norm = s.strip().lower()
                if len(norm) >= 2:
                    res.append(norm)
        else:
            norm = part.strip().lower()
            if len(norm) >= 2:
                res.append(norm)
    return res


def get_token_phonetics(token: str) -> Set[str]:
    """Return phonetic signature set for token."""
    keys: Set[str] = set()
    snd = soundex(token)
    if snd:
        keys.add(f"S:{snd}")
    dm1, dm2 = double_metaphone(token)
    if dm1:
        keys.add(f"M1:{dm1}")
    if dm2:
        keys.add(f"M2:{dm2}")
    return keys
