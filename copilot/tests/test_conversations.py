"""Durable chat-history store: roundtrip, update, delete, index rebuild, caps.

GCS is unconfigured in the test env, so ConversationStore exercises its local
data-dir fallback (which is also the live path on a warm Cloud Run instance)."""

from hawkama_copilot import conversations
from hawkama_copilot.agent import HawkamaAgent
from hawkama_copilot.config import SETTINGS
from hawkama_copilot.conversations import ConversationStore


def _conv(cid, msgs):
    return {"id": cid, "messages": msgs}


def test_save_list_get_roundtrip(tmp_path):
    store = ConversationStore("t1", data_dir=tmp_path)
    s = store.save(_conv("c1", [
        {"sender": "user", "text": "ما هي سياسة التعيين؟"},
        {"sender": "agent", "text": "السياسة كذا [مصدر 1]."},
    ]))
    assert s["id"] == "c1"
    assert s["message_count"] == 2
    assert "التعيين" in s["title"]          # title derived from first user turn
    assert s["preview"]                      # preview = last non-empty turn
    assert [c["id"] for c in store.list()] == ["c1"]
    full = store.get("c1")
    assert full["messages"][0]["text"].startswith("ما")


def test_update_preserves_created_at_and_dedups(tmp_path):
    store = ConversationStore("t2", data_dir=tmp_path)
    store.save(_conv("c", [{"sender": "user", "text": "أول"}]))
    created = store.get("c")["created_at"]
    s2 = store.save(_conv("c", [
        {"sender": "user", "text": "أول"},
        {"sender": "agent", "text": "رد"},
    ]))
    full = store.get("c")
    assert full["created_at"] == created           # creation time is preserved
    assert full["updated_at"] >= created
    assert s2["message_count"] == 2
    assert len(store.list()) == 1                  # same thread, not duplicated


def test_delete_removes_from_index_and_blob(tmp_path):
    store = ConversationStore("t3", data_dir=tmp_path)
    store.save(_conv("a", [{"sender": "user", "text": "x"}]))
    store.save(_conv("b", [{"sender": "user", "text": "y"}]))
    assert len(store.list()) == 2
    store.delete("a")
    assert [c["id"] for c in store.list()] == ["b"]
    assert store.get("a") is None


def test_list_rebuilds_index_when_missing(tmp_path):
    store = ConversationStore("t4", data_dir=tmp_path)
    store.save(_conv("c1", [{"sender": "user", "text": "one"}]))
    store.save(_conv("c2", [{"sender": "user", "text": "two"}]))
    (tmp_path / "conversations" / "t4" / "_index.json").unlink()   # nuke the index
    assert sorted(c["id"] for c in store.list()) == ["c1", "c2"]   # rebuilt from files


def test_new_id_minted_when_absent(tmp_path):
    store = ConversationStore("t5", data_dir=tmp_path)
    s = store.save({"messages": [{"sender": "user", "text": "hi"}]})
    assert s["id"] and s["id"] != "default"
    assert store.get(s["id"]) is not None


def test_message_cap_keeps_newest(tmp_path):
    store = ConversationStore("t6", data_dir=tmp_path)
    n = conversations._MAX_MESSAGES + 50
    s = store.save(_conv("big", [{"sender": "user", "text": f"m{i}"} for i in range(n)]))
    assert s["message_count"] == conversations._MAX_MESSAGES
    assert store.get("big")["messages"][-1]["text"] == f"m{n - 1}"   # newest retained


def test_newest_first_ordering(tmp_path):
    store = ConversationStore("t7", data_dir=tmp_path)
    store.save(_conv("old", [{"sender": "user", "text": "a"}]))
    store.save(_conv("new", [{"sender": "user", "text": "b"}]))
    # most-recently-updated thread leads the list
    assert store.list()[0]["id"] == "new"


# -------------------------- agent history window --------------------------- #
def test_history_window_empty():
    assert HawkamaAgent._history_window(None) == []
    assert HawkamaAgent._history_window([]) == []


def test_history_window_normalizes_roles_and_truncates():
    long_txt = "ن" * (SETTINGS.history_per_msg_chars + 500)
    win = HawkamaAgent._history_window([
        {"role": "user", "content": "س١"},
        {"role": "agent", "content": "ج١"},        # 'agent' must normalize → 'model'
        {"sender": "assistant", "text": long_txt},  # 'assistant' too → 'model'
    ])
    roles = [r for r, _ in win]
    assert roles[0] == "user"
    assert all(r in ("user", "model") for r in roles)   # SDK accepts only these
    assert "agent" not in roles and "assistant" not in roles
    assert any(txt.endswith("…") for _, txt in win)     # oversized turn truncated


def test_history_window_respects_char_budget():
    msgs = [{"role": "user" if i % 2 == 0 else "model", "content": "كلمة " * 100} for i in range(40)]
    win = HawkamaAgent._history_window(msgs)
    assert sum(len(t) for _, t in win) <= SETTINGS.history_max_chars   # budget honored
    assert len(win) < 40                                               # older turns dropped


def test_build_contents_ends_with_evidence_bearing_user_turn(tmp_corpus):
    ag = HawkamaAgent("ctx-test")
    contents = ag._build_contents(
        "ما هي سياسة الإجازات؟", [],
        [{"role": "user", "content": "مرحبا"}, {"role": "agent", "content": "أهلاً"}],
    )
    roles = [c.role for c in contents]
    assert set(roles) <= {"user", "model"}              # no illegal role slips through
    assert roles[-1] == "user"                          # current turn is last
    last = contents[-1].parts[0].text
    assert "سياسة الإجازات" in last and "الأدلة" in last  # question + evidence at the end
