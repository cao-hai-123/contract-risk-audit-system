import crypto from 'node:crypto'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { createWorker } from 'tesseract.js'
import WordExtractor from 'word-extractor'

const imageTypes = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'])
const wordTypes = new Set(['doc', 'docx'])
const wpsTypes = new Set(['wps'])
export const supportedContractFileTypes = new Set(['pdf', ...wordTypes, ...wpsTypes, ...imageTypes])

export async function parseContractDocument(file, { ocrFactory = createWorker } = {}) {
  const fileName = normalizeUploadedFileName(file?.originalname || '未命名合同.pdf')
  const fileType = getFileType(fileName)
  const result = {
    fileName,
    fileType,
    supported: supportedContractFileTypes.has(fileType),
    parser: getParserName(fileType),
    text: '',
    paragraphs: [],
    ocr: {
      required: imageTypes.has(fileType),
      enabled: false,
      status: 'not_required',
      confidence: null
    },
    sourceHash: file?.buffer ? crypto.createHash('sha256').update(file.buffer).digest('hex') : '',
    pages: [],
    coverage: { complete: true, failedPages: [] },
    warnings: []
  }

  if (!file?.buffer?.length) {
    result.warnings.push('未接收到文件内容，已返回空解析结果。')
    return result
  }

  if (fileType === 'pdf') {
    await parsePdf(file.buffer, result, ocrFactory)
  } else if (fileType === 'docx') {
    await parseDocx(file.buffer, result)
  } else if (fileType === 'doc') {
    await parseDoc(file.buffer, result)
  } else if (wpsTypes.has(fileType)) {
    await parseWps(file.buffer, result)
  } else if (imageTypes.has(fileType)) {
    await parseImage(file.buffer, result, ocrFactory)
  } else {
    result.warnings.push(`暂不支持 .${fileType} 文件类型。`)
  }

  if (result.text.length > 2_000_000) throw Object.assign(new Error('合同正文超过 200 万字符，请按独立合同或附件拆分后重试。'), { status: 413 })
  result.paragraphs = preserveParagraphStructure(result.text, result)
  result.coverage.paragraphCount = result.paragraphs.length
  result.coverage.textCharacters = result.text.length
  return result
}

function normalizeUploadedFileName(originalName) {
  const name = String(originalName || '未命名合同.pdf')
  const repaired = Buffer.from(name, 'latin1').toString('utf8')

  if (cjkCount(repaired) > cjkCount(name) || (looksMojibake(name) && !looksMojibake(repaired))) {
    return repaired
  }

  return name
}

function cjkCount(value) {
  return (String(value).match(/[\u4e00-\u9fff]/g) || []).length
}

function looksMojibake(value) {
  return /[ÃÂÅåäæçèéê]/.test(String(value))
}

function getFileType(fileName) {
  return fileName.split('.').pop()?.toLowerCase() || 'pdf'
}

function getParserName(fileType) {
  if (fileType === 'pdf') return 'pdf-parse'
  if (fileType === 'docx') return 'mammoth'
  if (fileType === 'doc') return 'word-extractor'
  if (wpsTypes.has(fileType)) return 'word-extractor-wps-compatibility'
  if (imageTypes.has(fileType)) return 'ocr-adapter'
  return 'unsupported'
}

async function parsePdf(buffer, result, ocrFactory) {
  let parser, worker
  const scores = []
  try {
    parser = new PDFParse({ data: buffer })
    const data = await parser.getText({ pageJoiner: '' })
    if (data.total > 200) throw Object.assign(new Error('PDF 超过 200 页，请按独立合同或附件拆分后上传。'), { status: 413 })
    for (const page of data.pages) {
      const nativeText = normalizeText(page.text)
      let text = nativeText, method = 'text', status = 'success'
      try {
        const embedded = await parser.getImage({ partial: [page.num], imageBuffer: false, imageDataUrl: false })
        const hasImage = embedded.pages.some((p) => p.images.some((i) => i.width >= 120 && i.height >= 120))
        // Low-text pages and mixed text/image pages both receive OCR; no page markers are counted.
        if (letterCount(nativeText) < 20 || hasImage) {
          const screenshot = await parser.getScreenshot({ partial: [page.num], desiredWidth: 1800, imageBuffer: true, imageDataUrl: false })
          const image = screenshot.pages[0]?.data
          if (!image) throw new Error('page_render_failed')
          if (await isBlankPage(image)) {
            text = nativeText
            status = nativeText ? 'success' : 'blank'
          } else {
            result.ocr.required = true
            worker ||= await ocrFactory(ocrLanguages())
            const recognized = await recognizeWithDeadline(worker, image)
            const ocrText = normalizeText(recognized.data.text)
            if (letterCount(ocrText) < 5 && letterCount(nativeText) < 20) throw new Error('ocr_text_empty')
            text = mergePageText(nativeText, ocrText)
            method = nativeText ? 'text_and_ocr' : 'ocr'
            scores.push(Number(recognized.data.confidence || 0) / 100)
          }
        }
      } catch (error) {
        status = 'unreadable'
        result.coverage.complete = false
        result.coverage.failedPages.push(page.num)
        result.warnings.push('第 ' + page.num + ' 页未能完成文字/OCR 识别，请提供更清晰的页面后重试。')
      }
      result.pages.push({ page: page.num, text, method, status })
    }
    result.text = result.pages.map((page) => page.text).join('\n')
    if (result.ocr.required) {
      result.ocr = { required: true, enabled: scores.length > 0, status: result.coverage.complete ? 'success' : 'partial_failure', confidence: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null }
    }
  } catch (error) {
    if (error.status === 413) throw error
    result.coverage.complete = false
    result.warnings.push('PDF 无法读取，请确认文件未损坏或加密。')
  } finally {
    if (worker) await worker.terminate()
    if (parser) await parser.destroy()
  }
}

