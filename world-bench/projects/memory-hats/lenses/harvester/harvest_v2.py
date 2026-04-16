"""
Harvester v2 — Multi-source normalized event ingestion engine.

Pulls from all WB Slack channels + Spinner sessions.
Emits flat NormalizedEvent[] with unified contract.
Load-bearing constraint: flat events, no cluster wrappers.
Every event carries session_or_thread_id as grouping hint.

Output: projects/memory-hats/lenses/harvester/output/harvest.json
"""

import json
import os
import sys
import hashlib
import time
import shutil
import urllib.request
import urllib.parse
from datetime import datetime, timezone

# Windows UTF-8 safety
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# --- Config ---
BASE_DIR = "D:/OpenClawWorkspace/world-bench/projects/memory-hats/lenses/harvester"
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace")
STRIP_SCRIPT = "D:/OpenClawWorkspace/council/paw-claw/scripts/strip-all-spinner.py"
ENV_FILE = "D:/OpenClawWorkspace/world-bench/orchestrator/config/.env"
INTAKE_DIR = "D:/OpenClawWorkspace/world-bench/intake/spinner"

CHANNELS = [
    ("C0AQ6CZR0HM", "room-orchestrator"),
    ("C0AR9LBGN95", "wb-proj-memory-hats"),
    ("C0ARUMPDYSY", "wb-lens-harvester"),
    ("C0ASARH05T7", "wb-lens-signal-extractor"),
    ("C0ASS7FJ8MS", "wb-lens-hat-renderer"),
    ("C0AQXSW45BK", "wb-orchestrator"),
    ("C0AQ3HR6AFR", "wb-lens-headline-reader"),
    ("C0AQNK3E38U", "wb-lens-joke-writer"),
    ("C0AQXU0MHQR", "wb-proj-headline-jokes"),
]

SPINNER_SESSIONS = [
    "C:/Users/Admin/.claude/projects/D--OpenClawWorkspace-world-bench/39e34fd4-90a8-4129-97ed-b19aeebaa269.jsonl",
]

RATE_LIMIT_DELAY = 0.35  # seconds between Slack API calls

errors = []
ingested_at = datetime.now(timezone.utc).isoformat()


# ============================================================
# Utilities
# ============================================================

def load_token():
    """Load Slack bot token from env or .env file."""
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if token:
        return token
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("SLACK_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def slack_api(method, params=None, token=""):
    """Call Slack Web API with rate-limit handling."""
    url = "https://slack.com/api/" + method
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode())
            time.sleep(RATE_LIMIT_DELAY)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_after = int(e.headers.get("Retry-After", "5"))
                print("    Rate limited, retrying in " + str(retry_after) + "s...", file=sys.stderr)
                time.sleep(retry_after)
                continue
            raise
    return {"ok": False, "error": "max_retries_exceeded"}


