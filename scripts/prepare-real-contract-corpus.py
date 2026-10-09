"""Local, resumable native PDF extraction. No cloud, no promotion to legal standards."""
import hashlib, io, json, re, time, zipfile
from pathlib import Path
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'real-contract-corpus'
VERSION = 'native-pdfium-v1'

def digest(value):
    return hashlib.sha256(value).hexdigest()

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), 'utf8')
    temporary.replace(path)

def main():
    source = ROOT / 'matchreal'
    provenance = {}
    for manifest in source.glob('*/manifest.json'):
        for item in json.loads(manifest.read_text('utf8')).get('files', []):
            provenance[str((manifest.parent / item['file']).resolve())] = item
    rows, by_hash = [], {}
    for path in sorted(source.rglob('*.pdf')):
        relative = path.relative_to(source).as_posix()
        if '_excluded' in path.relative_to(source).parts:
            rows.append({'source': relative, 'status': 'excluded_by_prior_review'})
            continue
        h = digest(path.read_bytes())
        if h in by_hash:
            rows.append({'source': relative, 'sha256': h, 'status': 'duplicate', 'duplicate_of': by_hash[h]})
            continue
        by_hash[h] = relative
        cache = OUT / 'documents' / (h + '.json')
        record = {'source': relative, 'sha256': h, 'language': 'zh', 'parser_version': VERSION,
                  'source_kind': 'official_notice_attachment' if str(path.resolve()) in provenance else 'user_supplied_unverified_origin',
                  'provenance': provenance.get(str(path.resolve()), {}), 'legal_review': 'pending', 'pages': []}
        try:
            if cache.exists():
                saved = json.loads(cache.read_text('utf8'))
                if saved.get('parser_version') == VERSION:
                    record = saved
            if not record['pages']:
                doc = pdfium.PdfDocument(str(path))
                for i in range(len(doc)):
                    page = doc[i]; tp = page.get_textpage(); text = tp.get_text_range(); tp.close()
                    # Image pages need OCR even when an embedded text layer exists.
                    has_image = any(obj.type == 3 for obj in page.get_objects())
                    letters = len(re.findall(r'[\u4e00-\u9fffA-Za-z]', text))
                    record['pages'].append({'page': i+1, 'text': text, 'method': 'native',
                                            'status': 'ocr_pending' if letters < 30 or has_image else 'text_extracted'})
                    page.close()
                doc.close()
            record['status'] = 'ocr_pending' if any(p['status'] == 'ocr_pending' for p in record['pages']) else 'extracted' if all(p['status'] == 'text_extracted' for p in record['pages']) else 'partial'
            record['text_hash'] = digest(re.sub(r'\s+', '', ''.join(p['text'] for p in record['pages'])).encode())
            # Split by recognized content, so exact text duplicates cannot cross evaluation boundaries.
            record['split'] = 'holdout' if int(record['text_hash'][:8], 16) % 5 == 0 else 'development'
            write(cache, record)
        except Exception as e:
            record.update(status='failed', error=type(e).__name__)
            write(cache, record)
        rows.append({k: record[k] for k in ['source','sha256','status','source_kind','split'] if k in record})
        rows[-1]['pages'] = len(record['pages'])
        rows[-1]['ocr_pending_pages'] = sum(p['status']=='ocr_pending' for p in record['pages'])
    # Official GitHub distribution already downloaded in this project; preserve its archive hash.
    archive = ROOT / 'datasets/archive/cuad-main.zip'
    with zipfile.ZipFile(archive) as outer:
        with zipfile.ZipFile(io.BytesIO(outer.read('cuad-main/data.zip'))) as inner:
            cuad = json.loads(inner.read('CUADv1.json'))
    external = ROOT / 'datasets/archive/cuad-extracted'
    archive_hash = digest(archive.read_bytes())
    for item in cuad['data']:
        h = digest(item['title'].encode())
        write(external/(h+'.json'), {'title':item['title'], 'language':'en', 'source':'https://github.com/The-Atticus-Project/cuad',
              'archive_sha256':archive_hash, 'license':'CC-BY-4.0', 'purpose':'english_extraction_evaluation_only',
              'chinese_standard_eligible':False, 'paragraphs':item['paragraphs']})
    receipt = {'built_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'version':VERSION, 'files':rows,
               'cuad_contracts':len(cuad['data']), 'complete_contracts_certified':0}
    write(OUT/'manifest.json', receipt)
    print(json.dumps({'files':len(rows),'unique':len(by_hash),'cuad':len(cuad['data']),
                      'ocr_pending_pages':sum(r.get('ocr_pending_pages',0) for r in rows)},ensure_ascii=False))

if __name__ == '__main__':
    main()
