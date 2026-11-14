"""HTTP regressions for the stdlib development server (no browser or dependencies)."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('mock_server', Path(__file__).parents[1] / 'dev/mock_server.py')
mock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mock)


class MockServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mock.Handler.key = 'sk-test'
        mock.Handler.hide_ctx = True
        mock.Handler.ctx_limit = 3000
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), mock.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, body=None):
        return urllib.request.urlopen(urllib.request.Request(
            self.base + path, data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer sk-test', 'Content-Type': 'application/json'})).read().decode()

    def test_hidden_window(self):
        self.assertNotIn('n_ctx', self.request('/v1/models'))
        self.assertNotIn('n_ctx', self.request('/props'))

    def test_limit_both_dialects(self):
        chat = self.request('/v1/chat/completions', {'messages': [{'role': 'user', 'content': 'x' * 13000}], 'stream_options': {'include_usage': True}})
        self.assertIn('"finish_reason": "length"', chat)
        self.assertIn('"total_tokens": 3000', chat)
        response = self.request('/v1/responses', {'input': [{'role': 'user', 'content': 'x' * 13000}]})
        self.assertIn('"finish_reason": "length"', response)
        self.assertIn('"total_tokens": 3000', response)
        self.assertIn('function_call_arguments.delta', response)

    def test_output_cannot_exceed_the_hard_window(self):
        messages = [{'role': 'user', 'content': 'call:{"name":"kv","loop":true}'},
                    {'role': 'tool', 'content': 'x' * 11400}]
        for path, key in [('/v1/chat/completions', 'messages'), ('/v1/responses', 'input')]:
            data = self.request(path, {
                key: messages,
                'tools': [{'type': 'function', 'function': {'name': 'kv'}}],
                'stream_options': {'include_usage': True},
            })
            chunks = [json.loads(line[6:]) for line in data.splitlines() if line.startswith('data: {')]
            usage = next(c['usage'] if 'usage' in c else c['response']['usage'] for c in chunks
                         if 'usage' in c or c.get('type') == 'response.completed')
            self.assertEqual(usage['total_tokens'], 3000)
            self.assertIn('"finish_reason": "length"', data)

    def test_loop_generates_compactable_history(self):
        result = self.request('/v1/chat/completions', {
            'messages': [{'role': 'user', 'content': 'call:{"name":"kv","args":{},"loop":true}'},
                         {'role': 'tool', 'tool_call_id': 'c', 'content': '{}'}],
            'tools': [{'type': 'function', 'function': {'name': 'kv'}}],
        })
        self.assertIn('"reasoning_content":', result)
        self.assertIn('"finish_reason": "tool_calls"', result)

    def test_invalid_arguments_both_dialects(self):
        bodies = [('/v1/chat/completions', {'messages': [{'role': 'assistant', 'tool_calls': [{'id': 'a', 'function': {'name': 'edit', 'arguments': '{"id": "a'}}]}]}),
                  ('/v1/responses', {'input': [{'type': 'function_call', 'call_id': 'a', 'name': 'edit', 'arguments': '{"id": "a'}]})]
        for path, body in bodies:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request(path, body)
            self.assertEqual(caught.exception.code, 400)
            with caught.exception as error:
                self.assertIn('Unterminated string starting at', error.read().decode())


if __name__ == '__main__':
    unittest.main()