def sha256_hex(text):
    """SHA-256 hex digest of a string."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compute_event_hash(source_type, source_id, session_or_thread_id, ts, author, text):
    """Deterministic event identity hash with sorted keys."""
    payload = json.dumps({
        "author": author,
        "session_or_thread_id": session_or_thread_id,
        "source_id": source_id,
        "source_type": source_type,
        "text": text,
        "ts": ts,
    }, sort_keys=True, ensure_ascii=False)
    return sha256_hex(payload)


def ts_to_iso(slack_ts):
    """Convert Slack epoch.seq timestamp to ISO 8601."""
    try:
        epoch = float(slack_ts)
        return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()
    except (ValueError, TypeError):
        return slack_ts or ""


def make_event(event_id, source_type, source_id, session_or_thread_id, ts,
               author, author_display, text, kind, channel=None,
               parent_event_id=None, provenance_ref=None, visibility=None,
               channel_tier=None, artifacts=None):
    """Build a NormalizedEvent dict per the locked contract."""
    return {
        "event_id": event_id,
        "source_type": source_type,
        "source_id": source_id,
        "session_or_thread_id": session_or_thread_id,
        "ts": ts,
        "ingested_at": ingested_at,
        "author": author,
        "author_display": author_display,
        "text": text,
        "kind": kind,
        "channel": channel,
        "classification": None,
        "content_hash": sha256_hex(text) if text else sha256_hex(""),
        "event_hash": compute_event_hash(source_type, source_id, session_or_thread_id, ts, author, text or ""),
        "import_method": "live_harvest",
        "parent_event_id": parent_event_id,
        "provenance_ref": provenance_ref,
        "visibility": visibility,
        "channel_tier": channel_tier,
        "artifacts": artifacts,
    }


# ============================================================
# Slack Harvest
# ============================================================

def harvest_slack(token):
    """Pull all messages from all configured channels. Returns (events, source_counts)."""
    all_events = []
    source_counts = []
    user_ids = set()
    channel_data = {}

    for channel_id, channel_name in CHANNELS:
        print("\n  #" + channel_name + " (" + channel_id + ")")
        top_level = []
        cursor = None
        channel_ok = True

        # Paginate history
        while True:
            params = {"channel": channel_id, "limit": "200"}
            if cursor:
                params["cursor"] = cursor
            data = slack_api("conversations.history", params, token)
            if not data.get("ok"):
                err = "history failed for #" + channel_name + ": " + data.get("error", "unknown")
                errors.append(err)
                print("    ERROR: " + err)
                channel_ok = False
                break
            msgs = data.get("messages", [])
            top_level.extend(msgs)
            if not data.get("has_more"):
                break
            cursor = data.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break

        if not channel_ok:
            source_counts.append({"type": "slack", "id": channel_id, "name": channel_name, "count": 0})
            continue

        # Collect user IDs from top-level
        for msg in top_level:
            uid = msg.get("user")
            if uid:
                user_ids.add(uid)

        # Expand threads
        thread_parents = [m for m in top_level if m.get("reply_count", 0) > 0]
        thread_replies = []

        for parent in thread_parents:
            thread_ts = parent["ts"]
            reply_cursor = None
            while True:
                params = {"channel": channel_id, "ts": thread_ts, "limit": "200"}
                if reply_cursor:
                    params["cursor"] = reply_cursor
                data = slack_api("conversations.replies", params, token)
                if not data.get("ok"):
                    err = "replies failed for thread " + thread_ts + " in #" + channel_name + ": " + str(data.get("error"))
                    errors.append(err)
                    break
                replies = data.get("messages", [])
                for r in replies:
                    if r["ts"] != thread_ts:
                        thread_replies.append(r)
                        uid = r.get("user")
                        if uid:
                            user_ids.add(uid)
                if not data.get("has_more"):
                    break
                reply_cursor = data.get("response_metadata", {}).get("next_cursor")
                if not reply_cursor:
                    break

        print("    " + str(len(top_level)) + " top-level, " + str(len(thread_parents)) + " threads, " + str(len(thread_replies)) + " replies")
        channel_data[channel_id] = {
            "name": channel_name,
            "top_level": top_level,
            "thread_replies": thread_replies,
        }

    # Resolve users (once, across all channels)
    print("\n  Resolving " + str(len(user_ids)) + " users...")
    user_cache = {}
    for uid in user_ids:
        try:
            data = slack_api("users.info", {"user": uid}, token)
            if data.get("ok"):
                u = data["user"]
                profile = u.get("profile", {})
                display = profile.get("display_name") or u.get("real_name") or u.get("name") or "unknown"
                user_cache[uid] = display
            else:
                user_cache[uid] = "unknown"
        except Exception as e:
            errors.append("User resolution failed for " + uid + ": " + str(e))
            user_cache[uid] = "unknown"

    # Convert to NormalizedEvents
    for channel_id, ch in channel_data.items():
        channel_name = ch["name"]
        count = 0

        for msg in ch["top_level"]:
            ev = slack_msg_to_event(msg, channel_id, channel_name, user_cache, False)
            if ev:
                all_events.append(ev)
                count += 1

        for msg in ch["thread_replies"]:
            ev = slack_msg_to_event(msg, channel_id, channel_name, user_cache, True)
            if ev:
                all_events.append(ev)
                count += 1

        source_counts.append({"type": "slack", "id": channel_id, "name": channel_name, "count": count})

    return all_events, source_counts


def slack_msg_to_event(msg, channel_id, channel_name, user_cache, is_reply):
    """Convert a raw Slack message to a NormalizedEvent."""
    ts = msg.get("ts", "")
    text = msg.get("text", "")
    if not text and not msg.get("files"):
        return None

    # Author
    user_id = msg.get("user")
    subtype = msg.get("subtype")
    if user_id and user_id in user_cache:
        author_display = user_cache[user_id]
    elif subtype == "bot_message":
        author_display = msg.get("username") or (msg.get("bot_profile") or {}).get("name") or "unknown-bot"
    else:
        author_display = "unknown"

    author = author_display.lower().replace(" ", "-")

    # Grouping: thread_ts for replies, own ts for top-level
    thread_ts = msg.get("thread_ts")
    if is_reply and thread_ts:
        session_or_thread_id = thread_ts
    else:
        session_or_thread_id = ts

    kind = "thread_reply" if is_reply else "message"
    iso_ts = ts_to_iso(ts)

    return make_event(
        "slack:" + channel_id + ":" + ts,
        "slack",
        channel_id,
        session_or_thread_id,
        iso_ts,
        author,
        author_display,
        text,
        kind,
        channel=channel_name,
    )


# ============================================================
# Spinner Harvest
# ============================================================

def load_strip_functions():
    """Load process_session from strip-all-spinner.py without running main block."""
    with open(STRIP_SCRIPT, "r", encoding="utf-8") as f:
        source = f.read()

    # Truncate before main block to avoid running batch processing
    main_marker = "# --- Main ---"
    idx = source.find(main_marker)
    if idx > 0:
        source = source[:idx]

    ns = {}
    # The exec here loads the function definitions and constants from the
    # council-approved strip script. This is the "subprocess import" approach:
    # we reuse the retention logic without forking it.
    exec(source, ns)  # nosec — trusted council script
    return ns["process_session"]


def harvest_spinner(process_session_fn):
    """Ingest Spinner sessions via paw-claw strip logic. Returns (events, source_counts)."""
    all_events = []
    source_counts = []

    os.makedirs(WORKSPACE_DIR, exist_ok=True)
    os.makedirs(INTAKE_DIR, exist_ok=True)

    for session_path in SPINNER_SESSIONS:
        session_path = session_path.replace("\\", "/")
        session_file = os.path.basename(session_path)
        session_id = os.path.splitext(session_file)[0]
        print("\n  Session: " + session_id[:12] + "...")

        if not os.path.exists(session_path):
            err = "Session not found: " + session_path
            errors.append(err)
            print("    ERROR: " + err)
            source_counts.append({"type": "spinner", "id": session_id, "name": session_file, "count": 0})
            continue

        # Copy to workspace to avoid file-lock issues on live session
        local_copy = os.path.join(WORKSPACE_DIR, "session-" + session_id[:8] + ".jsonl")
        try:
            shutil.copy2(session_path, local_copy)
            file_size = os.path.getsize(local_copy) / 1024 / 1024
            print("    Copied " + str(round(file_size, 1)) + " MB to workspace")
        except (PermissionError, OSError) as e:
            err = "Cannot copy session file (likely locked): " + str(e)
            errors.append(err)
            print("    ERROR: " + err)
            source_counts.append({"type": "spinner", "id": session_id, "name": session_file, "count": 0})
            continue

        # Run strip logic (council-approved v2 retention rules)
        tmp_out = os.path.join(WORKSPACE_DIR, "stripped-" + session_id[:8] + ".jsonl")
        try:
            stats, records = process_session_fn(local_copy, tmp_out)
            reduction = (1 - stats["output_bytes"] / stats["input_bytes"]) * 100 if stats["input_bytes"] > 0 else 0
            print("    Input:  " + str(stats["input_lines"]) + " lines, " + str(round(stats["input_bytes"] / 1024 / 1024, 1)) + " MB")
            print("    Output: " + str(stats["output_lines"]) + " records, " + str(round(stats["output_bytes"] / 1024, 1)) + " KB (" + str(round(reduction)) + "% reduction)")
            print("    Tool summaries: " + str(stats["tool_use_summaries_kept"]) + " kept, " + str(stats["tool_use_dropped"]) + " dropped")
        except Exception as e:
            err = "Strip failed: " + str(e)
            errors.append(err)
            print("    ERROR: " + err)
            source_counts.append({"type": "spinner", "id": session_id, "name": session_file, "count": 0})
            for p in [local_copy, tmp_out]:
                try:
                    os.remove(p)
                except OSError:
                    pass
            continue

        # Normalize stripped records to NormalizedEvents
        count = 0
        for rec in records:
            evts = spinner_record_to_events(rec, session_id)
            all_events.extend(evts)
            count += len(evts)

        source_counts.append({"type": "spinner", "id": session_id, "name": session_file, "count": count})

        # Clean up workspace copies
        for p in [local_copy, tmp_out]:
            try:
                os.remove(p)
            except OSError:
                pass

    return all_events, source_counts


def spinner_record_to_events(rec, session_id):
    """Convert a stripped Spinner record to one or more NormalizedEvents."""
    events = []
    rec_type = rec.get("type", "")
    uuid = rec.get("uuid", "")
    timestamp = rec.get("timestamp", "")

    if not timestamp:
        return events

    if rec_type == "user":
        text = rec.get("content", "")

        # Append tool errors to text if present
        tool_errors = rec.get("tool_errors", [])
        if tool_errors:
            err_lines = []
            for te in tool_errors:
                err_lines.append("[tool_error: " + te.get("tool_use_id", "?") + "] " + te.get("error_preview", ""))
            if text:
                text += "\n\n" + "\n".join(err_lines)
            else:
                text = "\n".join(err_lines)

        if text:
            events.append(make_event(
                "spinner:" + session_id + ":" + uuid,
                "spinner",
                session_id,
                session_id,
                timestamp,
                "pav",
                "Pav",
                text,
                "message",
            ))

    elif rec_type == "assistant":
        content_blocks = rec.get("content", [])

        # Build text from text + thinking blocks
        parts = []
        for block in content_blocks:
            btype = block.get("type", "")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "thinking":
                parts.append("[thinking] " + block.get("text", ""))

        text = "\n\n".join(p for p in parts if p)

        if text:
            events.append(make_event(
                "spinner:" + session_id + ":" + uuid,
                "spinner",
                session_id,
                session_id,
                timestamp,
                "spinner",
                "Spinner",
                text,
                "message",
            ))

        # Emit separate events for tool summaries
        for i, ts_rec in enumerate(rec.get("tool_summaries", [])):
            tool_text = json.dumps(ts_rec, ensure_ascii=False)
            tool_id = ts_rec.get("id", "tool-" + str(i))
            events.append(make_event(
                "spinner:" + session_id + ":" + uuid + ":tool:" + tool_id,
                "spinner",
                session_id,
                session_id,
                timestamp,
                "spinner",
                "Spinner",
                tool_text,
                "tool_call",
                parent_event_id="spinner:" + session_id + ":" + uuid,
            ))

    return events


# ============================================================
# Main
# ============================================================

def main():
    print("=" * 60)
    print("Harvester v2 — Multi-source normalized event ingestion")
    print("=" * 60)

    token = load_token()
    if not token:
        print("CRITICAL: No Slack bot token found", file=sys.stderr)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        with open(os.path.join(OUTPUT_DIR, "escalation.json"), "w", encoding="utf-8") as f:
            json.dump({
                "severity": "critical",
                "message": "No Slack bot token available",
                "context": "Checked SLACK_BOT_TOKEN env var and .env file",
                "requestedAction": "Set SLACK_BOT_TOKEN or verify .env path",
            }, f, indent=2)
        sys.exit(1)

    all_events = []
    all_sources = []

    # --- Slack ---
    print("\n--- Slack Harvest (9 channels) ---")
    slack_events, slack_sources = harvest_slack(token)
    all_events.extend(slack_events)
    all_sources.extend(slack_sources)
    slack_ok = sum(s["count"] for s in slack_sources)
    slack_err = sum(1 for s in slack_sources if s["count"] == 0)
    print("\n  Slack: " + str(slack_ok) + " events from " + str(len(slack_sources)) + " channels (" + str(slack_err) + " failed)")

    # --- Spinner ---
    print("\n--- Spinner Harvest ---")
    try:
        process_session_fn = load_strip_functions()
        spinner_events, spinner_sources = harvest_spinner(process_session_fn)
        all_events.extend(spinner_events)
        all_sources.extend(spinner_sources)
        spinner_ok = sum(s["count"] for s in spinner_sources)
        print("\n  Spinner: " + str(spinner_ok) + " events from " + str(len(spinner_sources)) + " sessions")
    except Exception as e:
        err = "Spinner harvest failed entirely: " + str(e)
        errors.append(err)
        print("  ERROR: " + err)

    # --- Merge, sort, dedup ---
    print("\n--- Merge & Validate ---")
    all_events.sort(key=lambda e: e.get("ts", ""))

    seen_hashes = set()
    deduped = []
    for ev in all_events:
        h = ev["event_hash"]
        if h not in seen_hashes:
            seen_hashes.add(h)
            deduped.append(ev)
    dup_count = len(all_events) - len(deduped)
    if dup_count:
        print("  Removed " + str(dup_count) + " duplicates")
    all_events = deduped

    # Validate required fields
    required = ["event_id", "source_type", "session_or_thread_id", "content_hash", "event_hash"]
    for ev in all_events:
        for field in required:
            if not ev.get(field):
                errors.append("Missing " + field + " on " + ev.get("event_id", "?"))
        if ev.get("classification") is not None:
            errors.append("classification not null on " + str(ev.get("event_id")))

    # --- Write output ---
    output = {
        "events": all_events,
        "metadata": {
            "sources": all_sources,
            "total_events": len(all_events),
            "harvested_at": ingested_at,
            "errors": errors,
        },
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, "harvest.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    size_kb = os.path.getsize(output_path) / 1024
    print("\n  Output: " + output_path)
    print("  Size:   " + str(round(size_kb)) + " KB")
    print("  Events: " + str(len(all_events)))
    print("  Sources: " + str(len(all_sources)))
    print("  Errors: " + str(len(errors)))
    if errors:
        for e in errors[:10]:
            print("    - " + e)
        if len(errors) > 10:
            print("    ... and " + str(len(errors) - 10) + " more")

    print("\nDone.")


if __name__ == "__main__":
    main()
