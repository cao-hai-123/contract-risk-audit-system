"""Resumable public attachment collector. No login, CAPTCHA solving or cloud AI.
Only discovered links are followed; originals are never rewritten.
"""
import argparse, base64, concurrent.futures, hashlib, io, json, re, subprocess, time, sys
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urldefrag, quote, parse_qs, urlencode
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'matchreal'
CACHE = ROOT / 'tmp' / 'contract-collection'
OUT.mkdir(exist_ok=True); CACHE.mkdir(parents=True, exist_ok=True)
sys.stdout.reconfigure(encoding='utf-8')

class Links(HTMLParser):
    def __init__(self, text):
        super().__init__(); self.links = []; self.current = None; self.scripts = []
        self.feed(text)
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'a':
            href = a.get('href', '')
            if href.startswith('#') or not href:
                m = re.search(r"(?:encodeURI\(|href\s*=\s*)['\"]([^'\"]+)['\"]", a.get('onclick', ''))
                if m: href = m.group(1)
            self.current = [href, a.get('title', '')]
        if tag in ('iframe', 'embed') and a.get('src'): self.links.append((a['src'], 'embedded'))
        if tag == 'script' and a.get('src'): self.scripts.append(a['src'])
        m = re.search(r"window.open\(['\"]([^'\"]+)['\"]", a.get('onclick', ''))
        if m: self.links.append((m.group(1), a.get('title', '')))
    def handle_data(self, data):
        if self.current: self.current[1] += data
    def handle_endtag(self, tag):
        if tag == 'a' and self.current:
            self.links.append(tuple(self.current)); self.current = None

