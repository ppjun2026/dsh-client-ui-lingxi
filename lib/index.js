/**
 * 灵犀（Lingxi）— Host 侧入口。
 *
 * 架构：文件即真相（file-as-source-of-truth）。数据存在一个 JSON 文件里，
 * Host 每次 GET 都重新读文件、每次 POST 都读文件→应用 action→原子写回。
 * 因此浏览器网页通道（经本路由）与对话通道（AI 直接读写同一文件）天然共享
 * 同一份数据，互不缓存、不会漂移。
 *
 * 本插件不依赖 schemastery / settings / React，零构建工具链，直接手写 ESM。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['webServer', 'systemPrompt']

const SCHEMA_VERSION = 1
export const API_PREFIX = '/api/lingxi'

/** 想法状态机：收集 → 孵化 → 计划 → 立项；合并 / 归档。 */
export const IDEA_STATUSES = ['seed', 'incubating', 'planning', 'project', 'merged', 'archived']
const TASK_STATUSES = ['todo', 'doing', 'done']
const RELATED_STRENGTHS = ['high', 'medium', 'low']
const SCORE_KEYS = ['novelty', 'feasibility', 'value', 'overall']

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function now() {
  return Date.now()
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `lingxi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value) {
  return typeof value === 'string'
}

function emptyDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    ideas: [],
    projects: [],
    merges: [],
  }
}

function resolveDataFile(config) {
  const fromConfig = config && typeof config.dataFile === 'string' ? config.dataFile.trim() : ''
  if (fromConfig !== '') return isAbsolute(fromConfig) ? fromConfig : join(process.cwd(), fromConfig)
  const fromEnv = process.env.LINGXI_DATA_FILE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return isAbsolute(fromEnv.trim()) ? fromEnv.trim() : join(process.cwd(), fromEnv.trim())
  }
  return join(homedir(), '.dsh', 'lingxi', 'lingxi-data.json')
}

// ─────────────────────────────────────────────────────────────────────────────
// Loopback 守卫（同源 + 回环，防止非本机页面调用本 API）
// ─────────────────────────────────────────────────────────────────────────────

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

function isTrustedRequest(req) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据读取与原子写
// ─────────────────────────────────────────────────────────────────────────────

function loadDocument(dataFile) {
  if (!existsSync(dataFile)) return emptyDocument()
  try {
    const parsed = JSON.parse(readFileSync(dataFile, 'utf8'))
    if (isRecord(parsed) && parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.ideas)) {
      // 归一化，确保结构完整。
      return normalizeDocument(parsed)
    }
    // 版本不符或结构异常：隔离损坏文件，返回空文档。
    quarantine(dataFile, 'unsupported schema')
    return emptyDocument()
  } catch (error) {
    quarantine(dataFile, error instanceof Error ? error.message : String(error))
    return emptyDocument()
  }
}

function quarantine(dataFile, reason) {
  try {
    const backup = `${dataFile}.corrupt-${now()}-${process.pid}`
    renameSync(dataFile, backup)
    console.error(`[dsh-lingxi] 数据文件已隔离到 ${backup}：${reason}`)
  } catch {
    // 隔离失败不阻断启动。
  }
}

function saveDocument(dataFile, doc) {
  mkdirSync(dirname(dataFile), { recursive: true })
  const tmp = `${dataFile}.tmp-${process.pid}`
  let fd
  try {
    fd = openSync(tmp, 'w')
    writeFileSync(fd, JSON.stringify(doc, null, 2), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, dataFile)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* noop */ } }
    try { if (existsSync(tmp)) { /* 保留 tmp 供排查 */ } } catch { /* noop */ }
    throw error
  }
}

function normalizeDocument(doc) {
  const out = emptyDocument()
  out.revision = Number.isSafeInteger(doc.revision) && doc.revision >= 0 ? doc.revision : 0
  out.ideas = Array.isArray(doc.ideas) ? doc.ideas.map(normalizeIdea).filter(x => x !== null) : []
  out.projects = Array.isArray(doc.projects) ? doc.projects.map(normalizeProject).filter(x => x !== null) : []
  out.merges = Array.isArray(doc.merges) ? doc.merges.map(normalizeMerge).filter(x => x !== null) : []
  return out
}

function normalizeIdea(value) {
  if (!isRecord(value) || !isString(value.id)) return null
  return {
    id: value.id,
    raw: isString(value.raw) ? value.raw : '',
    title: isString(value.title) ? value.title : '',
    status: IDEA_STATUSES.includes(value.status) ? value.status : 'seed',
    scores: normalizeScores(value.scores),
    analysis: isString(value.analysis) ? value.analysis : '',
    tags: Array.isArray(value.tags) ? value.tags.filter(isString) : [],
    domain: isString(value.domain) ? value.domain : '',
    related: Array.isArray(value.related) ? value.related.filter(isRecord).map(r => ({
      ideaId: isString(r.ideaId) ? r.ideaId : '',
      strength: RELATED_STRENGTHS.includes(r.strength) ? r.strength : 'medium',
      reason: isString(r.reason) ? r.reason : '',
    })).filter(r => r.ideaId !== '') : [],
    notes: Array.isArray(value.notes) ? value.notes.filter(isRecord).map(n => ({
      id: isString(n.id) ? n.id : uuid(),
      text: isString(n.text) ? n.text : '',
      createdAt: Number.isFinite(n.createdAt) ? n.createdAt : now(),
    })) : [],
    mergedInto: isString(value.mergedInto) ? value.mergedInto : null,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now(),
  }
}

function normalizeScores(value) {
  const scores = { novelty: 0, feasibility: 0, value: 0, overall: 0 }
  if (isRecord(value)) {
    for (const key of SCORE_KEYS) {
      if (Number.isFinite(value[key])) scores[key] = Math.max(0, Math.min(100, Math.round(value[key])))
    }
  }
  return scores
}

function normalizeProject(value) {
  if (!isRecord(value) || !isString(value.id)) return null
  return {
    id: value.id,
    ideaId: isString(value.ideaId) ? value.ideaId : null,
    name: isString(value.name) ? value.name : '',
    goal: isString(value.goal) ? value.goal : '',
    tasks: Array.isArray(value.tasks) ? value.tasks.filter(isRecord).map(t => ({
      id: isString(t.id) ? t.id : uuid(),
      title: isString(t.title) ? t.title : '',
      status: TASK_STATUSES.includes(t.status) ? t.status : 'todo',
    })).filter(t => t.id !== '') : [],
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now(),
  }
}

function normalizeMerge(value) {
  if (!isRecord(value) || !isString(value.intoId) || !isString(value.fromId)) return null
  return {
    id: isString(value.id) ? value.id : uuid(),
    intoId: value.intoId,
    fromId: value.fromId,
    reason: isString(value.reason) ? value.reason : '',
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action 应用
// ─────────────────────────────────────────────────────────────────────────────

function requireIdea(doc, ideaId) {
  const idea = doc.ideas.find(i => i.id === ideaId)
  if (idea === undefined) throw new Error('想法不存在')
  return idea
}

function requireProject(doc, projectId) {
  const project = doc.projects.find(p => p.id === projectId)
  if (project === undefined) throw new Error('项目不存在')
  return project
}

function patchIdea(idea, patch, ts) {
  if (isString(patch.raw)) idea.raw = patch.raw
  if (isString(patch.title)) idea.title = patch.title
  if (IDEA_STATUSES.includes(patch.status)) idea.status = patch.status
  if (isRecord(patch.scores)) {
    for (const key of SCORE_KEYS) {
      if (Number.isFinite(patch.scores[key])) idea.scores[key] = Math.max(0, Math.min(100, Math.round(patch.scores[key])))
    }
  }
  if (isString(patch.analysis)) idea.analysis = patch.analysis
  if (Array.isArray(patch.tags) && patch.tags.every(isString)) idea.tags = [...new Set(patch.tags)]
  if (isString(patch.domain)) idea.domain = patch.domain
  if (Array.isArray(patch.related)) {
    idea.related = patch.related.filter(isRecord).map(r => ({
      ideaId: isString(r.ideaId) ? r.ideaId : '',
      strength: RELATED_STRENGTHS.includes(r.strength) ? r.strength : 'medium',
      reason: isString(r.reason) ? r.reason : '',
    })).filter(r => r.ideaId !== '')
  }
  if (patch.mergedInto === null || isString(patch.mergedInto)) idea.mergedInto = patch.mergedInto
  idea.updatedAt = ts
}

function applyAction(doc, action) {
  const ts = now()
  switch (action.kind) {
    case 'create-idea': {
      if (!isString(action.id) || !isRecord(action.input) || !isString(action.input.raw)) throw new Error('create-idea 参数无效')
      if (doc.ideas.some(i => i.id === action.id)) throw new Error('想法 id 已存在')
      const input = action.input
      const idea = normalizeIdea({
        id: action.id,
        raw: input.raw,
        title: input.title,
        status: input.status,
        scores: input.scores,
        analysis: input.analysis,
        tags: input.tags,
        domain: input.domain,
        related: input.related,
        notes: input.notes,
        createdAt: ts,
        updatedAt: ts,
      })
      doc.ideas.push(idea)
      break
    }
    case 'update-idea': {
      if (!isString(action.ideaId) || !isRecord(action.patch)) throw new Error('update-idea 参数无效')
      const idea = requireIdea(doc, action.ideaId)
      patchIdea(idea, action.patch, ts)
      break
    }
    case 'delete-idea': {
      if (!isString(action.ideaId)) throw new Error('delete-idea 参数无效')
      const index = doc.ideas.findIndex(i => i.id === action.ideaId)
      if (index === -1) throw new Error('想法不存在')
      doc.ideas.splice(index, 1)
      // 清理其它想法里指向它的关联边。
      for (const idea of doc.ideas) {
        idea.related = idea.related.filter(r => r.ideaId !== action.ideaId)
      }
      break
    }
    case 'add-note': {
      if (!isString(action.ideaId) || !isString(action.text)) throw new Error('add-note 参数无效')
      const idea = requireIdea(doc, action.ideaId)
      idea.notes.push({ id: uuid(), text: action.text, createdAt: ts })
      idea.updatedAt = ts
      break
    }
    case 'merge-ideas': {
      if (!isString(action.intoId) || !isString(action.fromId)) throw new Error('merge-ideas 参数无效')
      if (action.intoId === action.fromId) throw new Error('不能与自身合并')
      const into = requireIdea(doc, action.intoId)
      const from = requireIdea(doc, action.fromId)
      if (from.status === 'merged') throw new Error('该想法已被合并')
      // 合并标签、notes、关联。
      into.tags = [...new Set([...into.tags, ...from.tags])]
      into.notes = [...into.notes, ...from.notes.map(n => ({ ...n, text: `〔来自合并：${from.title || from.raw.slice(0, 20)}〕 ${n.text}` }))]
      const intoRelated = new Set(into.related.map(r => r.ideaId))
      for (const r of from.related) {
        if (r.ideaId !== into.id && !intoRelated.has(r.ideaId)) {
          into.related.push(r)
          intoRelated.add(r.ideaId)
        }
      }
      const reason = isString(action.reason) && action.reason !== '' ? action.reason : '关联性高，自动/手动合并'
      if (!into.related.some(r => r.ideaId === from.id)) {
        into.related.push({ ideaId: from.id, strength: 'high', reason: '已合并（源）' })
      }
      into.updatedAt = ts
      from.status = 'merged'
      from.mergedInto = into.id
      from.updatedAt = ts
      doc.merges.push({ id: uuid(), intoId: into.id, fromId: from.id, reason, createdAt: ts })
      break
    }
    case 'unmerge-idea': {
      if (!isString(action.ideaId)) throw new Error('unmerge-idea 参数无效')
      const idea = requireIdea(doc, action.ideaId)
      if (idea.mergedInto === null) throw new Error('该想法未被合并')
      idea.status = 'seed'
      idea.mergedInto = null
      idea.updatedAt = ts
      doc.merges = doc.merges.filter(m => m.fromId !== idea.id)
      break
    }
    case 'create-project': {
      if (!isString(action.id) || !isRecord(action.input) || !isString(action.input.name)) throw new Error('create-project 参数无效')
      if (doc.projects.some(p => p.id === action.id)) throw new Error('项目 id 已存在')
      const input = action.input
      doc.projects.push(normalizeProject({
        id: action.id,
        ideaId: input.ideaId,
        name: input.name,
        goal: input.goal,
        tasks: input.tasks,
        createdAt: ts,
        updatedAt: ts,
      }))
      // 若关联了想法，将想法状态推进为 project。
      if (isString(input.ideaId)) {
        const idea = doc.ideas.find(i => i.id === input.ideaId)
        if (idea !== undefined) {
          idea.status = 'project'
          idea.updatedAt = ts
        }
      }
      break
    }
    case 'update-project': {
      if (!isString(action.projectId) || !isRecord(action.patch)) throw new Error('update-project 参数无效')
      const project = requireProject(doc, action.projectId)
      if (isString(action.patch.name)) project.name = action.patch.name
      if (isString(action.patch.goal)) project.goal = action.patch.goal
      if (action.patch.ideaId === null || isString(action.patch.ideaId)) project.ideaId = action.patch.ideaId
      project.updatedAt = ts
      break
    }
    case 'delete-project': {
      if (!isString(action.projectId)) throw new Error('delete-project 参数无效')
      const index = doc.projects.findIndex(p => p.id === action.projectId)
      if (index === -1) throw new Error('项目不存在')
      doc.projects.splice(index, 1)
      break
    }
    case 'add-task': {
      if (!isString(action.projectId) || !isString(action.id) || !isRecord(action.input) || !isString(action.input.title)) throw new Error('add-task 参数无效')
      const project = requireProject(doc, action.projectId)
      if (project.tasks.some(t => t.id === action.id)) throw new Error('任务 id 已存在')
      project.tasks.push({
        id: action.id,
        title: action.input.title,
        status: TASK_STATUSES.includes(action.input.status) ? action.input.status : 'todo',
      })
      project.updatedAt = ts
      break
    }
    case 'update-task': {
      if (!isString(action.projectId) || !isString(action.taskId) || !isRecord(action.patch)) throw new Error('update-task 参数无效')
      const project = requireProject(doc, action.projectId)
      const task = project.tasks.find(t => t.id === action.taskId)
      if (task === undefined) throw new Error('任务不存在')
      if (isString(action.patch.title)) task.title = action.patch.title
      if (TASK_STATUSES.includes(action.patch.status)) task.status = action.patch.status
      project.updatedAt = ts
      break
    }
    case 'delete-task': {
      if (!isString(action.projectId) || !isString(action.taskId)) throw new Error('delete-task 参数无效')
      const project = requireProject(doc, action.projectId)
      project.tasks = project.tasks.filter(t => t.id !== action.taskId)
      project.updatedAt = ts
      break
    }
    default:
      throw new Error('未知 action')
  }
  return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 路由
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_LIMIT = 512 * 1024

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > ACTION_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return { raw, value: raw === '' ? undefined : JSON.parse(raw) }
}

export function makeRoutes(dataFile) {
  const state = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isTrustedRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      json(res, 200, loadDocument(dataFile))
    },
  }

  const action = {
    kind: 'exact',
    path: `${API_PREFIX}/action`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isTrustedRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const contentType = (req.headers['content-type'] || '').toLowerCase()
      if (!contentType.startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' })
      try {
        const body = await readBody(req)
        if (!isRecord(body.value) || !isRecord(body.value.action)) return json(res, 400, { ok: false, error: 'invalid-action' })
        const doc = loadDocument(dataFile)
        applyAction(doc, body.value.action)
        doc.revision += 1
        saveDocument(dataFile, doc)
        json(res, 200, doc)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
      }
    },
  }

  return [state, action]
}

// ─────────────────────────────────────────────────────────────────────────────
// 系统提示广播（让每个对话的 agent 都知道灵犀，实现「随口录入」）
// ─────────────────────────────────────────────────────────────────────────────

function makeGuidance(dataFile) {
  return '本机已安装灵犀（dsh-lingxi）插件：DSH Web GUI 的「灵感工作台」，用户的日常碎片想法与临时创意在此沉淀为一个想法池，侧边栏「灵犀」入口可查看；对话端与网页端共享同一份数据文件。当用户提到「记个想法 / 灵感 / 灵犀 / 想法池 / 灵感池」或直接陈述一个新想法时，把想法写入数据文件 ' + dataFile + '（JSON）。顶层结构 { schemaVersion:1, revision, ideas[], projects[], merges[] }。idea 字段：id、raw（原文）、title（一句话标题）、status（seed|incubating|planning|project|merged|archived）、scores{novelty,feasibility,value,overall，各 0-100}、analysis（展开解析）、tags[]、domain（领域）、related[{ideaId,strength:high|medium|low,reason}]、notes[{id,text,createdAt}]、mergedInto、createdAt/updatedAt（毫秒时间戳）。写入新想法时应做初步解析：一句话概括（title）、展开解析（analysis）、多维评分（scores）、自动标签（tags）、领域分类（domain），并检测与池中已有想法的关联写入 related（含 strength 与 reason）。标签（tags）必须用「模式/共性」抽象词、颗粒度合理，用于识别不同项目之间的共性，禁止用具体对象词（如帐篷、饭团、1688、抖音等应归入 domain 而非 tags）；常见共性标签：本地服务、共享租赁、服务聚合、社群运营、上门服务、场馆运营、内容电商、流量变现、营销服务、餐饮零售、健康消费、订阅制、平台撮合、AI 驱动、推荐系统等；每个想法 3~5 个标签，优先复用池中已出现的标签术语保持一致。当两条想法关联性极高、疑似同一主题时，向用户建议合并；确认后把被合并想法 status 置为 merged、mergedInto 指向保留方，并把其标签/笔记并入保留方、在 merges 记录。project 是想法立项后的项目，含 tasks[]（status: todo|doing|done）。'
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件 apply
// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const dataFile = resolveDataFile(config)
  // 首次启动时若数据文件不存在，先落一份空文档，方便用户/AI 直接看到文件。
  if (!existsSync(dataFile)) {
    try {
      saveDocument(dataFile, emptyDocument())
    } catch (error) {
      console.error('[dsh-lingxi] 无法创建数据文件：', error)
    }
  }
  const disposers = []
  try {
    for (const route of makeRoutes(dataFile)) {
      disposers.push(ctx.webServer.register(route))
    }
    // 系统提示广播：让每个对话的 agent 都知道灵犀，实现「随口录入」。
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:lingxi',
      order: 210,
      text: makeGuidance(dataFile),
    }))
  } catch (error) {
    for (const dispose of disposers) dispose()
    throw error
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'lingxi: host routes')
  console.log(`[dsh-lingxi] 已挂载 API，数据文件：${dataFile}`)
}
