import json

from fastapi.testclient import TestClient
from tests.conftest import insert_conversation, insert_message
from backend import database, main


def seed(temp_db):
    conn = database.get_db()
    insert_conversation(conn, 'c1', '当前会话')
    insert_conversation(conn, 'c2', '其他会话')
    for i in range(55):
        insert_message(conn, f'm{i:02}', 'c1', i, content='匹配', timestamp=100 + i)
    insert_message(conn, 'other', 'c2', 60, content='匹配', timestamp=120)
    insert_message(conn, 'image', 'c1', 70, msg_type=3, timestamp=120, raw_data='{bad')
    insert_message(conn, 'video', 'c1', 71, msg_type=5, timestamp=120)
    insert_message(conn, 'legacy-video', 'c1', 72, msg_type=3, media_local_path='videos/test.MP4', timestamp=120)
    insert_message(conn, 'json-video', 'c1', 73, msg_type=1, timestamp=120,
                   raw_data=json.dumps({'content_json': json.dumps({'video': {'vid': 'abc'}})}))
    insert_message(conn, 'literal', 'c1', 74, content='100%_\\', timestamp=120)
    conn.commit()
    conn.close()


def test_scoped_search_pagination_and_boundaries(temp_db):
    seed(temp_db)
    first, total = database.search_messages('匹配', conv_id='c1')
    second, total2 = database.search_messages('匹配', conv_id='c1', page=2)
    assert total == total2 == 55
    assert len(first) == 50 and len(second) == 5
    assert not ({m['msg_id'] for m in first} & {m['msg_id'] for m in second})
    rows, total = database.search_messages('匹配', conv_id='c1', start_time=110, end_time=120)
    assert total == 10
    assert all(110 <= m['timestamp'] < 120 for m in rows)


def test_media_search_legacy_and_bad_json(temp_db):
    seed(temp_db)
    rows, total = database.search_messages(conv_id='c1', media_type='image')
    assert total == 1 and rows[0]['msg_id'] == 'image'
    rows, total = database.search_messages(conv_id='c1', media_type='video')
    assert {m['msg_id'] for m in rows} == {'video', 'legacy-video', 'json-video'}
    assert total == 3
    assert database.search_messages(conv_id='c1', media_type='media')[1] == 4
    assert database.search_messages('%_\\', conv_id='c1')[1] == 1


def test_search_http_validation(temp_db, monkeypatch):
    seed(temp_db)
    monkeypatch.setattr(main, '_get_password_hash', lambda: None)
    client = TestClient(main.app)
    assert client.get('/api/search', params={'conv_id': 'c1', 'media_type': 'image'}).json()['total'] == 1
    assert client.get('/api/search', params={'start_time': 20, 'end_time': 10}).status_code == 422
    assert client.get('/api/search', params={'media_type': 'invalid'}).status_code == 422
    assert client.get('/api/search', params={'page': 0}).status_code == 422
    assert client.get('/api/search').status_code == 422


def test_calendar_date_jump_can_request_just_first_message(temp_db, monkeypatch):
    seed(temp_db)
    monkeypatch.setattr(main, '_get_password_hash', lambda: None)
    client = TestClient(main.app)
    response = client.get('/api/conversations/c1/messages/by-date', params={'date': '1970-01-01', 'tz': 0, 'limit': 1})
    assert response.status_code == 200
    assert len(response.json()['items']) == 1
    assert response.json()['items'][0]['msg_id'] == 'm00'
    assert client.get('/api/conversations/c1/messages/by-date', params={'date': '1970-01-01', 'limit': 0}).status_code == 422
