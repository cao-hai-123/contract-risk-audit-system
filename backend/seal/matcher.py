import cv2
import numpy as np


def compare(query, reference):
    result = dict(score=0., goodMatches=0, inlierCount=0, inlierRatio=0., coverage=0.,
                  queryCoverage=0., referenceCoverage=0., reason='insufficient_features')
    if min(len(query['descriptors']), len(reference['descriptors'])) < 12:
        return result, []
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(query['descriptors'], reference['descriptors'], k=2)
    good, seen = [], set()
    for pair in pairs:
        if len(pair) != 2:
            continue
        m, n = pair
        if m.distance < .75 * n.distance and m.trainIdx not in seen:
            good.append(m)
            seen.add(m.trainIdx)
    result['goodMatches'] = len(good)
    if len(good) < 8:
        result['reason'] = 'insufficient_correspondences'
        return result, []
    src = np.float32([query['points'][m.queryIdx] for m in good])
    dst = np.float32([reference['points'][m.trainIdx] for m in good])
    cv2.setRNGSeed(20260924)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4., maxIters=2000, confidence=.995)
    if H is None or mask is None or not np.isfinite(H).all():
        result['reason'] = 'geometry_failed'
        return result, []
    inside = mask.ravel().astype(bool)
    count = int(inside.sum())
    result.update(inlierCount=count, inlierRatio=count / len(good))
    if count < 8:
        result['reason'] = 'insufficient_inliers'
        return result, []
    h, w = query['shape']
    rh, rw = reference['shape']
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    projected = cv2.perspectiveTransform(corners, H)
    area = abs(cv2.contourArea(projected))
    if not np.isfinite(projected).all() or not cv2.isContourConvex(projected) or not .05 < area / (rw * rh) < 20:
        result['reason'] = 'invalid_projection'
        return result, []
    qc = float(cv2.contourArea(cv2.convexHull(src[inside])) / (w * h))
    rc = float(cv2.contourArea(cv2.convexHull(dst[inside])) / (rw * rh))
    coverage = min(1., np.sqrt(max(0., qc * rc)) / .25)
    result.update(queryCoverage=qc, referenceCoverage=rc, coverage=float(coverage))
    if min(qc, rc) < .025 or result['inlierRatio'] < .3:
        result['reason'] = 'localized_or_inconsistent'
        return result, []
    projected_points = cv2.perspectiveTransform(src[inside].reshape(-1, 1, 2), H).reshape(-1, 2)
    result['reprojectionError'] = round(float(np.linalg.norm(projected_points - dst[inside], axis=1).mean()), 3)
    score = 100 * (.15 * min(1, len(good) / 60) + .30 * min(1, count / 40)
                   + .30 * result['inlierRatio'] + .25 * coverage)
    # Shared circles/stars/text can yield many perfect local matches in different
    # seals. Require meaningful support relative to *all* detected features.
    support = count / min(len(query['points']), len(reference['points']))
    result['featureSupportRatio'] = round(support, 4)
    score *= min(1., support / .30)
    result.update(score=round(score * float(reference['quality']), 2), reason='geometry_verified')
    lines = [(src[i].tolist(), dst[i].tolist()) for i in range(len(good)) if inside[i]][:100]
    return result, lines


def aggregate(groups, query, thresholds=None):
    thresholds = thresholds or dict(match=80, possible=65, gap=10)
    ranked = []
    for group in groups:
        unique = {}
        for sample in group['samples']:
            key = sample['sourceHash']
            if key not in unique or sample['score'] > unique[key]['score']:
                unique[key] = sample
        top = sorted(unique.values(), key=lambda x: x['score'], reverse=True)[:3]
        weights = [.5, .3, .2][:len(top)]
        score = sum(s['score'] * w for s, w in zip(top, weights)) / sum(weights) if weights else 0
        ranked.append(dict(id=group['id'], label=group['label'], sealName=group['sealName'],
                           companyName=group['companyName'], score=round(score, 2), matchedSamples=top,
                           independentSamples=len(unique)))
    ranked.sort(key=lambda x: (-x['score'], str(x['id'])))
    first = ranked[0] if ranked else None
    second = ranked[1]['score'] if len(ranked) > 1 else None
    gap = round(first['score'] - second, 2) if second is not None else None
    status, reason = 'UNCERTAIN', 'insufficient_library'
    assessable = (first is not None and len(ranked) >= 2 and all(g['independentSamples'] >= 2 for g in ranked)
                  and float(query['quality']) >= .5 and len(query['points']) >= 30)
    if assessable:
        if gap < thresholds['gap']:
            reason = 'ambiguous_identity'
        elif first['score'] >= thresholds['match'] and gap >= thresholds['gap'] and str(query['channel']) == 'red':
            status, reason = 'MATCH', 'historical_visual_match'
        elif first['score'] >= thresholds['possible'] and gap >= thresholds['gap']:
            status, reason = 'POSSIBLE_MATCH', 'review_required'
        else:
            status, reason = 'NOT_MATCH', 'not_found_in_current_library'
    elif float(query['quality']) < .5 or len(query['points']) < 30:
        reason = 'query_quality_insufficient'
    return dict(status=status, reason=reason, bestMatch=first, top1Score=first['score'] if first else None,
                secondBestScore=second, scoreGap=gap, ranking=ranked[:10], thresholds=thresholds,
                calibration='unvalidated', provider='OpenCV ORB + BFMatcher + RANSAC',
                warning='图像匹配不能证明物理印章、签署行为或合同真实性；分数不是概率，阈值尚待人工标注验证。')
