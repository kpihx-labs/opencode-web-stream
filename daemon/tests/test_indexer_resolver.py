import os
import tempfile
import sqlite3
import pytest
from pathlib import Path

from phonetics import soundex, double_metaphone, extract_keywords, get_token_phonetics
from indexer import StreamIndexer
from resolver import PhoneticResolver, levenshtein_ratio


def test_phonetics_basic():
    # Soundex
    assert soundex("Robert") == "R163"
    assert soundex("Rupert") == "R163"
    assert soundex("desk") == soundex("desque")

    # Double Metaphone
    p1, p2 = double_metaphone("proxy")
    assert "PRKS" in p1 or "PRK" in p1

    tokens = extract_keywords("kpihx-ubuntu/skills/k-opencode")
    assert "kpihx" in tokens
    assert "ubuntu" in tokens
    assert "skills" in tokens
    assert "opencode" in tokens


def test_levenshtein_ratio():
    assert levenshtein_ratio("desk-proxy", "desk-proxy") == 1.0
    assert levenshtein_ratio("desk-proxy", "dex-proxy") >= 0.8
    assert levenshtein_ratio("test", "") == 0.0


def test_indexer_lifecycle_and_renames():
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        db_file = tmp_path / "test_stream_index.db"
        indexer = StreamIndexer(db_file)

        # Create mock directory structure
        project_dir = tmp_path / "KpihX-Labs" / "my-project"
        project_dir.mkdir(parents=True)
        file1 = project_dir / "service.py"
        file1.write_text("print('hello world')")

        # 1. Initial Scan
        stats1 = indexer.scan_root(tmp_path / "KpihX-Labs")
        assert stats1["added"] >= 2  # my-project dir + service.py
        assert stats1["deleted"] == 0

        # Fast plocate query
        results = indexer.fast_plocate("service.py")
        assert len(results) >= 1
        assert results[0]["name"] == "service.py"

        # 2. Modification
        file1.write_text("print('updated content')")
        # Ensure mtime updates
        os.utime(file1, (file1.stat().st_atime, file1.stat().st_mtime + 5))
        stats2 = indexer.scan_root(tmp_path / "KpihX-Labs")
        assert stats2["modified"] == 1
        assert stats2["added"] == 0

        # 3. Rename
        renamed_file = project_dir / "service_renamed.py"
        file1.rename(renamed_file)
        stats3 = indexer.scan_root(tmp_path / "KpihX-Labs")
        assert stats3["renamed"] == 1
        assert stats3["deleted"] == 0

        res_renamed = indexer.fast_plocate("service_renamed.py")
        assert len(res_renamed) == 1
        assert res_renamed[0]["name"] == "service_renamed.py"

        # 4. Deletion
        renamed_file.unlink()
        stats4 = indexer.scan_root(tmp_path / "KpihX-Labs")
        assert stats4["deleted"] == 1

        res_deleted = indexer.fast_plocate("service_renamed.py")
        assert len(res_deleted) == 0

        indexer.close()


def test_dynamic_learning_and_certainty_resolver():
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        db_file = tmp_path / "test_stream_index.db"
        indexer = StreamIndexer(db_file)

        # 1. Index sample files on disk
        sample_dir = tmp_path / "workspace" / "project-alpha"
        sample_dir.mkdir(parents=True)
        target = sample_dir / "module.py"
        target.write_text("# module alpha")

        indexer.scan_root(tmp_path / "workspace")

        resolver = PhoneticResolver(db_file)

        # 2. Test unknown term triggering needs_clarification
        res_unknown = resolver.resolve_with_certainty("active foobarpseudotarget")
        assert res_unknown["needs_clarification"] is True
        assert "foobarpseudotarget" in res_unknown["unknown_terms"]
        assert res_unknown["confidence"] < 0.85

        # 3. Test dynamic alias learning without code change
        success = indexer.learn_alias("foobarpseudotarget", "project-alpha", confidence=1.0)
        assert success is True

        learned = indexer.get_learned_aliases()
        assert "foobarpseudotarget" in learned
        assert learned["foobarpseudotarget"][0] == "project-alpha"

        # 4. Test resolution after learning
        res_after = resolver.resolve_with_certainty("active foobarpseudotarget")
        assert res_after["needs_clarification"] is False
        assert "project-alpha" in res_after["resolved"]
        assert res_after["confidence"] >= 0.85

        # 5. Verify zero hardcoded replacements exist in resolver
        assert not hasattr(resolver, "CANONICAL_REPLACEMENTS")

        indexer.close()
        resolver.close()
