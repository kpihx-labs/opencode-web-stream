"""Dynamic, phonetic & database-driven resolver for opencode-web-stream.

Agnostic architecture:
  - 100% agnostic and zero hardcoding: No static mappings or project names in source code.
  - Dynamically queries `learned_aliases` from SQLite.
  - Resolves phonetic candidates against indexed tokens/files in SQLite.
  - Strict certainty gate (threshold >= 0.85):
    * If technical/specific terms are present and unindexed with < 0.85 confidence,
      flags `needs_clarification: True` to trigger vocal validation.
"""

import math
import sqlite3
from pathlib import Path
from typing import List, Dict, Tuple, Optional, Any, Set

from phonetics import extract_keywords, get_token_phonetics, normalize_token

DEFAULT_DB_PATH = Path.home() / ".local" / "share" / "opencode-web-stream" / "stream_index.db"
CONFIDENCE_THRESHOLD = 0.85


def levenshtein_ratio(s1: str, s2: str) -> float:
    """Compute similarity ratio [0.0 - 1.0] between two strings."""
    s1, s2 = s1.lower(), s2.lower()
    if s1 == s2:
        return 1.0
    len1, len2 = len(s1), len(s2)
    if len1 == 0 or len2 == 0:
        return 0.0

    dp = [[0] * (len2 + 1) for _ in range(len1 + 1)]
    for i in range(len1 + 1):
        dp[i][0] = i
    for j in range(len2 + 1):
        dp[0][j] = j

    for i in range(1, len1 + 1):
        for j in range(1, len2 + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,        # deletion
                dp[i][j - 1] + 1,        # insertion
                dp[i - 1][j - 1] + cost  # substitution
            )

    dist = dp[len1][len2]
    max_len = max(len1, len2)
    return 1.0 - (dist / max_len)


