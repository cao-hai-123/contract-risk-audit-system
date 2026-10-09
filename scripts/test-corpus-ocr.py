"""Synthetic Chinese scan recognition tests; never claims real-contract OCR accuracy."""
import sys,json,time,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime/corpus-ocr'))
from rapidocr_onnxruntime import RapidOCR
from PIL import Image,ImageDraw,ImageFont,ImageFilter

def distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nxt=[i]
        for j,y in enumerate(b,1):nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nxt
    return row[-1]

engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1)
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',32)
cases=[
 ['采购合同','合同金额为人民币123456.78元。','验收合格后五个工作日内支付价款。'],
 ['违约责任','逾期交付应支付违约金，每日按合同总价的0.05%计算。','不合格产品应在七日内更换或退货。'],
 ['合同变更与解除','任何变更须经双方书面同意。','解除后应结清价款并返还资料。'],
 ['争议解决','双方应先协商解决争议。','协商不成向约定的人民法院起诉。']
]
out=ROOT/'tmp/real-corpus-evaluation/ocr';out.mkdir(parents=True,exist_ok=True)
results=[]
for i,lines in enumerate(cases):
    image=Image.new('RGB',(1250,300),'white');draw=ImageDraw.Draw(image)
    for j,line in enumerate(lines):draw.text((30,30+j*70),line,font=font,fill=(35,35,35))
    if i==1:image=image.filter(ImageFilter.GaussianBlur(.4))
    image.save(out/(str(i)+'.png'));start=time.monotonic();recognized,_=engine(image)
    text=''.join(r[1] for r in recognized or [])
    norm=lambda s:re.sub(r'\s+','',s)
    expected=norm(''.join(lines));actual=norm(text);cer=distance(expected,actual)/len(expected)
    numbers=re.findall(r'\d+(?:\.\d+)?%?',expected)
    results.append({'case':i,'cer':cer,'numbers_preserved':all(n in actual for n in numbers),'seconds':round(time.monotonic()-start,2),'passed':cer<=.1 and all(n in actual for n in numbers)})
receipt={'scope':'four_synthetic_printed_Chinese_scans_not_real_document_accuracy','results':results,'passed':all(r['passed'] for r in results)}
(ROOT/'data/real-contract-corpus/evaluation/ocr-smoke.json').write_text(json.dumps(receipt,indent=2),'utf8');print(json.dumps(receipt))
sys.exit(0 if receipt['passed'] else 1)
