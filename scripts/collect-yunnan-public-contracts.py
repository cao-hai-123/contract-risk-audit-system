"""Resume public provincial Yunnan contracts, retaining list-response provenance."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('collect-public-contracts.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
endpoint = 'https://ggzy.yn.gov.cn/ynggfwpt-home-api/jyInfo/zfcg/getHtgsList'
body = {'pageNum': 1, 'pageSize': 50, 'cityId': '', 'industryCode': '', 'childType': '', 'title': ''}
data, meta = c.fetch(endpoint, body=json.dumps(body, ensure_ascii=False))
payload = json.loads(data)
assert str(payload.get('code')) == '1', 'official list request failed'
seeds, published = [], {}
for row in payload['value']['list']:
    url = 'https://ggzy.yn.gov.cn/ynggfwpt-home-api/jyInfo/zfcg/findHtgsByGuid?' + c.urlencode({'guid': row['guid']})
    seeds.append(url)
    published[url] = {'links': c.Links(row.get('contractContent') or '').links,
                      'source': {'url': endpoint, 'method': 'POST', 'body': body, 'guid': row['guid'], 'fetched_at': meta['fetched_at']}}
print(c.collect('云南', seeds, max_pages=55, published_links=published))
