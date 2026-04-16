"""
Harvester Lens — Production Script
Pulls all messages from a Slack channel, expands threads, resolves users,
outputs structured JSON per the output contract.
"""

import json
import os
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timezone

# --- Config ---
CHANNEL_ID = "C0AQ6CZR0HM"  # #room-orchestrator
CHANNEL_NAME = "room-orchestrator"
OUTPUT_DIR = "D:/OpenClawWorkspace/world-bench/projects/memory-hats/lenses/harvester/output"
TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")

if not TOKEN:
    print("ERROR: SLACK_BOT_TOKEN not set", file=sys.stderr)
    sys.exit(1)

errors = []

def slack_api(method, params=None):
    """Call Slack API, return parsed JSON."""
    url = f"https://slack.com/api/{method}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

# --- Step 1: Paginate channel history ---
print("Step 1: Pulling channel history...")
all_top_level = []
cursor = None
page = 0
while True:
    params = {"channel": CHANNEL_ID, "limit": "200"}
    if cursor:
        params["cursor"] = cursor
    data = slack_api("conversations.history", params)
    if not data.get("ok"):
        err = f"conversations.history failed: {data.get('error', 'unknown')}"
        errors.append(err)
        print(f"  ERROR: {err}", file=sys.stderr)
        break
    msgs = data.get("messages", [])
    all_top_level.extend(msgs)
    page += 1
    print(f"  Page {page}: {len(msgs)} messages")
    if not data.get("has_more"):
        break
    cursor = data.get("response_metadata", {}).get("next_cursor")
    if not cursor:
        break

print(f"  Total top-level messages: {len(all_top_level)}")

# --- Step 2: Collect unique user IDs ---
print("Step 2: Collecting user IDs...")
user_ids = set()
for msg in all_top_level:
    uid = msg.get("user")
    if uid:
        user_ids.add(uid)

# --- Step 3: Identify thread parents and expand threads ---
print("Step 3: Expanding threads...")
thread_parents = [m for m in all_top_level if m.get("reply_count", 0) > 0]
print(f"  Thread parents found: {len(thread_parents)}")

thread_replies = []  # replies only (parent excluded)
for i, parent in enumerate(thread_parents):
    thread_ts = parent["ts"]
    try:
        reply_cursor = None
        while True:
            params = {"channel": CHANNEL_ID, "ts": thread_ts, "limit": "200"}
            if reply_cursor:
                params["cursor"] = reply_cursor
            data = slack_api("conversations.replies", params)
            if not data.get("ok"):
                err = f"conversations.replies failed for thread {thread_ts}: {data.get('error')}"
                errors.append(err)
                print(f"  ERROR: {err}", file=sys.stderr)
                break
            replies = data.get("messages", [])
            # Skip the parent (first message where ts == thread_ts)
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
    except Exception as e:
        err = f"Thread expansion failed for {thread_ts}: {str(e)}"
        errors.append(err)
        print(f"  ERROR: {err}", file=sys.stderr)

    if (i + 1) % 5 == 0:
        print(f"  Expanded {i+1}/{len(thread_parents)} threads...")

print(f"  Total thread replies: {len(thread_replies)}")

# --- Step 4: Resolve users ---
print(f"Step 4: Resolving {len(user_ids)} users...")
user_cache = {}
for uid in user_ids:
    try:
        data = slack_api("users.info", {"user": uid})
        if data.get("ok"):
            u = data["user"]
            profile = u.get("profile", {})
            display = profile.get("display_name") or u.get("real_name") or u.get("name") or "unknown"
            user_cache[uid] = {
                "username": display,
                "is_bot": u.get("is_bot", False)
            }
        else:
            errors.append(f"users.info failed for {uid}: {data.get('error')}")
            user_cache[uid] = {"username": "unknown", "is_bot": False}
    except Exception as e:
        errors.append(f"User resolution failed for {uid}: {str(e)}")
        user_cache[uid] = {"username": "unknown", "is_bot": False}

print(f"  Resolved: {json.dumps({k: v['username'] for k, v in user_cache.items()}, indent=2)}")

# --- Step 5: Merge and build output ---
print("Step 5: Building output...")

def to_harvested(msg, is_reply=False):
    """Convert raw Slack message to HarvestedMessage shape."""
    ts = msg.get("ts", "")
    thread_ts_val = msg.get("thread_ts")

    # Determine if this is a thread parent
    is_thread_parent = msg.get("reply_count", 0) > 0

    # For replies, thread_ts points to parent. For parents, thread_ts == ts (set to null per contract).
    # For non-threaded messages, thread_ts is null.
    if is_reply:
        output_thread_ts = thread_ts_val
    elif is_thread_parent:
        output_thread_ts = None  # parent itself — null per contract
    else:
        output_thread_ts = None

    # Resolve user
    user_id = msg.get("user")
    bot_id = msg.get("bot_id")
    subtype = msg.get("subtype")

    if user_id and user_id in user_cache:
        username = user_cache[user_id]["username"]
    elif subtype == "bot_message":
        # Persona post — use username field or bot_profile.name
        username = msg.get("username") or (msg.get("bot_profile", {}) or {}).get("name") or "unknown-bot"
    else:
        username = "unknown"

    # Reactions
    reactions = []
    for r in msg.get("reactions", []):
        reactions.append({
            "name": r.get("name", ""),
            "count": r.get("count", 0),
            "users": r.get("users", [])
        })

    return {
        "ts": ts,
        "thread_ts": output_thread_ts,
        "user_id": user_id or None,
        "username": username,
        "text": msg.get("text", ""),
        "is_thread_parent": is_thread_parent,
        "reply_count": msg.get("reply_count", 0),
        "reactions": reactions,
        "bot_id": bot_id or None,
        "subtype": subtype or None
    }

# Build flat array
all_messages = []
for msg in all_top_level:
    all_messages.append(to_harvested(msg, is_reply=False))
for msg in thread_replies:
    all_messages.append(to_harvested(msg, is_reply=True))

# Sort oldest-first by ts
all_messages.sort(key=lambda m: m["ts"])

# Deduplicate by ts (in case a thread reply is also in top-level, which shouldn't happen but be safe)
seen_ts = set()
deduped = []
for m in all_messages:
    if m["ts"] not in seen_ts:
        seen_ts.add(m["ts"])
        deduped.append(m)
all_messages = deduped

print(f"  Total messages (deduped, sorted): {len(all_messages)}")

# --- Step 6: Build metadata ---
thread_count = len([m for m in all_messages if m["is_thread_parent"]])
oldest_ts = all_messages[0]["ts"] if all_messages else ""
latest_ts = all_messages[-1]["ts"] if all_messages else ""

output = {
    "messages": all_messages,
    "metadata": {
        "channel_id": CHANNEL_ID,
        "channel_name": CHANNEL_NAME,
        "message_count": len(all_messages),
        "thread_count": thread_count,
        "harvested_at": datetime.now(timezone.utc).isoformat(),
        "oldest_message_ts": oldest_ts,
        "latest_message_ts": latest_ts,
        "errors": errors
    }
}

# --- Step 7: Write output ---
output_path = os.path.join(OUTPUT_DIR, "harvest.json")
os.makedirs(OUTPUT_DIR, exist_ok=True)
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

print(f"\nDone! Output written to {output_path}")
print(f"  Messages: {output['metadata']['message_count']}")
print(f"  Threads: {output['metadata']['thread_count']}")
print(f"  Errors: {len(errors)}")
if errors:
    for e in errors:
        print(f"    - {e}")
