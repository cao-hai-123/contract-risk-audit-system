"""Foreground resumable batch driver; serializes OCR and Qwen to avoid memory contention."""
import sys,os,json,time,subprocess,shutil,collections
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'data/real-contract-corpus'
NODE=shutil.which('node')

def counts():
    documents=[]
    for p in (OUT/'documents').glob('*.json'):
        documents.append(json.loads(p.read_text('utf8')))
    return {'documents':dict(collections.Counter(d['status'] for d in documents)),
            'pages':dict(collections.Counter(p['status'] for d in documents for p in d['pages']))}

def save(state):
    state['updatedAt']=time.strftime('%Y-%m-%dT%H:%M:%S%z')
    state['coverage']=counts()
    temporary=OUT/'pipeline-status.tmp';temporary.write_text(json.dumps(state,ensure_ascii=False,indent=2),'utf8');temporary.replace(OUT/'pipeline-status.json')

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    # Retained lock blocks accidental concurrent writers; interrupted runs require checking the stored PID first.
    lock=OUT/'pipeline.lock'
    with lock.open('x',encoding='utf8') as f:json.dump({'pid':os.getpid(),'startedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')},f)
    state={'pid':os.getpid(),'status':'running','stages':[]}
    commands=[
      ('ocr',[sys.executable,'scripts/ocr-real-contract-corpus.py','--workers','2','--retry-failed']),
      ('refresh_inventory',[sys.executable,'scripts/prepare-real-contract-corpus.py']),
      ('publish_candidates',[NODE,'--no-experimental-webstorage','scripts/build-real-contract-library.js','--publish']),
      ('qwen_summary',[NODE,'--no-experimental-webstorage','scripts/summarize-real-contract-library.js']),
      ('diagnostic_evaluation',[NODE,'--no-experimental-webstorage','scripts/evaluate-real-corpus-impact.js']),
      ('holdout_consistency',[NODE,'--no-experimental-webstorage','scripts/evaluate-real-corpus-holdout.js']),
      ('file_integrity',[NODE,'--no-experimental-webstorage','scripts/test-real-corpus-integrity.js']),
      ('mysql_integrity',[NODE,'--no-experimental-webstorage','scripts/test-real-corpus-integrity.js','--mysql']),
      ('regressions',[NODE,'--no-experimental-webstorage','--test','--test-isolation=none','tests/real-contract-corpus.test.js','tests/priority-repairs.test.js','tests/performance-library-famie.test.js']),
      ('report',[sys.executable,'scripts/report-real-contract-library.py'])]
    child=None
    try:
      for name,command in commands:
        entry={'name':name,'status':'running','startedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')};state['stages'].append(entry);save(state)
        with (OUT/(name+'-pipeline.log')).open('w',encoding='utf8') as log:
          child=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
          while child.poll() is None:
            time.sleep(15);save(state)
          entry.update(status='passed' if child.returncode==0 else 'failed',exitCode=child.returncode)
        save(state)
        print(json.dumps(entry),flush=True)
      state['status']='finished_with_review_pending' if all(s['status']=='passed' for s in state['stages']) else 'finished_with_failures'
    finally:
      if child and child.poll() is None:child.terminate();state['status']='interrupted'
      save(state);lock.unlink(missing_ok=True)

if __name__=='__main__':main()
