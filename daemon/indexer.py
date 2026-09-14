"""Incremental disk indexer for opencode-web-stream.

Optimized persistent SQLite database (~/.local/share/opencode-web-stream/stream_index.db)
Stores paths, directories, basenames, keywords, phonetic soundex/metaphone keys,
and supports plocate-like fast lookup, FTS5 full-text search, and differential scanning
to detect additions, renames, and deletions.
"""

import os
import sys
import time
import sqlite3
from pathlib import Path
from typing import List, Dict, Set, Tuple, Optional, Any

from phonetics import extract_keywords, get_token_phonetics

DEFAULT_DB_PATH = Path.home() / ".local" / "share" / "opencode-web-stream" / "stream_index.db"

# Ignored directory names to maintain blazing fast scan and compact storage
EXCLUDED_DIR_NAMES = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".pnpm",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".turbo",
    "target",
}


class StreamIndexer:
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = Path(db_path or DEFAULT_DB_PATH).expanduser().resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = self._init_db()

    def _init_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA temp_store = MEMORY;")

        with conn:
            # Files table: track inode/device, mtime, size to detect renames and modifications
            conn.execute("""
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    path TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    parent TEXT NOT NULL,
                    is_dir INTEGER NOT NULL,
                    mtime REAL NOT NULL,
                    size INTEGER NOT NULL,
                    dev INTEGER NOT NULL,
                    ino INTEGER NOT NULL,
                    last_seen REAL NOT NULL
                );
            """)

            conn.execute("CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_files_dev_ino ON files(dev, ino);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent);")

            # FTS5 full text search table on path & keywords
            conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                    path,
                    name,
                    keywords,
                    content='files',
                    content_rowid='id'
                );
            """)

            # Triggers to keep FTS table in sync
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
                    INSERT INTO files_fts(rowid, path, name, keywords)
                    VALUES (new.id, new.path, new.name, new.name);
                END;
            """)
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
                    INSERT INTO files_fts(files_fts, rowid, path, name, keywords)
                    VALUES('delete', old.id, old.path, old.name, old.name);
                END;
            """)
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
                    INSERT INTO files_fts(files_fts, rowid, path, name, keywords)
                    VALUES('delete', old.id, old.path, old.name, old.name);
                    INSERT INTO files_fts(rowid, path, name, keywords)
                    VALUES (new.id, new.path, new.name, new.name);
                END;
            """)

            # Phonetic keys index for fast resolver
            conn.execute("""
                CREATE TABLE IF NOT EXISTS phonetics_index (
                    key TEXT NOT NULL,
                    file_id INTEGER NOT NULL,
                    token TEXT NOT NULL,
                    weight REAL NOT NULL DEFAULT 1.0,
                    PRIMARY KEY (key, file_id, token),
                    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_phonetics_key ON phonetics_index(key);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_phonetics_token ON phonetics_index(token);")

            # Scan metadata table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS scan_meta (
                    root_path TEXT PRIMARY KEY,
                    last_scan REAL NOT NULL,
                    file_count INTEGER NOT NULL
                );
            """)

            # Dynamically learned voice/phonetic aliases table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS learned_aliases (
                    phrase_heard TEXT PRIMARY KEY,
                    canonical_target TEXT NOT NULL,
                    confidence REAL NOT NULL DEFAULT 1.0,
                    updated_at REAL NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_learned_aliases_target ON learned_aliases(canonical_target);")

        return conn

    def close(self):
        if self.conn:
            self.conn.close()

    def _should_exclude(self, dir_name: str) -> bool:
        return dir_name in EXCLUDED_DIR_NAMES

    def scan_root(self, root_path: str | Path) -> Dict[str, int]:
        """
        Incrementally scan directory root.
        Detects:
          - Added files
          - Modified files (mtime change)
          - Renamed files (dev + ino match existing record at different path)
          - Deleted files (missing from scan)
        """
        root = Path(root_path).expanduser().resolve()
        if not root.exists():
            return {"added": 0, "modified": 0, "renamed": 0, "deleted": 0, "total": 0}

        scan_time = time.time()
        added = 0
        modified = 0
        renamed = 0
        deleted = 0
        total_scanned = 0

        # Load existing files for this root prefix into memory for fast lookup
        root_str = str(root)
        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT id, path, mtime, size, dev, ino FROM files WHERE path = ? OR path LIKE ?",
            (root_str, f"{root_str}/%")
        )
        existing_by_path = {}
        existing_by_inode = {}
        for row in cursor.fetchall():
            fid, p, mt, sz, dev, ino = row
            entry = {"id": fid, "path": p, "mtime": mt, "size": sz, "dev": dev, "ino": ino}
            existing_by_path[p] = entry
            existing_by_inode[(dev, ino)] = entry

        seen_paths: Set[str] = set()
        files_to_insert: List[Tuple[Any, ...]] = []
        files_to_update: List[Tuple[Any, ...]] = []
        files_renamed_updates: List[Tuple[Any, ...]] = []

        # Traverse filesystem
        for dirpath, dirnames, filenames in os.walk(str(root), topdown=True, followlinks=False):
            # Prune excluded directories in place
            dirnames[:] = [d for d in dirnames if not self._should_exclude(d)]

            # Check dir itself
            all_entries = [(d, True) for d in dirnames] + [(f, False) for f in filenames]
            for name, is_dir in all_entries:
                full_path = os.path.join(dirpath, name)
                seen_paths.add(full_path)
                total_scanned += 1

                try:
                    st = os.stat(full_path, follow_symlinks=False)
                except (OSError, PermissionError):
                    continue

                mtime = st.st_mtime
                size = st.st_size
                dev = st.st_dev
                ino = st.st_ino
                key_inode = (dev, ino)

                if full_path in existing_by_path:
                    prev = existing_by_path[full_path]
                    if abs(prev["mtime"] - mtime) > 0.001 or prev["size"] != size:
                        files_to_update.append((name, dirpath, int(is_dir), mtime, size, scan_time, prev["id"]))
                        modified += 1
                    else:
                        # Touch last_seen
                        cursor.execute("UPDATE files SET last_seen = ? WHERE id = ?", (scan_time, prev["id"]))
                elif key_inode in existing_by_inode:
                    # Inode match at different path -> RENAMED!
                    prev = existing_by_inode[key_inode]
                    old_path = prev["path"]
                    files_renamed_updates.append((full_path, name, dirpath, int(is_dir), mtime, size, scan_time, prev["id"]))
                    renamed += 1
                    # Update local caches so we don't double process
                    del existing_by_path[old_path]
                    seen_paths.add(old_path)  # Mark old path as handled
                else:
                    # Genuinely new file
                    files_to_insert.append((full_path, name, dirpath, int(is_dir), mtime, size, dev, ino, scan_time))
                    added += 1

        # Commit batch inserts
        with self.conn:
            for item in files_to_insert:
                cursor.execute("""
                    INSERT INTO files (path, name, parent, is_dir, mtime, size, dev, ino, last_seen)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, item)
                new_id = cursor.lastrowid
                self._index_phonetics_for_file(new_id, item[0], item[1])

            for item in files_to_update:
                cursor.execute("""
                    UPDATE files
                    SET name = ?, parent = ?, is_dir = ?, mtime = ?, size = ?, last_seen = ?
                    WHERE id = ?
                """, item)
                fid = item[6]
                cursor.execute("DELETE FROM phonetics_index WHERE file_id = ?", (fid,))
                # fetch path
                cursor.execute("SELECT path FROM files WHERE id = ?", (fid,))
                p_row = cursor.fetchone()
                if p_row:
                    self._index_phonetics_for_file(fid, p_row[0], item[0])

            for item in files_renamed_updates:
                cursor.execute("""
                    UPDATE files
                    SET path = ?, name = ?, parent = ?, is_dir = ?, mtime = ?, size = ?, last_seen = ?
                    WHERE id = ?
                """, item)
                fid = item[7]
                cursor.execute("DELETE FROM phonetics_index WHERE file_id = ?", (fid,))
                self._index_phonetics_for_file(fid, item[0], item[1])

            # Detect deletions: items in existing_by_path not seen in this scan
            missing_ids = [
                entry["id"]
                for p, entry in existing_by_path.items()
                if p not in seen_paths
            ]
            if missing_ids:
                deleted = len(missing_ids)
                # Foreign key cascade cleans phonetics_index
                cursor.executemany("DELETE FROM files WHERE id = ?", [(fid,) for fid in missing_ids])

            # Update scan_meta
            cursor.execute("""
                INSERT INTO scan_meta (root_path, last_scan, file_count)
                VALUES (?, ?, ?)
                ON CONFLICT(root_path) DO UPDATE SET
                    last_scan = excluded.last_scan,
                    file_count = excluded.file_count
            """, (root_str, scan_time, total_scanned))

        return {
            "added": added,
            "modified": modified,
            "renamed": renamed,
            "deleted": deleted,
            "total": total_scanned,
        }

    def _index_phonetics_for_file(self, file_id: int, path: str, name: str):
        """Index phonetic tokens for given file."""
        tokens = extract_keywords(f"{name} {path}")
        seen_keys: Set[Tuple[str, str]] = set()

        for token in tokens:
            weight = 2.0 if token in name.lower() else 1.0
            phonetic_keys = get_token_phonetics(token)
            for key in phonetic_keys:
                pair = (key, token)
                if pair not in seen_keys:
                    seen_keys.add(pair)
                    self.conn.execute("""
                        INSERT OR IGNORE INTO phonetics_index (key, file_id, token, weight)
                        VALUES (?, ?, ?, ?)
                    """, (key, file_id, token, weight))

    def index_standard_roots(self) -> Dict[str, Any]:
        """Index ~/KpihX-Labs and ~/.agents."""
        results = {}
        roots = [
            Path.home() / "KpihX-Labs",
            Path.home() / ".agents",
        ]
        for r in roots:
            if r.exists():
                results[str(r)] = self.scan_root(r)
        return results

    def learn_alias(self, phrase_heard: str, canonical_target: str, confidence: float = 1.0) -> bool:
        """Dynamically learn or update a phonetic/voice alias in SQLite."""
        cleaned_heard = phrase_heard.strip().lower()
        cleaned_target = canonical_target.strip()
        if not cleaned_heard or not cleaned_target:
            return False

        now = time.time()
        with self.conn:
            self.conn.execute("""
                INSERT INTO learned_aliases (phrase_heard, canonical_target, confidence, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(phrase_heard) DO UPDATE SET
                    canonical_target = excluded.canonical_target,
                    confidence = excluded.confidence,
                    updated_at = excluded.updated_at
            """, (cleaned_heard, cleaned_target, float(confidence), now))
        return True

    def get_learned_aliases(self) -> Dict[str, Tuple[str, float]]:
        """Retrieve all learned aliases as {phrase_heard: (canonical_target, confidence)}."""
        cursor = self.conn.cursor()
        try:
            cursor.execute("SELECT phrase_heard, canonical_target, confidence FROM learned_aliases")
            rows = cursor.fetchall()
            return {r[0]: (r[1], float(r[2])) for r in rows}
        except sqlite3.OperationalError:
            return {}

    def fast_plocate(self, pattern: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Instant query like plocate using LIKE or FTS5."""
        cursor = self.conn.cursor()
        clean = pattern.strip()
        if not clean:
            return []

        # Try FTS5 first
        fts_query = " ".join([f'"{t}"*' for t in clean.split() if len(t) >= 2])
        if fts_query:
            try:
                cursor.execute("""
                    SELECT f.id, f.path, f.name, f.is_dir, f.mtime, f.size
                    FROM files_fts s
                    JOIN files f ON s.rowid = f.id
                    WHERE files_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                """, (fts_query, limit))
                rows = cursor.fetchall()
                if rows:
                    return [
                        {"id": r[0], "path": r[1], "name": r[2], "is_dir": bool(r[3]), "mtime": r[4], "size": r[5]}
                        for r in rows
                    ]
            except sqlite3.OperationalError:
                pass

        # Fallback to fast indexed LIKE search
        like_pat = f"%{clean}%"
        cursor.execute("""
            SELECT id, path, name, is_dir, mtime, size
            FROM files
            WHERE path LIKE ? OR name LIKE ?
            ORDER BY length(path) ASC
            LIMIT ?
        """, (like_pat, like_pat, limit))
        rows = cursor.fetchall()
        return [
            {"id": r[0], "path": r[1], "name": r[2], "is_dir": bool(r[3]), "mtime": r[4], "size": r[5]}
            for r in rows
        ]
