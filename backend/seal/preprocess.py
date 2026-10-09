"""Local visual processing only. No OCR, reconstruction or cloud transmission."""
import cv2
import numpy as np
import json
import hashlib
from pathlib import Path

CONFIG = json.loads(Path(__file__).with_name('config.json').read_text(encoding='utf-8'))
VERSION = CONFIG['version'] + '-' + hashlib.sha256(json.dumps({'hsv':CONFIG['hsv']},sort_keys=True).encode()).hexdigest()[:12]


def red_mask(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    c = CONFIG['hsv']
    return (cv2.inRange(hsv, (0, c['saturationMin'], c['valueMin']), (c['hueLowMax'],255,255)) |
            cv2.inRange(hsv, (c['hueHighMin'], c['saturationMin'], c['valueMin']), (179,255,255)))


def prepare(image):
    h, w = image.shape[:2]
    if min(h, w) < 24:
        raise ValueError('roi_too_small')
    scale = min(640 / max(h, w), 2.0)
    image = cv2.resize(image, (round(w * scale), round(h * scale)))
    mask = red_mask(image)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    red_ratio = float(np.count_nonzero(mask) / mask.size)
    # Red-channel contrast suppresses black overprinted body text without inventing detail.
    if red_ratio >= .003:
        b, g, r = cv2.split(image.astype(np.int16))
        strength = np.clip((r - np.maximum(b, g)) * 2, 0, 255).astype(np.uint8)
        feature_image = 255 - strength
        feature_mask = cv2.dilate(mask, np.ones((9, 9), np.uint8))
        channel = 'red'
    else:
        feature_image, feature_mask, channel = gray, None, 'gray'
    orb = cv2.ORB_create(nfeatures=1600, scaleFactor=1.2, nlevels=8, edgeThreshold=12, fastThreshold=10)
    keypoints, descriptors = orb.detectAndCompute(feature_image, feature_mask)
    points = np.array([k.pt for k in keypoints], dtype=np.float32).reshape(-1, 2)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    quality = min(1., min(h, w) / 120) * min(1., max(.15, sharpness / 90))
    quality *= min(1., len(points) / 60)
    return dict(image=image, mask=mask, gray=gray, points=points,
                descriptors=descriptors if descriptors is not None else np.empty((0, 32), np.uint8),
                shape=np.array(gray.shape), quality=round(quality, 4), channel=channel,
                metrics=dict(width=w, height=h, redRatio=red_ratio, sharpness=sharpness, featureCount=len(points)))


def save_features(data, filename):
    np.savez_compressed(filename, points=data['points'], descriptors=data['descriptors'],
                        shape=data['shape'], quality=data['quality'], channel=data['channel'], version=VERSION)


def load_features(filename):
    with np.load(filename, allow_pickle=False) as a:
        if str(a['version']) != VERSION:
            raise ValueError('feature_version_mismatch')
        return {k: a[k].copy() for k in a.files}
