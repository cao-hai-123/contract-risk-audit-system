"""Adapters derived from the official websites' public page scripts."""
import importlib, json, argparse
from urllib.parse import urlsplit, parse_qs, urlencode, urljoin
c = importlib.import_module('collect-public-contracts')

def guangxi():
    info = json.loads((c.CACHE / 'probe-广西.json').read_text('utf8'))
    seeds = []; requests = []
    for item in info['contract_links']:
        url = item['url']; query = parse_qs(urlsplit(url).query)
        if 'infoid' not in query or 'categorynum' not in query: continue
        category = query['categorynum'][0]
        if category != '001002005005': continue
        body = urlencode({'params': json.dumps({'siteGuid': '7eb5f7f1-9041-43ad-8e13-8fcb82ea831a', 'infoid': query['infoid'][0], 'categorynum': category[:9]})})
        endpoint = 'http://ggzy.jgswj.gxzf.gov.cn/EWB-FRONT/rest/GgSearchAction/getDetails'
        try:
            data, _ = c.fetch(endpoint, body=body, content_type='application/x-www-form-urlencoded')
            for row in json.loads(c.decode(data)):
                if row.get('categorynum') == category:
                    seeds.append('http://ggzy.jgswj.gxzf.gov.cn/gxggzy' + row['visiturl'])
                    requests.append({'listing_url': info['official_home'], 'project_url': url, 'detail_url': seeds[-1]})
        except Exception as e: requests.append({'project_url': url, 'error': str(e)})
    (c.CACHE / '广西-resolved.json').write_text(json.dumps(requests, ensure_ascii=False, indent=2), 'utf8')
    return list(dict.fromkeys(seeds))

def shaanxi():
    data = json.loads((c.CACHE / '陕西-query.json').read_text('utf8'))
    result = json.loads(data['content'])['result']
    return [urljoin('https://www.sxggzyjy.cn', row['linkurl']) for row in result['records'] if row['categorynum'] == '001001004007']

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('province', choices=['广西','陕西']); args=p.parse_args()
    seeds = guangxi() if args.province == '广西' else shaanxi()
    (c.CACHE / (args.province+'-seeds.json')).write_text(json.dumps(seeds, ensure_ascii=False, indent=2), 'utf8')
    print(args.province, 'resolved notices', len(seeds), flush=True)
    print(c.collect(args.province, seeds, max_pages=90))
