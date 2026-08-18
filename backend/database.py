"""
SQLite database storage for MyTranscribe history.
"""

from __future__ import annotations
import sqlite3
import json
import os
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone


DB_PATH = os.environ.get("MYTRANSCRIBE_DB_PATH", os.path.join(os.path.dirname(__file__), "transcripts.db"))


def init_db(db_path: str = DB_PATH):
    """Initialize the SQLite database schema."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS transcripts (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            title TEXT NOT NULL,
            raw_text TEXT NOT NULL,
            cleaned_text TEXT NOT NULL,
            removed_count INTEGER DEFAULT 0,
            removed_items TEXT DEFAULT '[]',
            duration_seconds REAL DEFAULT 0.0,
            model_name TEXT DEFAULT 'base',
            language TEXT DEFAULT 'auto',
            is_favorite INTEGER DEFAULT 0
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_transcripts_created_at ON transcripts (created_at DESC)")
    conn.commit()
    conn.close()


def save_transcript(
    item_id: str,
    title: str,
    raw_text: str,
    cleaned_text: str,
    removed_count: int = 0,
    removed_items: Optional[List[Dict[str, Any]]] = None,
    duration_seconds: float = 0.0,
    model_name: str = "base",
    language: str = "auto",
    db_path: str = DB_PATH,
) -> Dict[str, Any]:
    """Save a new transcript to the database."""
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    created_at = datetime.now(timezone.utc).isoformat()
    items_json = json.dumps(removed_items or [])

    cursor.execute(
        """
        INSERT OR REPLACE INTO transcripts (
            id, created_at, title, raw_text, cleaned_text,
            removed_count, removed_items, duration_seconds, model_name, language, is_favorite
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (
            item_id,
            created_at,
            title,
            raw_text,
            cleaned_text,
            removed_count,
            items_json,
            duration_seconds,
            model_name,
            language,
        ),
    )
    conn.commit()
    conn.close()

    return {
        "id": item_id,
        "created_at": created_at,
        "title": title,
        "raw_text": raw_text,
        "cleaned_text": cleaned_text,
        "removed_count": removed_count,
        "removed_items": removed_items or [],
        "duration_seconds": duration_seconds,
        "model_name": model_name,
        "language": language,
        "is_favorite": False,
    }


def list_transcripts(
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    db_path: str = DB_PATH,
) -> List[Dict[str, Any]]:
    """List recent transcripts with optional search filter."""
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if search and search.strip():
        query = "%" + search.strip() + "%"
        cursor.execute(
            """
            SELECT * FROM transcripts
            WHERE cleaned_text LIKE ? OR raw_text LIKE ? OR title LIKE ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (query, query, query, limit, offset),
        )
    else:
        cursor.execute(
            """
            SELECT * FROM transcripts
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )

    rows = cursor.fetchall()
    results = []
    for r in rows:
        results.append({
            "id": r["id"],
            "created_at": r["created_at"],
            "title": r["title"],
            "raw_text": r["raw_text"],
            "cleaned_text": r["cleaned_text"],
            "removed_count": r["removed_count"],
            "removed_items": json.loads(r["removed_items"] or "[]"),
            "duration_seconds": r["duration_seconds"],
            "model_name": r["model_name"],
            "language": r["language"],
            "is_favorite": bool(r["is_favorite"]),
        })

    conn.close()
    return results


def delete_transcript(item_id: str, db_path: str = DB_PATH) -> bool:
    """Delete a transcript by ID."""
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM transcripts WHERE id = ?", (item_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def toggle_favorite(item_id: str, db_path: str = DB_PATH) -> Optional[bool]:
    """Toggle favorite status of a transcript."""
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT is_favorite FROM transcripts WHERE id = ?", (item_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None

    new_val = 0 if row[0] == 1 else 1
    cursor.execute("UPDATE transcripts SET is_favorite = ? WHERE id = ?", (new_val, item_id))
    conn.commit()
    conn.close()
    return bool(new_val)


def clear_all(db_path: str = DB_PATH) -> int:
    """Clear all transcripts from the database."""
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM transcripts")
    count = cursor.rowcount
    conn.commit()
    conn.close()
    return count
