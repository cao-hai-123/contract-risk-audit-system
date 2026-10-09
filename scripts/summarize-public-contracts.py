"""Generate an auditable progress snapshot; downloaded is not completeness-certified."""
import importlib.util
import json
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('collect-public-contracts.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
validation_file = c.OUT / 'validation-results.json'
validation = json.loads(validation_file.read_text('utf8')) if validation_file.exists() else {'results': []}
checks = {r['file'].replace('\\', '/'): r for r in validation['results']}
notes = {
    '江西': '已检查的附件下载要求验证码；待人工交互。',
    '青海': '已检查的附件下载要求验证码；待人工交互。',
    '天津': 'HTTP 附件入口曾返回 403；2026-09-23 检查 HTTPS 正常下载入口返回验证码网页，未取得 PDF，待人工交互。',
    '甘肃': '官网请求返回 HTTP 412；尚未取得附件。',
    '内蒙古': '已查询合同公示并检查 60 条详情，未发现可直接下载的 PDF 链接；不代表全站没有附件。',
    '江苏': '已检查建设工程 50 条及交通、水利各 50 条合同公示，未取得 PDF；抽查原文按钮因原文地址为空而隐藏，不能据此断言全站没有附件。',
    '上海': '已定位采购合同栏目并检查 9 条详情；当前检查页面仅合同摘要，未发现原件附件，其他批次待核查。',
    '安徽': '已检查省平台政府采购及建设工程列表，尚未定位合同原件栏目；市级平台附件不能直接替代省级栏目覆盖。',
    '宁夏': '已保留 27 份候选 PDF；另有 4 份仅协议书、缺少所列合同条件或附件，已移至排除目录；其余仍待内容复核。',
    '浙江': '已检查的合同公示未取得 PDF；动态附件及其他批次待核查。',
    '重庆': '旧索引地址返回 404；当前合同详情已检查，尚未取得合同 PDF。',
    '黑龙江': '已检查 12 个合同页面，未发现 PDF 附件；其他栏目待核查。',
    '吉林': '已检查省级中心合同公告未取得 PDF；聚合查询接口返回 403。',
    '西藏': '已检查合同公示页面，尚未取得 PDF；动态内容待核查。',
    '山东': '已检查交易公开检索，尚未取得合同 PDF，需继续定位合同分类。',
    '福建': '公开网页可读，当前检索接口请求返回 400；接口适配未完成。',
}
rows, all_files = [], set()
for name, home in c.provinces().items():
    folder = c.OUT / name
    manifest = folder / 'manifest.json'
    state = json.loads(manifest.read_text('utf8')) if manifest.exists() else {'files': [], 'visited': [], 'failures': []}
    files = state['files']
    assert len(files) == len({x['file'] for x in files}), f'duplicate manifest names: {name}'
    actual = {str(p.relative_to(c.OUT)).replace('\\', '/') for p in folder.glob('*.pdf')}
    expected = {name + '/' + x['file'] for x in files}
    assert actual == expected, f'manifest/disk mismatch: {name}'
    all_files |= actual
    validated = [checks[p] for p in expected if p in checks]
    passed = sum(x.get('structural_check') == 'passed' for x in validated)
    note = '已取得目标数量；合同正文、签署页和所引用附件是否齐全仍需内容复核。' if len(files) >= 30 else notes.get(name, '已完成入口探测；合同附件采集或平台适配尚未完成。')
    rows.append({'province': name, 'official_home': home, 'target': 30, 'downloaded': len(files),
                 'structural_pass': passed, 'structural_unchecked': len(files)-len(validated),
                 'structural_failed': len(validated)-passed,
                 'completeness_certified': 0, 'download_gap': max(0, 30-len(files)),
                 'status': 'download_target_met_content_review_pending' if len(files)>=30 else 'partial' if files else 'no_pdf_collected',
                 'visited_count': len(state['visited']), 'note': note})
assert len(rows) == 31
assert all_files == {str(p.relative_to(c.OUT)).replace('\\', '/') for p in c.OUT.glob('*/*.pdf')}
snapshot = {'updated_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'target':930,
            'downloaded':len(all_files), 'completeness_certified':0,
            'validation_time':validation.get('checked_at'), 'provinces':rows}
excluded_path = c.OUT / 'excluded-files.json'
excluded = json.loads(excluded_path.read_text('utf8')) if excluded_path.exists() else []
snapshot['excluded_count'] = len(excluded)
snapshot['structural_pass'] = sum(r['structural_pass'] for r in rows)
snapshot['download_gap'] = sum(r['download_gap'] for r in rows)
(c.OUT/'collection-status.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),'utf8')
lines=['# 省级平台公开合同采集进度', '', f'更新时间：{snapshot["updated_at"]}', '',
       f'目标 31 个省级平台、每个平台约 30 份，共约 930 份。目前保存 {len(all_files)} 份 PDF。', '',
       '**下载成功和文件可解析，不等于合同内容完整。当前没有文件被认证为正文及全部附件齐全。**', '',
       f'当前保留文件结构校验通过 {snapshot["structural_pass"]} 份，下载数量缺口 {snapshot["download_gap"]} 份。另有 {len(excluded)} 份不符合要求的原件保存在 `_excluded/`，不计入下载数量；排除理由见 `excluded-files.json`。', '',
       '原始 PDF 按省份保存；各目录 manifest.json 记录公告、附件地址、SHA-256、字节数和页数。validation-results.json 记录逐页解析与渲染结果。原件未改写。', '',
       '|省级平台|已下载|结构校验通过|下载缺口|当前情况|','|---|---:|---:|---:|---|']
for r in rows:
    lines.append(f'|{r["province"]}|{r["downloaded"]}|{r["structural_pass"]}|{r["download_gap"]}|{r["note"]}|')
lines += ['', '## 核验边界', '',
          '- 结构校验包括文件哈希、字节数、双解析器页数一致性和逐页渲染。原文件内部格式警告不自动视为损坏。',
          '- 全文关键词仅用于筛查；扫描件、短篇协议、单独附件需要人工内容复核。',
          '- 尚未将公告摘要、网页另存 PDF 或未成功下载的链接计入 PDF 数量。',
          '- 验证码、访问拒绝和未适配栏目保留为缺口；没有据此断言整个平台不存在合同。',
          '- 用户明确指定 matchreal 为存储位置；本批次未导入风险库、未传给任何云端模型。', '']
(c.OUT/'README.md').write_text('\n'.join(lines),'utf8')
print(json.dumps({'downloaded':len(all_files),'platforms_at_30':sum(r['downloaded']>=30 for r in rows),
                  'structural_pass':sum(r['structural_pass'] for r in rows),'unchecked':sum(r['structural_unchecked'] for r in rows),
                  'manifest_disk_check':'passed','province_count':len(rows)},ensure_ascii=False))
