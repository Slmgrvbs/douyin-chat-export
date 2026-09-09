"""Resolve Douyin merged records from preserved inline bodies and local messages.

13600 has two observed formats: msg_ids/list_content (summary only), and
is_new_mr_share + inline_content (full MessageBody objects). Parse in Python
so 64-bit message/user IDs never pass through JavaScript floating point.
"""
import json


def as_object(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return {}
    return value if isinstance(value, dict) else {}


def content_json(message):
    raw = as_object(message.get("raw_data"))
    return as_object(raw.get("content_json")) or as_object(message.get("content"))


def _array(value):
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def _inline_row(body, descriptor, preview, parent_id):
    cj = as_object(body.get("content"))
    if not cj:
        raise ValueError("合并记录正文缺失或损坏")
    awe = str(cj.get("aweType", ""))
    msg_type = 1
    content = cj.get("text") or cj.get("content_title") or ""
    media_url = None
    if awe in {"500", "501", "507", "508", "510", "514", "516"}:
        msg_type, content = 2, cj.get("display_name") or "[表情]"
        urls = as_object(cj.get("url")).get("url_list")
        media_url = urls[0] if isinstance(urls, list) and urls else None
    elif awe in {"2702", "2703", "2704"}:
        msg_type, content = 3, "[图片]"
    elif as_object(cj.get("video")).get("vid"):
        msg_type, content = 5, "[视频]"
    elif awe in {"800", "801", "803", "805", "10500", "11029"}:
        msg_type, content = 4, content or "[分享]"
    elif cj.get("tips") or cj.get("resource_url"):
        msg_type = 0
    # Preserving the entire content_json also handles cards/nested records that
    # a previous scraper classified as plain text or other.
    content = content or preview.get("text") or "[消息]"
    sid = str(body.get("server_message_id") or descriptor.get("msg_id") or "")
    timestamp = body.get("create_time") or descriptor.get("create_time") or 0
    timestamp = int(timestamp)
    if timestamp > 10**14:
        timestamp //= 1_000_000
    elif timestamp > 10**11:
        timestamp //= 1000
    return {
        "msg_id": f"{parent_id}/srv_{sid}", "conv_id": str(body.get("conversation_id") or ""),
        "sender_uid": str(body.get("sender") or descriptor.get("uid") or ""),
        "sender_name": preview.get("nick_name") or "", "timestamp": timestamp,
        "content": content, "msg_type": msg_type, "media_url": media_url,
        "media_local_path": None,
        "raw_data": json.dumps({"content_json": body.get("content")}, ensure_ascii=False),
    }


def resolve_forward(message, conn, *, ancestors=(), budget=None):
    cj = content_json(message)
    if str(cj.get("aweType")) != "13600":
        return None
    budget = budget if budget is not None else [1000]
    descriptors = _array(cj.get("msg_ids"))
    downloaded = _array(as_object(message.get("raw_data")).get("forwarded_bodies"))
    inline = {str(b.get("server_message_id")): b
              for b in [*downloaded, *_array(cj.get("inline_content"))]}
    previews = {str(b.get("msgid")): b for b in _array(cj.get("list_content"))}
    ids = [str(d.get("msg_id")) for d in descriptors] or list(inline) or list(previews)
    descriptor_map = {str(d.get("msg_id")): d for d in descriptors}
    # Preview nicknames identify senders, not just the first three rows.
    sender_names = {}
    for sid, preview in previews.items():
        uid = str(inline.get(sid, {}).get("sender") or descriptor_map.get(sid, {}).get("uid") or "")
        if uid and preview.get("nick_name"):
            sender_names[uid] = preview["nick_name"]
    result = {"title": cj.get("title") or "聊天记录", "items": [], "total": len(ids),
              "available": 0, "missing": len(ids), "complete": False}
    if len(ancestors) >= 5 or budget[0] <= 0:
        return result
    for sid in ids:
        if budget[0] <= 0:
            break
        budget[0] -= 1
        preview = previews.get(sid, {})
        # Prefer locally archived originals (including downloaded media).
        local = conn.execute("SELECT * FROM messages WHERE msg_id = ?", (f"srv_{sid}",)).fetchone()
        row = dict(local) if local else None
        if row is None and sid in inline:
            try:
                row = _inline_row(inline[sid], descriptor_map.get(sid, {}), preview, message["msg_id"])
            except (ValueError, TypeError, IndexError):
                row = None
        if row is None:
            row = {"msg_id": f"{message['msg_id']}/missing_{sid}", "msg_type": 1,
                   "sender_name": preview.get("nick_name") or "", "sender_uid": str(descriptor_map.get(sid, {}).get("uid") or ""),
                   "content": preview.get("text") or "[消息详情未采集]", "timestamp": 0,
                   "detail_missing": True}
        else:
            result["available"] += 1
            user = conn.execute("SELECT nickname FROM users WHERE uid = ?", (row.get("sender_uid", ""),)).fetchone()
            if user and user[0]:
                row["sender_name"] = user[0]
            if sid not in ancestors:
                nested = resolve_forward(row, conn, ancestors=(*ancestors, sid), budget=budget)
            else:
                nested = {"title": "聊天记录", "items": [], "total": 0, "available": 0,
                          "missing": 0, "complete": False}
            if nested is not None:
                row["forward_detail"] = nested
        result["items"].append(row)
    for row in result["items"]:
        if not row.get("sender_name"):
            row["sender_name"] = sender_names.get(row.get("sender_uid"), "")
    result["missing"] = result["total"] - result["available"]
    result["complete"] = bool(ids) and result["missing"] == 0
    return result
