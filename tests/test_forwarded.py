import json
from backend import database
from backend.forwarded import resolve_forward
from tests.conftest import insert_conversation, insert_message


def forward(cj):
    return {'msg_id': 'srv_parent', 'raw_data': json.dumps({'content_json': json.dumps({'aweType': 13600, **cj})})}


def test_inline_beyond_three_and_precision(temp_db):
    conn = database.get_db()
    ids = [7600000000000000001 + i for i in range(5)]
    message = forward({'msg_ids': [{'msg_id': i} for i in ids],
                       'list_content': [{'msgid': i, 'text': '摘要'} for i in ids[:3]],
                       'inline_content': [{'server_message_id': i, 'sender': 7100000000000000001,
                                           'create_time': 1700000000000000,
                                           'content': json.dumps({'aweType': 700, 'text': f'正文{i}'})} for i in ids]})
    result = resolve_forward(message, conn)
    assert result['complete'] and result['available'] == result['total'] == 5
    assert result['items'][-1]['content'] == f'正文{ids[-1]}'
    assert result['items'][0]['sender_uid'] == '7100000000000000001'
    assert result['items'][0]['timestamp'] == 1700000000
    assert result['items'][0]['msg_id'] != result['items'][1]['msg_id']
    conn.close()


def test_old_forward_local_recovery_and_missing(temp_db):
    conn = database.get_db()
    insert_conversation(conn, 'c1', '会话')
    insert_message(conn, 'srv_123', 'c1', 1, msg_type=3, content='[图片]', media_local_path='images/test.jpg')
    result = resolve_forward(forward({'msg_ids': [{'msg_id': 123}, {'msg_id': 124}],
                                     'list_content': [{'msgid': 124, 'nick_name': '测试', 'text': '摘要'}]}), conn)
    assert result['available'] == result['missing'] == 1
    assert not result['complete']
    assert result['items'][0]['media_local_path'] == 'images/test.jpg'
    assert result['items'][1]['detail_missing'] and result['items'][1]['content'] == '摘要'
    conn.close()


def test_nested_cycle_and_malformed(temp_db):
    conn = database.get_db()
    insert_conversation(conn, 'c1', '会话')
    recursive = forward({'msg_ids': [{'msg_id': 123}]})
    insert_message(conn, 'srv_123', 'c1', 1, raw_data=recursive['raw_data'])
    result = resolve_forward(recursive, conn)
    child = result['items'][0]['forward_detail']['items'][0]['forward_detail']
    assert child['items'] == [] and not child['complete']
    assert resolve_forward({'raw_data': '{bad'}, conn) is None
    assert resolve_forward(forward({'msg_ids': [None, 'bad']}), conn)['items'] == []
    conn.close()


def test_broken_body_does_not_count_as_full_detail(temp_db):
    conn = database.get_db()
    result = resolve_forward(forward({'msg_ids': [{'msg_id': 42}],
                                     'inline_content': [{'server_message_id': 42, 'content': '{bad'}]}), conn)
    assert not result['complete'] and result['available'] == 0
    assert result['items'][0]['detail_missing']
    conn.close()


def test_forward_http_contract(temp_db, monkeypatch):
    from fastapi.testclient import TestClient
    from backend import main
    monkeypatch.setattr(main, '_get_password_hash', lambda: None)
    conn = database.get_db()
    insert_conversation(conn, 'c1', '会话')
    insert_message(conn, 'normal', 'c1', 1, content='文本')
    insert_message(conn, 'merged', 'c1', 2, raw_data=forward({'msg_ids': [{'msg_id': 42}]})['raw_data'])
    conn.commit()
    conn.close()
    client = TestClient(main.app)
    assert client.get('/api/messages/not-found/forward').status_code == 404
    assert client.get('/api/messages/normal/forward').status_code == 422
    response = client.get('/api/messages/merged/forward')
    assert response.status_code == 200
    assert response.json()['missing'] == 1


def test_preview_names_follow_sender_beyond_first_three(temp_db):
    conn = database.get_db()
    ids = [101, 102, 103, 104, 105]
    message = forward({'msg_ids': [{'msg_id': i, 'uid': 20 if i % 2 else 30} for i in ids],
        'list_content': [{'msgid': 101, 'nick_name': '乙'}, {'msgid': 102, 'nick_name': '丙'}],
        'inline_content': [{'server_message_id': i, 'sender': 20 if i % 2 else 30,
                            'content': json.dumps({'text': '正文'})} for i in ids]})
    detail = resolve_forward(message, conn)
    assert [m['sender_name'] for m in detail['items']] == ['乙', '丙', '乙', '丙', '乙']
    conn.close()