class PhoneticResolver:
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = Path(db_path or DEFAULT_DB_PATH).expanduser().resolve()
        self.conn: Optional[sqlite3.Connection] = None
        if self.db_path.exists():
            self.conn = sqlite3.connect(str(self.db_path))

    def _ensure_conn(self) -> Optional[sqlite3.Connection]:
        if not self.conn and self.db_path.exists():
            self.conn = sqlite3.connect(str(self.db_path))
        return self.conn

    def close(self):
        if self.conn:
            self.conn.close()
            self.conn = None

    def get_learned_aliases(self) -> Dict[str, Tuple[str, float]]:
        """Fetch all dynamically learned aliases from DB."""
        conn = self._ensure_conn()
        if not conn:
            return {}
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT phrase_heard, canonical_target, confidence FROM learned_aliases")
            rows = cursor.fetchall()
            return {r[0].lower(): (r[1], float(r[2])) for r in rows}
        except sqlite3.OperationalError:
            return {}

    def resolve_phrase(self, text: str) -> str:
        """
        Fast dynamic resolution pass:
        Replaces any learned alias dynamically stored in SQLite.
        Zero hardcoded replacements.
        """
        lower = text.strip().lower()
        learned = self.get_learned_aliases()
        # Sort learned phrases by descending length so multi-word replacements take precedence
        for heard in sorted(learned.keys(), key=len, reverse=True):
            if heard in lower:
                target, _ = learned[heard]
                lower = lower.replace(heard, target)
        return lower

    def find_matching_entities(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """
        Query disk index (files, phonetics_index) using phonetic and string similarity.
        """
        conn = self._ensure_conn()
        if not conn:
            return []

        resolved_query = self.resolve_phrase(query)
        tokens = extract_keywords(resolved_query)
        if not tokens:
            return []

        # Collect phonetic keys for query tokens
        query_keys: Set[str] = set()
        for tok in tokens:
            query_keys.update(get_token_phonetics(tok))

        if not query_keys:
            return []

        cursor = conn.cursor()
        placeholders = ",".join("?" * len(query_keys))
        sql = f"""
            SELECT p.file_id, f.path, f.name, f.is_dir, SUM(p.weight) as match_score, p.token
            FROM phonetics_index p
            JOIN files f ON p.file_id = f.id
            WHERE p.key IN ({placeholders})
            GROUP BY p.file_id
            ORDER BY match_score DESC
            LIMIT 50
        """

        try:
            cursor.execute(sql, list(query_keys))
            rows = cursor.fetchall()
        except sqlite3.OperationalError:
            return []

        scored_results: List[Dict[str, Any]] = []
        for fid, path, name, is_dir, base_score, token in rows:
            name_sim = max(levenshtein_ratio(tok, name) for tok in tokens)
            full_sim = levenshtein_ratio(resolved_query, name)
            total_score = base_score * (1.0 + 2.0 * name_sim + full_sim)
            # Normalize confidence between 0.0 and 1.0
            computed_conf = min(1.0, round(max(name_sim, full_sim, total_score / (len(tokens) * 4.0)), 2))

            scored_results.append({
                "id": fid,
                "path": path,
                "name": name,
                "is_dir": bool(is_dir),
                "score": round(total_score, 3),
                "confidence": computed_conf,
            })

        scored_results.sort(key=lambda x: (x["confidence"], x["score"]), reverse=True)
        return scored_results[:limit]

    def resolve_with_certainty(self, text: str) -> Dict[str, Any]:
        """
        Dynamic certainty gate:
        1. Applies learned aliases from DB.
        2. Extracts keywords and checks confidence against SQLite DB (learned_aliases and files index).
        3. If any significant token or entity lacks a match with confidence >= 0.85,
           returns needs_clarification: True with unknown_terms and candidates.
        """
        raw_clean = text.strip()
        resolved_text = self.resolve_phrase(raw_clean)
        candidates = self.find_matching_entities(raw_clean, limit=5)

        tokens = extract_keywords(raw_clean)
        learned = self.get_learned_aliases()

        # If empty query
        if not tokens:
            return {
                "query": raw_clean,
                "resolved": resolved_text,
                "needs_clarification": False,
                "unknown_terms": [],
                "confidence": 1.0,
                "candidates": candidates,
            }

        # Check if entire query or substantial phrases match learned aliases directly
        query_lower = raw_clean.lower()
        if any(heard in query_lower for heard in learned):
            # Known learned phrase present
            return {
                "query": raw_clean,
                "resolved": resolved_text,
                "needs_clarification": False,
                "unknown_terms": [],
                "confidence": 1.0,
                "candidates": candidates,
            }

        # Check candidates confidence
        top_conf = candidates[0]["confidence"] if candidates else 0.0

        # Look for unknown or low-confidence terms
        unknown_terms: List[str] = []
        conn = self._ensure_conn()

        for tok in tokens:
            # Skip very common short French/English prepositions/stop words
            if len(tok) <= 2:
                continue

            # Check in learned aliases
            if tok in learned or any(tok in heard for heard in learned):
                continue

            # Check direct exact match in files or tokens
            tok_found = False
            if conn:
                try:
                    c = conn.cursor()
                    c.execute("SELECT 1 FROM files WHERE name LIKE ? LIMIT 1", (f"%{tok}%",))
                    if c.fetchone():
                        tok_found = True
                    else:
                        c.execute("SELECT 1 FROM phonetics_index WHERE token = ? LIMIT 1", (tok,))
                        if c.fetchone():
                            tok_found = True
                except sqlite3.OperationalError:
                    pass

            if not tok_found:
                # If top candidate has confidence >= CONFIDENCE_THRESHOLD for this token, count as known
                match_found = any(c["confidence"] >= CONFIDENCE_THRESHOLD and tok in c["name"].lower() for c in candidates)
                if not match_found:
                    unknown_terms.append(tok)

        needs_clarification = False
        final_confidence = top_conf

        # Strict certainty gate: if there are specific unknown terms and no candidate with >= 0.85
        if unknown_terms:
            if top_conf < CONFIDENCE_THRESHOLD:
                needs_clarification = True
                final_confidence = top_conf
            else:
                final_confidence = top_conf
        else:
            final_confidence = max(top_conf, 1.0 if not tokens else 0.9)

        return {
            "query": raw_clean,
            "resolved": resolved_text,
            "needs_clarification": needs_clarification,
            "unknown_terms": unknown_terms,
            "confidence": round(final_confidence, 2),
            "candidates": candidates,
        }