function letterCount(text) { return (String(text).match(/[\p{L}\p{N}]/gu) || []).length }

async function isBlankPage(buffer) {
  const image = await loadImage(buffer)
  const canvas = createCanvas(300, Math.max(1, Math.round(300 * image.height / image.width)))
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  // Only a uniformly white transparent/white page is treated as blank.
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 20 && Math.min(data[i], data[i + 1], data[i + 2]) < 240) return false
  return true
}

function mergePageText(nativeText, ocrText) {
  const key = (value) => value.replace(/\s/g, '')
  if (!nativeText) return ocrText
  if (!ocrText || key(nativeText).includes(key(ocrText))) return nativeText
  if (key(ocrText).includes(key(nativeText))) return ocrText
  const nativeLines = nativeText.split('\n')
  const extra = ocrText.split('\n').filter((line) => {
    const value = key(line)
    return value && !nativeLines.some((existing) => key(existing).includes(value))
  })
  return [...nativeLines, ...extra].join('\n')
}

async function recognizeWithDeadline(worker, image) {
  let timer
  try {
    return await Promise.race([
      worker.recognize(image),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ocr_timeout')), 90000) })
    ])
  } finally { clearTimeout(timer) }
}

async function parseDocx(buffer, result) {
  try {
    const data = await mammoth.extractRawText({ buffer })
    result.text = normalizeText(data.value)
  } catch (error) {
    result.warnings.push(`Word 解析失败：${error.message}`)
  }
}

async function parseDoc(buffer, result) {
  try {
    const extractor = new WordExtractor()
    const document = await extractor.extract(buffer)
    result.text = normalizeText(document.getBody())
    if (!result.text) result.warnings.push('未在 Word .doc 文件正文中识别到可解析文字。')
  } catch (error) {
    result.warnings.push(`Word .doc 解析失败：${error.message}`)
  }
}

async function parseWps(buffer, result) {
  try {
    const extractor = new WordExtractor()
    const document = await extractor.extract(buffer)
    result.text = normalizeText(document.getBody())
    if (!result.text) result.warnings.push('WPS 文件未提取到正文。请转换为 PDF、.doc 或 .docx 后重新建库。')
  } catch (error) {
    result.warnings.push(`WPS 兼容解析失败：${error.message}。请转换为 PDF、.doc 或 .docx 后重新建库。`)
  }
}

async function parseImage(buffer, result, ocrFactory) {
  const language = ocrLanguages()
  let worker

  try {
    worker = await ocrFactory(language)
    const ocrResult = await recognizeWithDeadline(worker, buffer)
    result.text = normalizeText(ocrResult.data.text)
    result.ocr = {
      required: true,
      enabled: true,
      status: 'success',
      confidence: Number((ocrResult.data.confidence / 100).toFixed(4))
    }
  } catch (error) {
    result.coverage.complete = false
    result.ocr = {
      required: true,
      enabled: false,
      status: 'ocr_error',
      confidence: null
    }
    result.warnings.push(`OCR 文字识别失败：${error.message}`)
  } finally {
    if (worker) await worker.terminate()
  }
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
}

function ocrLanguages() {
  const configured = process.env.OCR_LANG || 'eng+chi_sim'
  // The current WASM core misloads sublanguage data for chi_sim+eng; the reverse
  // order loads both dictionaries cleanly and is covered by real Chinese OCR tests.
  return configured === 'chi_sim+eng' ? 'eng+chi_sim' : configured
}

export function preserveParagraphStructure(text, result = {}) {
  const paragraphs = []
  let pageOffset = 0
  const spans = (result.pages || []).map((page) => {
    const span = { page: page.page, start: pageOffset, end: pageOffset + page.text.length }
    pageOffset = span.end + 1
    return span
  })
  for (const match of String(text || '').matchAll(/[^\n]+/g)) {
    const content = match[0].trim()
    if (!content) continue
    const charStart = match.index + match[0].indexOf(content)
    const charEnd = charStart + content.length
    paragraphs.push({
      id: 'P-' + (paragraphs.length + 1), index: paragraphs.length + 1,
      type: inferParagraphType(content), title: content.slice(0, 42), content,
      page: spans.find((page) => charStart >= page.start && charStart < page.end)?.page ?? null,
      charStart, charEnd, sourceHash: result.sourceHash || null
    })
  }
  return paragraphs
}

function inferParagraphType(content) {
  if (/^[一二三四五六七八九十]+[、.．]/.test(content)) return 'section'
  if (/^第[一二三四五六七八九十\d]+条/.test(content)) return 'clause'
  if (/甲方|乙方|合同双方|签订/.test(content)) return 'party'
  return 'paragraph'
}
