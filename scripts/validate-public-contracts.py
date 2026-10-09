"""Validate original public PDFs without editing them or sending text to AI."""
import hashlib, json, re, sys, time
from pathlib import Path
import pypdfium2 as pdfium
from pypdf import PdfReader
sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parents[1]
out = root / 'matchreal'
results = []
hashes = {}
for manifest in sorted(out.glob('*/manifest.json')):
    state = json.loads(manifest.read_text('utf8'))
    for item in state['files']:
        path = manifest.parent / item['file']
        result = {'province': state['province'], 'file': str(path.relative_to(out)), 'announcement_url': item['announcement_url'], 'content_completeness': 'not_certified'}
        try:
            data = path.read_bytes(); digest = hashlib.sha256(data).hexdigest()
            assert digest == item['sha256'], 'hash mismatch'
            assert len(data) == item['bytes'], 'byte count mismatch'
            reader = PdfReader(path)
            doc = pdfium.PdfDocument(str(path))
            assert len(doc) == len(reader.pages) == item['pages'], 'page count mismatch'
            lengths=[]; parts=[]
            for n in range(len(doc)):
                page=doc[n]
                bitmap=page.render(scale=.25)
                assert bitmap.width>0 and bitmap.height>0
                bitmap.close()
                textpage=page.get_textpage(); text=textpage.get_text_range();textpage.close()
                lengths.append(len(text.strip()));parts.append(text)
                page.close()
            doc.close()
            text='\n'.join(parts)
            groups={
                'contract_identity': bool(re.search('合同|协议',text)),
                'parties': bool(re.search('甲方|发包人|采购人|委托人',text) and re.search('乙方|承包人|供应商|受托人',text)),
                'obligations': bool(re.search('应当|应按|负责|义务|提供|交付',text)),
                'price_payment': bool(re.search('价款|金额|付款|支付|费用',text)),
                'term': bool(re.search('期限|工期|有效期|履行|交货|交付',text)),
                'liability_dispute': bool(re.search('违约|争议|仲裁|诉讼',text)),
                'execution': bool(re.search('签字|签章|盖章|签订|签署|签约',text)),
            }
            result.update(structural_check='passed',sha256=digest,pages=len(lengths),all_pages_rendered=True,text_characters=sum(lengths),scanned_or_low_text_pages=sum(n<30 for n in lengths),contract_evidence=groups,
                content_review='text_checks_passed_manual_completeness_pending' if all(groups.values()) else 'manual_review_required')
            if digest in hashes:result['duplicate_of']=hashes[digest]
            else:hashes[digest]=result['file']
        except Exception as e: result.update(structural_check='failed',error=str(e))
        results.append(result)
    print(state['province'],sum(r['province']==state['province'] for r in results),'validated',flush=True)
receipt={'checked_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'note':'Every page decoded and rendered. Text evidence is a screening check, not proof that all contractual annexes were publicly disclosed. No files rewritten.','results':results}
(out/'validation-results.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),'utf8')
print(json.dumps({'files':len(results),'structural_pass':sum(r['structural_check']=='passed' for r in results),'content_completeness_certified':0},ensure_ascii=False))
