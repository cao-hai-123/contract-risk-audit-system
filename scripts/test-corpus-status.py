import importlib.util, tempfile, json, os
from pathlib import Path
spec=importlib.util.spec_from_file_location('ocr_runner',Path(__file__).with_name('ocr-real-contract-corpus.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='ocr-status-test-') as folder:
    module.OUT=Path(folder);(module.OUT/'documents').mkdir()
    module.atomic_json(module.OUT/'documents'/'synthetic.json',{'status':'ocr_pending','pages':[{'status':'text_extracted'},{'status':'ocr_pending'}]})
    module.atomic_json(module.OUT/'pipeline-status.json',{'pid':99999999,'status':'running','stages':[{'status':'running'}]})
    result=module.reconcile_status()
    assert result['status']=='interrupted'
    assert result['stages'][0]['status']=='interrupted'
    assert result['coverage']['pages']['ocr_pending']==1
    assert module.alive(os.getpid())
    assert not module.alive(-1)
    module.atomic_json(module.OUT/'pipeline-status.json',{'pid':os.getpid(),'status':'running'})
    assert module.reconcile_status()['status']=='running'
    module.atomic_json(module.OUT/'pipeline-status.json',{'pid':os.getpid(),'status':'running','updatedAt':'2000-01-01T00:00:00+08:00'})
    assert module.reconcile_status()['status']=='stalled'
    import time
    module.atomic_json(module.OUT/'pipeline-status.json',{'pid':os.getpid(),'status':'running','updatedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'lastProgressAt':'2000-01-01T00:00:00+08:00'})
    assert module.reconcile_status()['reason']=='no_page_progress_for_300_seconds'
print('PASS: stale process reconciliation, live process preservation, atomic checkpoint, page coverage')
