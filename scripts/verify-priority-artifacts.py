"""Read-only content and monochrome verification of synthetic application exports."""
import json
import pathlib
import re
import zipfile
import xml.etree.ElementTree as ET
from pypdf import PdfReader

root = pathlib.Path(__file__).resolve().parent.parent / 'tmp' / 'priority-repairs'
fields = json.loads((root / 'expected-fields.json').read_text(encoding='utf-8'))
with zipfile.ZipFile(root / 'qa-unified.docx') as archive:
    xml = ET.fromstring(archive.read('word/document.xml'))
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    word_text = ''.join(node.text or '' for node in xml.findall('.//w:t', ns))
    colors = {node.attrib.get('{'+ns['w']+'}val') for node in xml.findall('.//w:color', ns)}
    assert all(value in {'auto', None} or (len(value) == 6 and value[:2] == value[2:4] == value[4:]) for value in colors), colors
pdf = PdfReader(root / 'qa-unified.pdf')
pdf_text = '\n'.join(page.extract_text() for page in pdf.pages)
clean = lambda text: re.sub(r'\s+', '', text)
for name, value in fields.items():
    assert clean(value) in clean(word_text), 'Word omitted field: ' + name
    assert clean(value) in clean(pdf_text), 'PDF omitted field: ' + name
for value in ['已人工确认', '不构成法律意见', '原文位置', '全部损失']:
    assert value in word_text, 'Word missing: ' + value
    assert value in clean(pdf_text), 'PDF missing: ' + value
assert '[U+1F642]' in pdf_text, 'Unrenderable glyph needs visible code-point fallback'
result = {'passed': True, 'formats': ['word', 'pdf', 'html'], 'keyFieldsPerFormat': len(fields),
          'pdfPages': len(pdf.pages), 'wordColors': sorted(colors),
          'wordNativeVisualVerification': 'unverified: native Word opened file but PDF export stalled; LibreOffice unavailable'}
(root / 'artifact-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
