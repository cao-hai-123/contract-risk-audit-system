"""Synthetic Windows spawn regression: crosses the old 40-task stall threshold."""
import importlib.util, os
from pathlib import Path

def synthetic_job(value):
    if value == 17: raise ValueError('synthetic failure')
    return value, os.getpid()

if __name__ == '__main__':
    spec=importlib.util.spec_from_file_location('ocr_runner',Path(__file__).with_name('ocr-real-contract-corpus.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    completed=[];errors=[];first=set();last=set()
    for value,future in module.batched_results(list(range(70)),4,synthetic_job,None):
        try:
            result,pid=future.result();completed.append(result)
            (first if value<32 else last).add(pid)
        except ValueError:errors.append(value)
    assert sorted(completed)==[i for i in range(70) if i!=17]
    assert errors==[17]
    assert first.isdisjoint(last), 'pool must be replaced between batches'
    print('PASS: 70 tasks, 3 batches, 69 successes, 1 isolated failure, pool replacement')
