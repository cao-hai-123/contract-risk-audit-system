"""Resume page-level local OCR; original PDFs remain untouched. CPU process pool."""
import sys, json, time, hashlib, argparse, concurrent.futures, os, threading, uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'runtime/corpus-ocr'))
import pypdfium2 as pdfium
from rapidocr_onnxruntime import RapidOCR
from PIL import ImageStat
OUT = ROOT/'data/real-contract-corpus'
ENGINE = None
VERSION = 'rapidocr-1.4.4-ppocr-v4-width1600-v1'

def initialize():
    global ENGINE
    ENGINE = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)

def process_document(filename):
    p = Path(filename); record = json.loads(p.read_text('utf8'))
    source = (ROOT/'matchreal'/record['source']).resolve()
    assert source.is_relative_to((ROOT/'matchreal').resolve())
    assert hashlib.sha256(source.read_bytes()).hexdigest() == record['sha256']
    doc = pdfium.PdfDocument(str(source))
    completed = 0
    for info in record['pages']:
        if info['status'] != 'ocr_pending': continue
        page = bm = im = None
        try:
            page = doc[info['page']-1]; bm = page.render(scale=min(3,1600/page.get_width())); im = bm.to_pil().convert('RGB')
            result, _ = ENGINE(im)
            lines = [{'box':row[0], 'text':row[1], 'confidence':float(row[2])} for row in (result or [])]
            text = '\n'.join(row['text'] for row in lines)
            native = info['text']
            # Keep both channels; OCR is used for image/mixed pages, never silently fabricated by an LLM.
            info.update(native_text=native, text=text or native, ocr_lines=lines, method='rapidocr', ocr_version=VERSION,
                        confidence=sum(r['confidence'] for r in lines)/len(lines) if lines else 0,
                        status='text_extracted' if text.strip() else 'manual_review_required')
        except Exception as e:
            info.update(status='ocr_failed', error=type(e).__name__)
        finally:
            if im is not None: im.close()
            if bm is not None: bm.close()
            if page is not None: page.close()
        completed += 1
        # Every page checkpoints to allow safe continuation after process interruption.
        record['status'] = 'ocr_pending' if any(x['status']=='ocr_pending' for x in record['pages']) else 'extracted' if all(x['status']=='text_extracted' for x in record['pages']) else 'partial'
        temporary=p.with_suffix('.tmp');temporary.write_text(json.dumps(record,ensure_ascii=False),'utf8');temporary.replace(p)
    doc.close()
    return {'sha256':record['sha256'],'pages_processed':completed,'status':record['status']}

def coverage():
    documents, pages = {}, {}
    for p in (OUT/'documents').glob('*.json'):
        r=json.loads(p.read_text('utf8'))
        documents[r['status']]=documents.get(r['status'],0)+1
        for page in r['pages']: pages[page['status']]=pages.get(page['status'],0)+1
    return {'documents':documents,'pages':pages}


def alive(pid):
    if not isinstance(pid,int) or pid <= 0: return False
    try:
        if os.name == 'nt':
            import ctypes
            handle=ctypes.windll.kernel32.OpenProcess(0x1000,False,pid)
            if not handle: return ctypes.windll.kernel32.GetLastError()==5
            code=ctypes.c_ulong(); ctypes.windll.kernel32.GetExitCodeProcess(handle,ctypes.byref(code));ctypes.windll.kernel32.CloseHandle(handle)
            return code.value==259
        os.kill(pid,0);return True
    except (OSError,ValueError):return False


def atomic_json(path,value):
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),'utf8');temp.replace(path)


def batched_results(files, workers, worker=process_document, initializer=initialize):
    # Recreate the whole pool only after a bounded batch drains. Child retirement
    # with queued futures left the former Windows executor without workers.
    workers=max(1,min(workers,4))
    for offset in range(0,len(files),workers*8):
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers,initializer=initializer) as pool:
            futures={pool.submit(worker,p):p for p in files[offset:offset+workers*8]}
            for future in concurrent.futures.as_completed(futures):
                yield futures[future],future


