"""Run inside the built FAMIE image with --network none; no model downloads."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import requests
from transformers import file_utils as adapter
from trankit.adapter_transformers import file_utils as bundled
from trankit.utils import base_utils
from famie.api.active_learning.tokenizer_cache import load_tokenizer


class DownloadCompatibility(unittest.TestCase):
    def test_tokenizer_uses_cache_without_online_retry_when_available(self):
        tokenizer_type = Mock()
        expected = object()
        tokenizer_type.from_pretrained.return_value = expected
        self.assertIs(load_tokenizer(tokenizer_type, 'model/test', '/tmp/cache'), expected)
        tokenizer_type.from_pretrained.assert_called_once_with('model/test', local_files_only=True, cache_dir='/tmp/cache/model/test', do_lower_case=False)

    def test_tokenizer_downloads_only_when_cache_is_unavailable(self):
        tokenizer_type = Mock()
        expected = object()
        tokenizer_type.from_pretrained.side_effect = [OSError('cache missing'), expected]
        self.assertIs(load_tokenizer(tokenizer_type, 'test', '/tmp/cache'), expected)
        self.assertEqual([call.kwargs['local_files_only'] for call in tokenizer_type.from_pretrained.call_args_list], [True, False])

    def test_retired_cdn_replaced_for_plain_and_namespaced_models(self):
        for model in ['xlm-roberta-base', 'nreimers/example']:
            self.assertEqual(bundled.hf_bucket_url(model, 'pytorch_model.bin'),
                             f'https://huggingface.co/{model}/resolve/main/pytorch_model.bin')

    def test_relative_hub_redirect_uses_absolute_https_url(self):
        response = Mock(status_code=302, headers={'ETag': 'test-etag', 'Location': '/api/resolve-cache/models/test/config.json'})
        with tempfile.TemporaryDirectory() as directory:
            def write_content(url, output, **kwargs):
                self.assertEqual(url, 'https://huggingface.co/api/resolve-cache/models/test/config.json')
                output.write(b'{"synthetic":true}')
            with patch.object(adapter.requests, 'head', return_value=response), patch.object(adapter, 'http_get', side_effect=write_content):
                result = adapter.get_from_cache('https://huggingface.co/test/resolve/main/config.json', cache_dir=directory)
                self.assertEqual(Path(result).read_bytes(), b'{"synthetic":true}')

    def test_language_archive_http_failure_never_marks_download_complete(self):
        response = Mock(headers={})
        response.raise_for_status.side_effect = requests.HTTPError('synthetic 503')
        with tempfile.TemporaryDirectory() as directory, patch.object(base_utils.requests, 'get', return_value=response) as request:
            with self.assertRaises(requests.HTTPError):
                base_utils.download(directory, 'english', 'v1.0.0', 'xlm-roberta-base')
            request.assert_called_once_with('https://huggingface.co/uonlp/trankit/resolve/main/models/v1.0.0/xlm-roberta-base/english.zip', stream=True, timeout=(15, 120))
            self.assertFalse(list(Path(directory).rglob('*.downloaded')))


if __name__ == '__main__':
    unittest.main()
