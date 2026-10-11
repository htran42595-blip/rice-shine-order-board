#!/usr/bin/env python3
"""
Rice & Shine live bot: merge dm-orders.json into index.html's ORDERS array.

Run by .github/workflows/sync-dm-orders.yml on every push to dm-orders.json.
Also safe to run locally for testing.

Rules (from the owner's handoff brief):
- Idempotent: orders already on the board (same handle + pickupDate) are skipped.
- Loud: exits non-zero on bad data (total mismatch, missing fields, bad dates).
  A bad batch must fail the workflow visibly, never merge quietly.
- New entries are APPENDED at the end of ORDERS. Never hand-sort; the board's
  render functions sort. Never add a `completed` field (completion state lives
  in localStorage/Firestore keyed by orderIdentity()).
- Comp drinks are their own item lines with `comp: true`; never split lines.
- The footer max DM date (EN + VI) is bumped when new orders extend the range.
  The min date is left alone.
- dm-orders.json is CONSUMED: rewritten to [] after a successful merge, so a
  re-run is a no-op. The commit includes both files atomically.
- Firebase code and everything else in index.html are never touched.
"""

import json
import re
import sys
from datetime import date

ORDERS_JSON = "dm-orders.json"
INDEX_HTML = "index.html"
ARRAY_START = "const ORDERS = ["
ARRAY_END = "\n  ];"
ENTRY_INDENT = "      "
FIELD_INDENT = "        "
ITEM_INDENT = "          "
DEFAULT_PAY_METHOD = "Venmo / Zelle / Apple Pay / cash \u2014 at pickup"

MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fail(msg):
    print(f"MERGE FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def js_str(s):
    """Escape a Python string for a double-quoted JS string literal."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def parse_ymd(s, field):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or ""):
        fail(f"bad {field}: {s!r} (expected YYYY-MM-DD)")
    try:
        return date(*map(int, s.split("-")))
    except ValueError:
        fail(f"bad {field}: {s!r} (not a real date)")


def fmt_num(n):
    return str(int(n)) if float(n) == int(n) else str(n)


def format_item(it):
    if not isinstance(it.get("qty"), int) or it["qty"] <= 0:
        fail(f"bad item qty: {it!r}")
    if not it.get("name") or not isinstance(it["name"], str):
        fail(f"bad item name: {it!r}")
    if not isinstance(it.get("price"), (int, float)) or it["price"] < 0:
        fail(f"bad item price: {it!r}")
    parts = [f'{{ qty: {it["qty"]}, name: "{js_str(it["name"])}", price: {fmt_num(it["price"])}']
    if it.get("comp"):
        parts.append("comp: true")
    if it.get("note"):
        parts.append(f'note: "{js_str(it["note"])}"')
    return ITEM_INDENT + ", ".join(parts) + " }"


def format_entry(o):
    for f in ("name", "handle", "items", "total", "orderDate",
              "pickupDate", "pickupTime"):
        if f not in o or o[f] in (None, ""):
            fail(f"missing required field {f!r} in order {o.get('handle', '?')}")
    if "completed" in o:
        fail(f"order {o['handle']}: 'completed' field is forbidden "
             "(completion state lives outside the array)")
    items = o["items"]
    if not isinstance(items, list) or not items:
        fail(f"order {o['handle']}: items must be a non-empty list")
    item_lines = [format_item(it) for it in items]  # validates each item loudly
    item_sum = sum(float(it["price"]) for it in items)
    if abs(item_sum - float(o["total"])) > 0.005:
        fail(f"order {o['handle']}: total {o['total']} != sum of items {item_sum}")
    parse_ymd(o["orderDate"], "orderDate")
    parse_ymd(o["pickupDate"], "pickupDate")
    if not isinstance(o["pickupTime"], str) or not o["pickupTime"].strip():
        fail(f"order {o['handle']}: bad pickupTime")

    paid = bool(o.get("paid", False))
    pay_method = o.get("payMethod", DEFAULT_PAY_METHOD)
    order_time = o.get("orderTime")
    order_time_js = f'"{js_str(order_time)}"' if order_time else "null"

    lines = [
        ENTRY_INDENT + "{",
        FIELD_INDENT + f'name: "{js_str(o["name"])}", handle: "{js_str(o["handle"])}",',
        FIELD_INDENT + "items: [",
    ]
    lines.extend(item_lines[i] + "," for i in range(len(item_lines)))
    lines[-1] = lines[-1].rstrip(",")
    lines.append(FIELD_INDENT + "],")
    if o.get("special"):
        lines.append(FIELD_INDENT + f'special: "{js_str(o["special"])}",')
    lines += [
        FIELD_INDENT + f'total: {fmt_num(o["total"])},',
        FIELD_INDENT + f'orderDate: "{o["orderDate"]}", orderTime: {order_time_js},',
        FIELD_INDENT + f'pickupDate: "{o["pickupDate"]}", pickupTime: "{js_str(o["pickupTime"])}",',
        FIELD_INDENT + f'paid: {"true" if paid else "false"}, payMethod: "{js_str(pay_method)}",',
        FIELD_INDENT + f'notes: "{js_str(o.get("notes", ""))}"',
        ENTRY_INDENT + "},",
    ]
    return "\n".join(lines)


def existing_identities(array_text):
    """Set of (handle, pickupDate) already in the ORDERS array."""
    ids = set()
    for m in re.finditer(r'handle: "((?:[^"\\]|\\.)*)"', array_text):
        handle = m.group(1)
        tail = array_text[m.end():m.end() + 1200]
        pm = re.search(r'pickupDate: "(\d{4}-\d{2}-\d{2})"', tail)
        if pm:
            ids.add((handle, pm.group(1)))
    return ids


def bump_footers(html, array_text):
    """Bump the footer max DM date (EN + VI) if the array's max orderDate is newer."""
    dates = [parse_ymd(d, "orderDate")
             for d in re.findall(r'orderDate: "(\d{4}-\d{2}-\d{2})"', array_text)]
    if not dates:
        return html, None
    max_d = max(dates)
    new_en = f"{MONTHS_EN[max_d.month - 1]} {max_d.day}, {max_d.year}"
    new_vi = f"{max_d.day}/{max_d.month}/{max_d.year}"

    changed = None
    m = re.search(r"orders received ([A-Z][a-z]{2} \d{1,2})\u2013([A-Z][a-z]{2} \d{1,2}), (\d{4})", html)
    if m:
        cur = date(int(m.group(3)),
                   MONTHS_EN.index(m.group(2).split()[0]) + 1,
                   int(m.group(2).split()[1]))
        if max_d > cur:
            html = html.replace(
                f"orders received {m.group(1)}\u2013{m.group(2)}, {m.group(3)}",
                f"orders received {m.group(1)}\u2013{new_en}")
            changed = str(max_d)

    m = re.search(r"đơn nhận từ (\d{1,2}/\d{1,2})\u2013(\d{1,2})/(\d{1,2})/(\d{4})", html)
    if m:
        cur = date(int(m.group(4)), int(m.group(3)), int(m.group(2)))
        if max_d > cur:
            html = (html.replace(
                f"đơn nhận từ {m.group(1)}\u2013{m.group(2)}/{m.group(3)}/{m.group(4)}",
                f"đơn nhận từ {m.group(1)}\u2013{new_vi}"))
            changed = str(max_d)
    return html, changed


def main():
    try:
        with open(ORDERS_JSON, encoding="utf-8") as f:
            incoming = json.load(f)
    except FileNotFoundError:
        fail(f"{ORDERS_JSON} not found")
    except json.JSONDecodeError as e:
        fail(f"{ORDERS_JSON} is not valid JSON: {e}")
    if not isinstance(incoming, list):
        fail(f"{ORDERS_JSON} must be a JSON array of orders")

    with open(INDEX_HTML, encoding="utf-8") as f:
        html = f.read()

    start = html.find(ARRAY_START)
    if start < 0:
        fail(f"{ARRAY_START!r} not found in {INDEX_HTML}")
    end = html.find(ARRAY_END, start)
    if end < 0:
        fail(f"closing {ARRAY_END!r} not found in {INDEX_HTML}")
    array_text = html[start:end]

    seen = existing_identities(array_text)
    new_entries = []
    skipped = 0
    for o in incoming:
        key = (o.get("handle", ""), o.get("pickupDate", ""))
        if key in seen:
            skipped += 1
            continue
        new_entries.append(format_entry(o))
        seen.add(key)

    if not new_entries:
        print(f"NO_CHANGES: {len(incoming)} order(s) in {ORDERS_JSON}, "
              f"{skipped} already on the board.")
        return

    # Append before the closing "];"[STRING_PLACEHOLDER_1]"}",
    # so add a comma then the new entries separated by blank lines.
    insertion = ",\n\n" + "\n\n".join(new_entries)
    html = html[:end] + insertion + html[end:]

    array_text = html[start:html.find(ARRAY_END, start)]
    html, footer_bump = bump_footers(html, array_text)

    with open(INDEX_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    with open(ORDERS_JSON, "w", encoding="utf-8") as f:
        json.dump([], f)

    print(f"MERGED {len(new_entries)} new order(s) into {INDEX_HTML} "
          f"({skipped} duplicate(s) skipped).")
    if footer_bump:
        print(f"Footer max DM date bumped to {footer_bump}.")


if __name__ == "__main__":
    main()
