"""One bounded local job per process. Inputs are private server-created JSON files."""
import os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'runtime' / 'seal'))
import json
import hashlib
import shutil
import subprocess
import zipfile
import xml.etree.ElementTree as ET
from contextlib import closing
import cv2
import numpy as np
from PIL import Image, ImageOps
import pypdfium2 as pdfium
from preprocess import prepare, save_features, load_features, VERSION, CONFIG, red_mask
from matcher import compare, aggregate
cv2.setNumThreads(1)
Image.MAX_IMAGE_PIXELS = 40_000_000


def find_soffice():
    return (os.environ.get('SEAL_SOFFICE') or shutil.which('soffice') or
            next((str(p) for p in [ROOT/'runtime/libreoffice/program/soffice.exe',
                                  Path('C:/Program Files/LibreOffice/program/soffice.exe')] if p.exists()),None))


def write_json(path, data):
    temp = str(path) + '.tmp'
    Path(temp).write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, path)


def write_image(path, image):
    ok, data = cv2.imencode('.png', image)
    if not ok:
        raise ValueError('image_encode_failed')
    Path(path).write_bytes(data.tobytes())


def read_image(path):
    image = cv2.imdecode(np.frombuffer(Path(path).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError('invalid_image')
    return image


def bitmap_image(bitmap):
    array = bitmap.to_numpy()
    if array.ndim == 2:
        return cv2.cvtColor(array, cv2.COLOR_GRAY2BGR)
    if array.shape[2] == 4:
        return cv2.cvtColor(array, cv2.COLOR_BGRA2BGR)
    return array.copy()


def candidates(image):
    mask = red_mask(image)
    merged = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((13, 13), np.uint8))
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = mask.shape
    boxes = []
    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw < 18 or bh < 18 or bw * bh < 400 or bw * bh > w * h * .98:
            continue
        margin = round(max(bw, bh) * .12)
        x0, y0 = max(0, x-margin), max(0, y-margin)
        x1, y1 = min(w, x+bw+margin), min(h, y+bh+margin)
        boxes.append(dict(x=x0/w, y=y0/h, width=(x1-x0)/w, height=(y1-y0)/h))
    return sorted(boxes, key=lambda b: b['width']*b['height'], reverse=True)[:50]


def render(job):
    source, directory = Path(job['source']), Path(job['directory'])
    ext = job['extension']
    if ext == '.docx':
        with zipfile.ZipFile(source) as z:
            if '[Content_Types].xml' not in z.namelist() or 'word/document.xml' not in z.namelist():
                raise ValueError('invalid_docx')
            if sum(i.file_size for i in z.infolist()) > 200_000_000 or len(z.infolist()) > 10000:
                raise ValueError('docx_expansion_limit')
            for name in z.namelist():
                if name.endswith('.rels'):
                    for relation in ET.fromstring(z.read(name)):
                        if relation.get('TargetMode') == 'External' and not relation.get('Type','').endswith('/hyperlink'):
                            raise ValueError('docx_external_content')
                if name.lower().endswith('vbaproject.bin') or name.startswith('word/embeddings/'):
                    raise ValueError('docx_external_content')
                if name.startswith('word/') and name.endswith('.xml'):
                    xml = z.read(name).decode('utf-8',errors='replace').upper()
                    if any(field in xml for field in ('INCLUDEPICTURE','INCLUDETEXT','DDEAUTO')):
                        raise ValueError('docx_external_content')
        soffice = find_soffice()
        if not soffice:
            raise ValueError('docx_converter_unavailable')
        result = subprocess.run([soffice, '-env:UserInstallation=' + (directory/'lo-profile').as_uri(),
                                 '--headless', '--convert-to', 'pdf', '--outdir', str(directory), str(source)],
                                capture_output=True, timeout=120,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        source = directory / (source.stem + '.pdf')
        if result.returncode != 0 or not source.exists():
            raise ValueError('docx_conversion_failed')
        ext = '.pdf'
    pages = []
    def save_page(image, index):
        filename = f'page-{index}.png'
        write_image(directory / filename, image)
        boxes = candidates(image)
        pages.append(dict(page=index, image=filename, width=image.shape[1], height=image.shape[0], candidates=boxes))
        write_json(directory/'progress.json', dict(processedPages=index, totalPages=total))
    if ext == '.pdf':
        with closing(pdfium.PdfDocument(str(source))) as doc:
            total = len(doc)
            if not 0 < total <= 200:
                raise ValueError('page_limit')
            for i in range(total):
                page = doc[i]
                w, h = page.get_size()
                scale = min(2.5, 1800 / max(w, h))
                bitmap = page.render(scale=scale)
                save_page(bitmap_image(bitmap), i+1)
                bitmap.close()
                page.close()
    else:
        with Image.open(source) as image:
            total = getattr(image, 'n_frames', 1)
            if total > 200:
                raise ValueError('page_limit')
            for i in range(total):
                image.seek(i)
                if image.width * image.height > 40_000_000:
                    raise ValueError('pixel_limit')
                frame = ImageOps.exif_transpose(image).convert('RGB')
                frame.thumbnail((1800, 1800))
                save_page(cv2.cvtColor(np.array(frame), cv2.COLOR_RGB2BGR), i+1)
    return dict(pages=pages, processingVersion=VERSION)


def crop(job):
    box = job['bbox']
    x, y, bw, bh = (float(box[k]) for k in ('x', 'y', 'width', 'height'))
    if not all(np.isfinite([x,y,bw,bh])) or min(x,y) < 0 or min(bw,bh) <= 0 or x+bw > 1.000001 or y+bh > 1.000001:
        raise ValueError('invalid_bbox')
    image = None
    directly_cropped = False
    # Preview coordinates are normalized; extract from higher-resolution originals.
    if job.get('source'):
        source = Path(job['source'])
        if source.suffix.lower() == '.docx':
            source = source.with_suffix('.pdf')
        if source.suffix.lower() == '.pdf':
            with closing(pdfium.PdfDocument(str(source))) as doc:
                page = doc[job['page']-1]
                w, h = page.get_size()
                bitmap = page.render(scale=min(4,2400/max(w*bw,h*bh)),
                                     crop=(x*w,max(0,1-y-bh)*h,max(0,1-x-bw)*w,y*h))
                image = bitmap_image(bitmap)
                directly_cropped = True
                bitmap.close()
                page.close()
        else:
            with Image.open(source) as original:
                original.seek(job['page']-1)
                if original.width * original.height > 40_000_000:
                    raise ValueError('pixel_limit')
                image = cv2.cvtColor(np.array(ImageOps.exif_transpose(original).convert('RGB')),cv2.COLOR_RGB2BGR)
    if image is None:
        image = read_image(job['pagePath'])
    h, w = image.shape[:2]
    raw = image if directly_cropped else image[round(y*h):round((y+bh)*h), round(x*w):round((x+bw)*w)]
    data = prepare(raw)
    directory = Path(job['output'])
    directory.mkdir(parents=True, exist_ok=True)
    write_image(directory/'original.png', raw)
    write_image(directory/'normalized.png', data['image'])
    write_image(directory/'red-mask.png', data['mask'])
    write_image(directory/'gray.png', data['gray'])
    save_features(data, directory/'features.npz')
    return dict(qualityScore=round(data['quality']*100, 2), qualityMetrics=data['metrics'],
                channel=data['channel'], featureCount=len(data['points']), processingVersion=VERSION,
                cropHash=hashlib.sha256(raw.tobytes()+str(raw.shape).encode()).hexdigest())


def match(job):
    query = load_features(Path(job['query'])/'features.npz')
    groups = job['groups']
    best_visual, best_score = None, -1
    failures = 0
    for group in groups:
        scores = []
        for sample in group['samples']:
            try:
                reference = load_features(Path(sample['path'])/'features.npz')
                metrics, lines = compare(query, reference)
                if lines and metrics['score'] > best_score:
                    best_visual, best_score = (sample, lines), metrics['score']
                scores.append(dict(id=sample['id'], sourceHash=sample['sourceHash'], **metrics))
            except (OSError, ValueError):
                failures += 1
        group['samples'] = scores
    result = aggregate(groups, query, CONFIG['thresholds'])
    if failures:
        result.update(status='UNCERTAIN', reason='reference_cache_unavailable')
    if best_visual:
        sample, lines = best_visual
        a, b = read_image(Path(job['query'])/'normalized.png'), read_image(Path(sample['path'])/'normalized.png')
        canvas = np.full((max(a.shape[0],b.shape[0]), a.shape[1]+b.shape[1],3),255,np.uint8)
        canvas[:a.shape[0],:a.shape[1]] = a
        canvas[:b.shape[0],a.shape[1]:] = b
        for p, q in lines[:60]:
            cv2.line(canvas, tuple(map(round,p)), (round(q[0]+a.shape[1]),round(q[1])), (40,140,30), 1)
        write_image(Path(job['query'])/'matches.png', canvas)
        result['visualSampleId'] = sample['id']
    result.update(processingVersion=VERSION, featureCount=len(query['points']), qualityScore=round(float(query['quality'])*100,2))
    return result


def rebuild(job):
    updated = []
    for sample in job['samples']:
        directory = Path(sample['path'])
        data = prepare(read_image(directory/'original.png'))
        save_features(data, directory/'features-next.npz')
        os.replace(directory/'features-next.npz', directory/'features.npz')
        write_image(directory/'normalized.png', data['image'])
        write_image(directory/'red-mask.png', data['mask'])
        write_image(directory/'gray.png', data['gray'])
        updated.append(dict(id=sample['id'],qualityScore=round(data['quality']*100,2),
                            featureCount=len(data['points']),qualityMetrics=data['metrics'],processingVersion=VERSION))
    return dict(samples=updated,processingVersion=VERSION)


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    try:
        action = spec['action']
        if action == 'health':
            result = dict(version=cv2.__version__, processingVersion=VERSION, orb=cv2.ORB_create() is not None,
                          pdf=True, docx=bool(find_soffice()))
        else:
            result = {'render': render, 'crop': crop, 'match': match, 'rebuild': rebuild}[action](spec)
        write_json(spec['resultFile'], result)
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc).replace('_','').isalnum() else 'visual_processing_failed'
        write_json(spec['resultFile'], dict(error=code))
        sys.exit(1)
