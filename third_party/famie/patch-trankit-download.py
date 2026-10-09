"""Backport the official Trankit model-host migration to the pinned legacy package.

Upstream: https://github.com/nlp-uoregon/trankit/blob/master/trankit/utils/base_utils.py
Keep the 1.1.0 model API; change only its retired download endpoint and failure handling.
"""
from pathlib import Path
from importlib.util import find_spec

source = Path(find_spec('trankit').origin).parent / 'utils' / 'base_utils.py'
text = source.read_text(encoding='utf-8')
old_url = 'http://nlp.uoregon.edu/download/trankit/{}/{}/{}.zip'
new_url = 'https://huggingface.co/uonlp/trankit/resolve/main/models/{}/{}/{}.zip'
old_request = 'response = requests.get(url, stream=True)'
new_request = 'response = requests.get(url, stream=True, timeout=(15, 120))\n        response.raise_for_status()'
if text.count(old_url) != 1 or text.count(old_request) != 1:
    raise RuntimeError('Unexpected Trankit source; refusing an unverified patch')
text = text.replace(old_url, new_url).replace(old_request, new_request)
compile(text, str(source), 'exec')
source.write_text(text, encoding='utf-8')
print('Trankit official HTTPS model-host migration applied with bounded HTTP failures.')

# Trankit bundles an older Transformers fork that still constructs retired CDN URLs.
source = source.parent.parent / 'adapter_transformers' / 'file_utils.py'
text = source.read_text(encoding='utf-8')
old = '''    endpoint = CLOUDFRONT_DISTRIB_PREFIX if use_cdn else S3_BUCKET_PREFIX
    legacy_format = "/" not in model_id
    if legacy_format:
        return f"{endpoint}/{model_id}-{filename}"
    else:
        return f"{endpoint}/{model_id}/{filename}"'''
new = '    return f"https://huggingface.co/{model_id}/resolve/main/{filename}"'
request = 'response = requests.get(url, stream=True, proxies=proxies, headers=headers)'
if text.count(old) != 1 or text.count(request) != 1:
    raise RuntimeError('Unexpected bundled Transformers source; refusing an unverified patch')
text = text.replace(old, new).replace(request, 'response = requests.get(url, stream=True, proxies=proxies, headers=headers, timeout=(15, 120))\n    if response.status_code != 416:\n        response.raise_for_status()')
compile(text, str(source), 'exec')
source.write_text(text, encoding='utf-8')
print('Bundled Transformers now uses the official Hugging Face resolve endpoint.')

# Adapter-transformers 2.1.0 assumes Location is absolute; the Hub now also
# returns relative resolve-cache redirects for tokenizer metadata.
source = Path(find_spec('transformers').origin).parent / 'file_utils.py'
text = source.read_text(encoding='utf-8')
old = 'url_to_download = r.headers["Location"]'
request = 'r = requests.get(url, stream=True, proxies=proxies, headers=headers)'
if text.count(old) != 1 or text.count(request) != 1 or text.count('from urllib.parse import urlparse') != 1:
    raise RuntimeError('Unexpected adapter-transformers source; refusing an unverified patch')
text = text.replace('from urllib.parse import urlparse', 'from urllib.parse import urlparse, urljoin')
text = text.replace(old, 'url_to_download = urljoin(url, r.headers["Location"])')
text = text.replace(request, 'r = requests.get(url, stream=True, proxies=proxies, headers=headers, timeout=(15, 120))')
compile(text, str(source), 'exec')
source.write_text(text, encoding='utf-8')
print('Adapter-transformers relative Hub redirects now resolve against their source URL.')
