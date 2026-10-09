import os
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'runtime/seal'),str(ROOT/'backend/seal')]
import unittest
import json
import tempfile
import zipfile
import cv2
import numpy as np
from preprocess import prepare, save_features, load_features
from matcher import compare, aggregate
from worker import candidates, write_image, render, crop


def stamp(seed=12):
    im=np.full((420,420,3),255,np.uint8)
    color=(35,35,205)
    cv2.circle(im,(210,210),170,color,4)
    cv2.circle(im,(210,210),145,color,2)
    cv2.putText(im,'DEMO ONLY',(85,205),cv2.FONT_HERSHEY_SIMPLEX,.85,color,2)
    cv2.putText(im,str(seed),(150,260),cv2.FONT_HERSHEY_SIMPLEX,1.5,color,3)
    rng=np.random.default_rng(seed)
    for _ in range(65):
        x,y=rng.integers(85,335,2)
        cv2.line(im,(int(x),int(y)),(int(x+12),int(y+7)),color,2)
    return im


def rotate(im, angle):
    return cv2.warpAffine(im,cv2.getRotationMatrix2D((210,210),angle,1),(420,420),borderValue=(255,255,255))


class VisualTests(unittest.TestCase):
    def test_transformations_and_impostor(self):
        a=stamp(); ref=prepare(a)
        occluded=a.copy();cv2.putText(occluded,'BLACK TEXT',(55,235),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),3)
        partial=a.copy();partial[:,:100]=255
        pale=cv2.addWeighted(a,.55,np.full_like(a,255),.45,0)
        variants={'original':a,'rotation':rotate(a,33),'scale':cv2.resize(a,(300,300)),
                  'pale':pale,'occlusion':occluded,'partial':partial,'blur':cv2.GaussianBlur(a,(5,5),1)}
        results={name:compare(prepare(image),ref)[0] for name,image in variants.items()}
        different=compare(prepare(stamp(87)),ref)[0]
        self.assertLess(different['score'],65,'shared rings/text must not support identity')
        self.assertGreater(results['original']['score'],90)
        for name in ('rotation','scale','pale','occlusion','partial','blur'):
            self.assertEqual(results[name]['reason'],'geometry_verified',name)
            self.assertGreater(results[name]['score'],different['score'],name)
        directory=ROOT/'tmp/seal-synthetic'
        directory.mkdir(parents=True,exist_ok=True)
        for name,image in {'a':a,'a2':rotate(a,11),'b':stamp(87),'b2':rotate(stamp(87),17),'query':rotate(a,33)}.items():
            write_image(directory/(name+'.png'),image)
        (directory/'metrics.json').write_text(json.dumps({'variants':results,'different':different},indent=2),encoding='utf-8')

    def test_no_features_and_degenerate(self):
        blank=prepare(np.full((200,200,3),255,np.uint8))
        self.assertEqual(compare(blank,prepare(stamp()))[0]['score'],0)
        self.assertEqual(aggregate([],blank)['status'],'UNCERTAIN')
        data=prepare(stamp())
        data['points'][:,1]=20
        self.assertNotEqual(compare(data,data)[0]['reason'],'geometry_verified')

    def test_gray_and_no_red_candidates(self):
        gray=cv2.cvtColor(cv2.cvtColor(stamp(),cv2.COLOR_BGR2GRAY),cv2.COLOR_GRAY2BGR)
        self.assertEqual(prepare(gray)['channel'],'gray')
        self.assertEqual(candidates(gray),[])
        self.assertGreater(len(prepare(gray)['points']),30)

    def test_topk_normalization_duplicates_ambiguity(self):
        query=prepare(stamp())
        def group(id,scores):
            return dict(id=id,label=str(id),sealName='DEMO',companyName='SIMULATED',samples=[dict(id=i,sourceHash=str(i),score=s) for i,s in enumerate(scores)])
        result=aggregate([group(1,[100,80]),group(2,[20,10])],query)
        self.assertEqual(result['top1Score'],92.5)
        self.assertEqual(result['status'],'MATCH')
        self.assertEqual(aggregate([group(1,[100])],query)['status'],'UNCERTAIN')
        self.assertEqual(aggregate([group(1,[90,90]),group(2,[88,88])],query)['status'],'UNCERTAIN')
        self.assertEqual(aggregate([group(1,[40,40]),group(2,[10,10])],query)['status'],'NOT_MATCH')
        duplicate=group(1,[100,100]);duplicate['samples'][1]['sourceHash']='0'
        self.assertEqual(aggregate([duplicate,group(2,[0,0])],query)['status'],'UNCERTAIN')

    def test_feature_cache_and_manual_roi(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tmp') as tmp:
            p=Path(tmp);data=prepare(stamp());save_features(data,p/'features.npz')
            loaded=load_features(p/'features.npz')
            self.assertEqual(compare(data,loaded)[0]['score'],100)
            write_image(p/'page.png',stamp())
            output=crop(dict(pagePath=str(p/'page.png'),bbox=dict(x=0,y=0,width=1,height=1),output=str(p/'crop')))
            self.assertGreater(output['featureCount'],30)
            with self.assertRaises(ValueError):crop(dict(pagePath=str(p/'page.png'),bbox=dict(x=-1,y=0,width=1,height=1),output=str(p/'bad')))

    def test_bad_file_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tmp') as tmp:
            p=Path(tmp);(p/'bad.pdf').write_text('not a pdf')
            with self.assertRaises(Exception):render(dict(source=str(p/'bad.pdf'),directory=tmp,extension='.pdf'))

    def test_external_docx_content_rejected_before_conversion(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'tmp') as tmp:
            p=Path(tmp)/'external.docx'
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('[Content_Types].xml','<Types/>')
                z.writestr('word/document.xml','<document/>')
                z.writestr('word/_rels/document.xml.rels','<Relationships><Relationship TargetMode="External" Type="image" Target="https://example.invalid/private"/></Relationships>')
            with self.assertRaisesRegex(ValueError,'docx_external_content'):
                render(dict(source=str(p),directory=tmp,extension='.docx'))


if __name__=='__main__':
    unittest.main()
