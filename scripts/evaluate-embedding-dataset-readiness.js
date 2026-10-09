import fs from 'node:fs/promises'
import path from 'node:path'

const archives = [
  { name: 'CUAD', file: 'cuad-main.zip', usableFor: '英文商业合同条款检索、条款类别映射与离线评测', limitation: '英文数据集；须先建立中英条款映射，不能直接作为中文风险标签。' },
  { name: 'LeCaRD', file: 'LeCaRD-main.zip', usableFor: '中文法律案例检索与法律问答检索排序评测', limitation: '法律案例检索数据，不是合同风险审核的直接真值。' }
]

const results = []
for (const archive of archives) {
  const target = path.resolve(process.cwd(), 'datasets/archive', archive.file)
  try {
    const stat = await fs.stat(target)
    results.push({ ...archive, status: stat.size > 0 ? 'available_for_mapped_evaluation' : 'empty_archive', bytes: stat.size })
  } catch {
    results.push({ ...archive, status: 'missing', bytes: 0 })
  }
}

if (results.some((item) => item.status !== 'available_for_mapped_evaluation')) throw new Error('公开数据集归档不完整，不能开展对应映射评测。')
console.log(JSON.stringify({ status: 'passed', results }))