def fetch(url, referer=None, body=None, content_type='application/json'):
    url = urldefrag(url.strip())[0]
    url = quote(url, safe=":/?&=%+#@;,!$'()*[]")
    if urlsplit(url).scheme not in ('http', 'https'): raise ValueError('unsupported URL')
    key = hashlib.sha256(url.encode() + (b'\0POST\0' + body.encode('utf8') if body is not None else b'')).hexdigest()
    target = CACHE / (key + '.bin'); meta = CACHE / (key + '.json')
    if target.exists() and meta.exists(): return target.read_bytes(), json.loads(meta.read_text('utf8'))
    part = CACHE / (key + '.part')
    cmd = ['curl.exe', '--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort', '--connect-timeout', '12', '--max-time', '65', '--max-filesize', '80000000', '--retry', '1', '--retry-delay', '1', '--user-agent', 'Mozilla/5.0 (compatible; PublicContractResearch/1.0)', '--output', str(part), '--write-out', '%{http_code}\n%{url_effective}\n%{content_type}', url]
    if referer: cmd += ['--referer', referer]
    if body is not None: cmd += ['--header', 'Content-Type: ' + content_type, '--data-binary', '@-']
    r = subprocess.run(cmd, input=body.encode('utf8') if body is not None else None, capture_output=True, timeout=145, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if r.returncode:
        part.unlink(missing_ok=True)
        raise RuntimeError(r.stderr.decode('utf8', 'replace')[-300:])
    details = r.stdout.decode('utf8', 'replace').splitlines()
    info = dict(url=url, status=details[0], final_url=details[1], content_type=details[2] if len(details)>2 else '', fetched_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    part.replace(target); meta.write_text(json.dumps(info, ensure_ascii=False), 'utf8')
    time.sleep(.3)
    return target.read_bytes(), info

def decode(data):
    try: return data.decode('utf8')
    except UnicodeDecodeError: return data.decode('gb18030', 'replace')

def download_attachment(url, referer):
    data, info = fetch(url, referer)
    # Guangxi's public download page submits an empty form to this documented
    # action. Follow that form, retaining the initial attachment URL in provenance.
    if b'ztbAttachDownloadAction.action?cmd=getContent&attachGuid=' in data and b'form.submit()' in data:
        query = parse_qs(urlsplit(url).query)
        params = {'cmd': 'getContent', **{k: query[k][0] for k in ('attachGuid','appUrlFlag','siteGuid') if k in query}}
        action = urljoin(info['final_url'], 'ztbAttachDownloadAction.action') + '?' + urlencode(params)
        return fetch(action, info['final_url'], body='', content_type='application/x-www-form-urlencoded')
    return data, info

def links(url):
    data, info = fetch(url)
    parsed = Links(decode(data))
    if (urlsplit(info['final_url']).hostname == 'ggzy.yn.gov.cn'
            and urlsplit(info['final_url']).path == '/ynggfwpt-home-api/jyInfo/zfcg/findHtgsByGuid'):
        payload = json.loads(data)
        if str(payload.get('code')) != '1':
            raise ValueError('official Yunnan contract detail API did not return success')
        parsed = Links(payload['value'].get('contractContent') or '')
    if (urlsplit(info['final_url']).hostname == 'ggzyjy.nmg.gov.cn'
            and b'/trssearch/openSearch/getPublishResourceDealContent' in data):
        source_id = parse_qs(urlsplit(info['final_url']).query).get('id', [''])[0]
        if source_id:
            endpoint = 'https://ggzyjy.nmg.gov.cn/trssearch/openSearch/getPublishResourceDealContent?'
            detail, _ = fetch(endpoint + urlencode({'sourceDataKey': source_id}), info['final_url'])
            payload = json.loads(detail)
            if str(payload.get('state')) != '200':
                raise ValueError('official Inner Mongolia detail API did not return success')
            parsed = Links(payload['data']['dealContent'].get('noticeContent') or '')
    # The public Hubei procurement page's diy.js uses this exact download
    # endpoint and one base64 encoding of the visible attachment identifier.
    if urlsplit(info['final_url']).hostname == 'www.ccgp-hubei.gov.cn':
        converted = []
        for href, title in parsed.links:
            match = re.fullmatch(r"javascript:downloadFile\(encodeBase64\('([0-9a-f]+)'\)\);?", href)
            if match:
                encoded = base64.b64encode(match[1].encode('ascii')).decode('ascii')
                href = 'https://www.ccgp-hubei.gov.cn:8090/gpmispub/download?id=' + quote(encoded, safe='')
            converted.append((href, title))
        parsed.links = converted
    return parsed, info

def provinces():
    parsed = Links((CACHE / 'national.html').read_text('utf8'))
    names = '北京 天津 河北 山西 内蒙古 辽宁 吉林 黑龙江 上海 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 广西 海南 重庆 四川 贵州 云南 西藏 陕西 甘肃 青海 宁夏 新疆'.split()
    return {name: next(href for href, title in parsed.links if title.strip() == name) for name in names}

def probe(name, home):
    result = {'province': name, 'official_home': home, 'directory_source': 'https://www.ggzy.gov.cn/', 'target': 30}
    try:
        parsed, info = links(home)
        result.update(info)
        result['contract_links'] = [{'url': urljoin(info['final_url'], u.strip()), 'title': re.sub(r'\s+', ' ', t).strip()} for u,t in parsed.links if '合同' in t or 'htgs' in u.lower()]
        result['scripts'] = [urljoin(info['final_url'], s) for s in parsed.scripts if not re.search(r'jquery|bootstrap|swiper|echarts', s, re.I)]
        result['trade_links'] = [{'url': urljoin(info['final_url'], u.strip()), 'title': re.sub(r'\s+', ' ', t).strip()} for u,t in parsed.links if any(w in t for w in ['政府采购', '公告公示', '交易信息'])][:15]
    except Exception as e: result['error'] = str(e)
    (CACHE / ('probe-' + name + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), 'utf8')
    print(json.dumps({k:result[k] for k in ('province','contract_links','trade_links','error') if k in result}, ensure_ascii=False), flush=True)
    return result

def collect(name, seeds, target=30, max_pages=180, published_links=None):
    folder = OUT / name; folder.mkdir(exist_ok=True)
    manifest = folder / 'manifest.json'
    state = json.loads(manifest.read_text('utf8')) if manifest.exists() else {'province': name, 'target': target, 'official_home': provinces()[name], 'files': [], 'failures': [], 'visited': []}
    hashes = {f['sha256'] for f in state['files']}; visited = set(state['visited'])
    exclusion_file = OUT / 'excluded-files.json'
    if exclusion_file.exists():
        hashes.update(r['sha256'] for r in json.loads(exclusion_file.read_text('utf8')))
    queue = [(u, '合同公示', 0) for u in seeds]; seen = set()
    def save():
        state['visited'] = sorted(visited); state['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        manifest.write_text(json.dumps(state, ensure_ascii=False, indent=2), 'utf8')
    count = 0
    while queue and len(state['files']) < target and count < max_pages:
        url, label, depth = queue.pop(0)
        url = urldefrag(url)[0]
        if url in seen or depth > 3: continue
        seen.add(url); count += 1
        try:
            parsed, info = links(url); visited.add(url)
            # Optional links extracted from the platform's public list response
            # when its detail response omits attachments. Preserve both sources.
            listing_source = None
            if published_links and url in published_links:
                extra = published_links[url]
                parsed.links.extend(extra['links'])
                listing_source = extra['source']
            pdfs = [(urljoin(info['final_url'], u.strip()), t.strip()) for u,t in parsed.links if re.search(r'\.pdf(?:[?\s]|$)', u, re.I) or re.search(r'\.pdf\s*$', t, re.I)]
            for pdf_url, title in dict(pdfs).items():
                if len(state['files']) >= target: break
                if re.search('操作手册|使用手册|授权委托书|中标通知书|验收报告', title): continue
                if re.search('招标文件|采购文件|中标通知|公告|公示|履约验收|验收报告', title) and '合同' not in title: continue
                if pdf_url in {f['attachment_url'] for f in state['files']}: continue
                try:
                    data, attachment_info = download_attachment(pdf_url, url)
                    if not data.startswith(b'%PDF-') or b'%%EOF' not in data[-4096:]: raise ValueError('not a complete PDF byte stream')
                    digest = hashlib.sha256(data).hexdigest()
                    if digest in hashes: continue
                    doc = PdfReader(io.BytesIO(data), strict=False)
                    if doc.is_encrypted and not doc.decrypt(''): raise ValueError('encrypted PDF')
                    n = len(doc.pages)
                    if n < 2: raise ValueError('single-page document; completeness requires review')
                    text = '\n'.join(doc.pages[i].extract_text() or '' for i in sorted(set([0, min(1,n-1), n-1])))
                    if len(text.strip()) > 100 and '合同' not in text and '协议' not in text: raise ValueError('contract identity not established from extracted pages')
                    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title or label).strip(' .')
                    if not stem or stem == 'embedded': stem = label
                    stem = re.sub(r'\.pdf$', '', stem, flags=re.I)[:80]
                    filename = f'{len(state["files"])+1:03d}_{stem}_{digest[:8]}.pdf'
                    (folder / filename).write_bytes(data); hashes.add(digest)
                    state['files'].append({'file': filename, 'announcement_url': url, 'announcement_title': label, 'attachment_url': pdf_url, 'final_attachment_url': attachment_info['final_url'], 'sha256': digest, 'bytes': len(data), 'pages': n, 'text_characters_sampled': len(text), 'validation': 'pdf_structure_and_sampled_contract_text' if len(text.strip())>100 else 'pdf_structure_scan_requires_visual_review', 'completeness': 'requires_content_review', 'downloaded_at': attachment_info['fetched_at']})
                    if listing_source:
                        state['files'][-1]['attachment_listing_source'] = listing_source
                    save(); print(name, len(state['files']), 'PDF', n, 'pages', flush=True)
                except Exception as e: state['failures'].append({'url': pdf_url, 'reason': str(e)})
            for u,t in parsed.links:
                full = urljoin(info['final_url'], u.strip())
                if not u or u.startswith(('javascript:', '#')): continue
                if full in seen: continue
                same_host = urlsplit(full).hostname == urlsplit(info['final_url']).hostname
                if same_host and ('合同' in t or any(k in full.lower() for k in ('htgs', 'jyxxgcht', 'jyxxzcht', 'jyxxhtys')) or (depth == 0 and re.search(r'下一页|^\d+$', t.strip()))):
                    queue.append((full, re.sub(r'\s+', ' ', t).strip() or label, depth if re.search(r'index(?:_\d+)?\.', u) else depth+1))
            save()
        except Exception as e:
            state['failures'].append({'url': url, 'reason': str(e)}); save()
    save()
    return {'province': name, 'downloaded': len(state['files']), 'pages_visited': count, 'failures': len(state['failures'])}

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--probe', action='store_true'); p.add_argument('--province'); p.add_argument('--seed', action='append', default=[]); p.add_argument('--max-pages', type=int, default=180)
    args = p.parse_args()
    if args.probe:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor: list(executor.map(lambda x: probe(*x), provinces().items()))
    elif args.province: print(json.dumps(collect(args.province, args.seed, max_pages=args.max_pages), ensure_ascii=False))