def reconcile_status():
    path=OUT/'pipeline-status.json'
    previous=json.loads(path.read_text('utf8')) if path.exists() else {}
    if previous.get('status')=='running' and not alive(previous.get('pid')):
        previous.update(status='interrupted',reason='worker_process_not_running')
        for stage in previous.get('stages',[]):
            if stage.get('status')=='running':stage['status']='interrupted'
    elif previous.get('status')=='running' and previous.get('updatedAt'):
        from datetime import datetime
        try:
            age=time.time()-datetime.fromisoformat(previous['updatedAt']).timestamp()
            if age>90:
                previous.update(status='stalled',reason='heartbeat_expired_process_still_exists')
            elif previous.get('lastProgressAt') and time.time()-datetime.fromisoformat(previous['lastProgressAt']).timestamp()>300:
                previous.update(status='stalled',reason='no_page_progress_for_300_seconds')
        except ValueError:
            previous.update(status='unknown',reason='invalid_heartbeat_timestamp')
    previous['coverage']=coverage();previous['checkedAt']=time.strftime('%Y-%m-%dT%H:%M:%S%z')
    atomic_json(path,previous)
    return previous


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workers',type=int,default=2);parser.add_argument('--limit-documents',type=int,default=0);parser.add_argument('--retry-failed',action='store_true');parser.add_argument('--status',action='store_true');args=parser.parse_args()
    if args.status:
        print(json.dumps(reconcile_status()));return
    lock=OUT/'ocr.lock'
    if lock.exists():
        old=json.loads(lock.read_text('utf8'))
        if alive(old.get('pid')):raise RuntimeError('OCR already running; refusing duplicate writer')
        lock.unlink()
    with lock.open('x',encoding='utf8') as f:json.dump({'pid':os.getpid()},f)
    stop=threading.Event();receipts=[];errors=[]
    state={'pid':os.getpid(),'runId':uuid.uuid4().hex,'status':'running','startedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'stages':[{'name':'ocr','status':'running'}]}
    update_lock=threading.Lock()
    def update():
        with update_lock:
            now=time.strftime('%Y-%m-%dT%H:%M:%S%z');current=coverage()
            if current!=state.get('coverage') or not state.get('lastProgressAt'):state['lastProgressAt']=now
            state['updatedAt']=now;state['coverage']=current;state['completedDocuments']=len(receipts);state['failedDocuments']=len(errors)
            from datetime import datetime
            if state['status'] in ('running','stalled'):
                stalled=time.time()-datetime.fromisoformat(state['lastProgressAt']).timestamp()>300
                state['status']='stalled' if stalled else 'running'
                state['reason']='no_page_progress_for_300_seconds' if stalled else None
                state['stages'][0]['status']=state['status']
            atomic_json(OUT/'pipeline-status.json',state)
            atomic_json(OUT/'ocr-run.json',{'updatedAt':now,'version':VERSION,'status':state['status'],'results':receipts.copy(),'errors':errors.copy()})
    def heartbeat():
        while not stop.wait(10):update()
    thread=None
    try:
        files=[]
        for p in (OUT/'documents').glob('*.json'):
            r=json.loads(p.read_text('utf8'))
            if args.retry_failed:
                changed=False
                for page in r['pages']:
                    if page['status']=='ocr_failed':page['status']='ocr_pending';changed=True
                if changed:atomic_json(p,r)
            if any(x['status']=='ocr_pending' for x in r['pages']):files.append((len(r['pages']),str(p)))
        files.sort();files=[p for _,p in files]
        if args.limit_documents:files=files[:args.limit_documents]
        update();thread=threading.Thread(target=heartbeat,daemon=True);thread.start()
        print(json.dumps({'documents':len(files),'workers':args.workers,'ocr':VERSION}),flush=True)
        for filename,future in batched_results(files,args.workers):
            try:
                result=future.result();receipts.append(result);print(json.dumps({'completed':len(receipts),**result}),flush=True)
            except Exception as e:
                error={'document':Path(filename).stem,'error':type(e).__name__};errors.append(error)
                print(json.dumps({'failed':error}),flush=True)
            update()
        stop.set();thread.join()
        counts=coverage()['pages'];state['status']='completed' if not counts.get('ocr_pending',0) and not counts.get('ocr_failed',0) and not counts.get('manual_review_required',0) and not errors else 'partial'
    except BaseException:
        state['status']='interrupted';raise
    finally:
        stop.set()
        if thread:thread.join()
        state['stages'][0]['status']=state['status'];update()
        atomic_json(OUT/'ocr-run.json',{'completed_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'version':VERSION,'status':state['status'],'results':receipts,'errors':errors})
        lock.unlink(missing_ok=True)


if __name__=='__main__':main()
