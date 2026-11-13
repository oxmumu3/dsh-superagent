#!/usr/bin/env node
// dsh-taskboard-mcp — read-only MCP server over the DSH task board ledger.
//
// Design: one-way read. It parses ~/.dsh/superagent-ledger.json directly and never
// writes. The board's host process owns writes; a second writer would race it.
// Writes (create/update/comment) are therefore deliberately not exposed here.
//
// Transport: MCP stdio, newline-delimited JSON-RPC 2.0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const LEDGER = process.env.DSH_SUPERAGENT_LEDGER || process.env.DSH_TASKBOARD_LEDGER || path.join(DSH_HOME, 'superagent-ledger.json');
const WORKSPACES = path.join(DSH_HOME, 'storages', 'workspace.json');
const SERVER_INFO = { name: 'dsh-taskboard', version: '0.1.0' };
const PROTOCOL = '2025-06-18';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function ledger() {
  const d = readJson(LEDGER);
  if (!d || !Array.isArray(d.tasks)) throw new Error(`ledger unavailable: ${LEDGER}`);
  return d;
}

function workspaceNames() {
  const d = readJson(WORKSPACES);
  const out = new Map();
  const rows = d?.tables?.workspaces;
  if (rows && typeof rows === 'object') {
    for (const [id, row] of Object.entries(rows)) out.set(id, row?.title || row?.path || id);
  }
  return out;
}

const isLive = (t) => !t.trashedAt;

function fmtTime(v) {
  if (v === undefined || v === null || v === '') return '?';
  if (typeof v === 'number') return new Date(v).toLocaleString('sv-SE');
  const n = Number(v);
  if (String(v).length >= 12 && Number.isFinite(n)) return new Date(n).toLocaleString('sv-SE');
  return String(v);
}

function fmtAuthor(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v.sessionId || v.id || v.kind || '';
  return String(v);
}

function listTasks({ status, project, include_archived = false, limit = 50 } = {}) {
  const d = ledger();
  const ws = workspaceNames();
  let rows = d.tasks.filter(isLive);
  if (!include_archived) rows = rows.filter((t) => !['archived', 'canceled'].includes(t.status));
  if (status) rows = rows.filter((t) => t.status === status);
  if (project) {
    const needle = String(project).toLowerCase();
    rows = rows.filter((t) => {
      const name = String(ws.get(t.workspaceId) || t.workspaceId || '').toLowerCase();
      return name.includes(needle) || String(t.workspaceId) === project;
    });
  }
  rows = rows.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const total = rows.length;
  const shown = rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
  const lines = shown.map((t) => {
    const bits = [
      `- ${t.id} [${t.status}]`,
      t.urgency ? `(${t.urgency})` : '',
      ws.get(t.workspaceId) || t.workspaceId || '',
      `「${t.title}」`,
      t.comments?.length ? `评论${t.comments.length}` : '',
      t.executions?.length ? `执行${t.executions.length}` : '',
      t.blocked ? '受阻' : '',
    ].filter(Boolean);
    return bits.join(' ');
  });
  const head = `任务 ${total} 条`
    + (Array.isArray(d.pending) && d.pending.length ? ` · 待确认 ${d.pending.length} 条` : '')
    + `（台账 rev ${d.revision ?? '?'}）`
    + (total > shown.length ? `，只显示最近 ${shown.length} 条` : '');
  return [head, ...lines].join('\n');
}

function listPendingItems() {
  const d = ledger();
  const ws = workspaceNames();
  const rows = Array.isArray(d.pending) ? d.pending.slice() : [];
  if (!rows.length) return `待确认 0 条（台账 rev ${d.revision ?? '?'}）`;
  rows.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const lines = rows.map((p) => {
    const bits = [
      `- ${p.id}`,
      ws.get(p.workspaceId) || p.workspaceId || p.workspacePath || '',
      p.title ? `「${p.title}」` : '',
      `原话：${String(p.text || '').replace(/\s+/g, ' ').slice(0, 120)}`,
      p.by ? `(${p.by} · ${fmtTime(p.at)})` : `(${fmtTime(p.at)})`,
    ].filter(Boolean);
    return bits.join(' ');
  });
  return [`待确认 ${rows.length} 条（台账 rev ${d.revision ?? '?'}）`, ...lines].join('\n');
}

function getTask({ id } = {}) {
  if (!id) throw new Error('id is required');
  const d = ledger();
  const t = d.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task not found: ${id}`);
  const ws = workspaceNames();
  const out = [];
  out.push(`# ${t.title}`);
  out.push(`- id: ${t.id}`);
  out.push(`- 状态: ${t.status}${t.blocked ? '（受阻）' : ''}`);
  out.push(`- 项目: ${ws.get(t.workspaceId) || t.workspaceId}`);
  out.push(`- 紧急度: ${t.urgency || 'normal'}`);
  out.push(`- 执行方式: ${t.execution?.mode || 'claim'}${t.execution?.cron ? ` cron=${t.execution.cron}` : ''}${t.execution?.runAt ? ` runAt=${t.execution.runAt}` : ''}`);
  out.push(`- 更新: ${fmtTime(t.updatedAt)}${fmtAuthor(t.updatedBy) ? ` 由 ${fmtAuthor(t.updatedBy)}` : ''}`);
  if (t.description) out.push('', '## 描述', t.description);
  if (Array.isArray(t.checklist) && t.checklist.length) {
    out.push('', '## 验收清单');
    for (const item of t.checklist) {
      out.push(`- [${item.checked ? 'x' : ' '}] ${item.text}${item.note ? ` · ${item.note}` : ''}`);
    }
  }
  if (Array.isArray(t.comments) && t.comments.length) {
    out.push('', '## 评论');
    for (const c of t.comments) out.push(`- [${fmtTime(c.at ?? c.createdAt)} ${fmtAuthor(c.author)}] ${c.body}`);
  }
  if (Array.isArray(t.executions) && t.executions.length) {
    out.push('', '## 执行记录');
    for (const e of t.executions) {
      out.push(`- [${e.mode || '?'} ${fmtTime(e.startedAt)}] ${e.state || '?'}${e.sessionId ? ` session=${e.sessionId}` : ''}`);
    }
  }
  return out.join('\n');
}

function listProjects() {
  const d = ledger();
  const ws = workspaceNames();
  const counts = new Map();
  for (const t of d.tasks.filter(isLive)) {
    counts.set(t.workspaceId, (counts.get(t.workspaceId) || 0) + 1);
  }
  const lines = [...counts.entries()]
    .map(([id, n]) => `- ${ws.get(id) || id} · ${n} 张 · ${id}`)
    .sort();
  return [`项目 ${lines.length} 个`, ...lines].join('\n');
}

// ---- write queue ----
// Writes never touch the ledger. A request is appended to a queue file and is
// consumed later by the DSH-side patrol session, which owns the board tools.
const QUEUE_DIR = process.env.DSH_TASKBOARD_QUEUE || path.join(DSH_HOME, 'taskboard-queue');
const REQUESTS = path.join(QUEUE_DIR, 'requests.jsonl');
const RESULTS = path.join(QUEUE_DIR, 'results.jsonl');

const ACTIONS = new Set(['create', 'comment', 'move', 'pending', 'checklist', 'check', 'report']);

function newRequestId() {
  return 'rq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function enqueue({ action, payload } = {}) {
  if (!ACTIONS.has(action)) throw new Error('action 必须是 create / pending / comment / move / checklist / check / report 之一');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload 必须是对象');
  if (action === 'create' && !payload.title) throw new Error('create 需要 payload.title');
  if (action === 'pending' && !String(payload.text || payload.title || '').trim()) {
    throw new Error('pending 需要 payload.text（用户原话或候选任务摘录）');
  }
  if (action === 'comment' && (!payload.id || !payload.body)) throw new Error('comment 需要 payload.id 和 payload.body');
  if (action === 'move' && (!payload.id || !payload.status)) throw new Error('move 需要 payload.id 和 payload.status');
  if (payload.ifVersion !== undefined && !Number.isInteger(payload.ifVersion)) throw new Error('ifVersion 必须是整数');
  if (action === 'checklist' && (!payload.id || !Array.isArray(payload.items))) throw new Error('checklist 需要 payload.id 和 items 数组');
  if (action === 'check' && (!payload.id || (!payload.itemId && !Number.isInteger(payload.index)))) throw new Error('check 需要 payload.id，以及 itemId 或 index');
  if (action === 'check' && !String(payload.note || '').trim()) {
    throw new Error('check 需要 note：写清这一项是怎么验的。宿主在交 ready 时逐项检查，缺 note 会被拒收');
  }
  if (action === 'report' && (!payload.id || !String(payload.summary || '').trim() || !payload.outcome)) throw new Error('report 需要 payload.id、summary 和 outcome');
  const normalizedPayload = action === 'pending'
    ? {
        ...payload,
        text: String(payload.text || payload.title).trim(),
        title: payload.title ? String(payload.title).trim() : String(payload.text || '').trim().slice(0, 80),
      }
    : payload;
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const rec = { id: newRequestId(), action, payload: normalizedPayload, by: 'mcp', at: new Date().toISOString() };
  fs.appendFileSync(REQUESTS, JSON.stringify(rec) + '\n');
  return [
    `已入队：${rec.id}`,
    `动作：${action}`,
    `队列文件：${REQUESTS}`,
    '写入由 DSH 内的 dsh-superagent 插件通过 fs.watch 实时消费，消费后可用 board_request_status 查结果。',
  ].join('\n');
}

function requestStatus({ id } = {}) {
  if (!id) throw new Error('id is required');
  let rows = [];
  try {
    rows = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { /* no results yet */ }
  const hit = rows.reverse().find((r) => r.id === id);
  if (hit) return JSON.stringify(hit, null, 1);
  let queued = null;
  try {
    queued = fs.readFileSync(REQUESTS, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((r) => r && r.id === id);
  } catch { /* ignore */ }
  return queued
    ? `请求 ${id} 已入队，尚未被消费（动作：${queued.action}）。`
    : `没有这个请求：${id}`;
}

function pendingRequests() {
  let rows = [];
  try {
    rows = fs.readFileSync(REQUESTS, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return '队列为空。'; }
  let done = new Set();
  try {
    done = new Set(fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.id).map((r) => r.id));
  } catch { /* ignore */ }
  const open = rows.filter((r) => !done.has(r.id));
  if (!open.length) return '没有待处理请求。';
  return [`待处理 ${open.length} 条`, ...open.map((r) => `- ${r.id} · ${r.action} · ${r.at} · ${JSON.stringify(r.payload).slice(0, 200)}`)].join('\n');
}

const TOOLS = [
  {
    name: 'board_list',
    description: '列出 DSH 任务看板上的卡片（只读）。可按状态、项目名过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'todo / in_progress / in_review / done / canceled / archived' },
        project: { type: 'string', description: '项目名（模糊匹配）或工作区 id' },
        include_archived: { type: 'boolean', description: '是否包含已归档与已取消' },
        limit: { type: 'number', description: '最多返回多少条，默认 50，上限 200' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_get',
    description: '读取一张卡的完整内容：描述、验收清单、评论、执行记录（只读）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id，例如 t-mw9dgk7h-roj4ea' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'board_projects',
    description: '列出看板上出现过的项目及其卡片数量（只读）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'board_pending_list',
    description: '列出看板顶部「待确认（pending）」栏里的候选句子（只读），便于外部 Agent 投递前查重。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'board_request',
    description: '提交一个写请求（建卡 / 投递待确认候选 / 评论 / 改状态 / 写清单 / 勾选 / 交活）。不直接写台账，先入队，由 DSH 内 dsh-superagent 插件实时监听消费。执行卡片时碰到工具阻碍或反复出现的环境问题，可以用 pending 投一条以 [Vent] 开头的话。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'pending', 'comment', 'move', 'checklist', 'check', 'report'] },
        payload: {
          type: 'object',
          description: 'create: {title, description?, workspaceId?, workspacePath?, urgency?} | pending: {text, title?, workspaceId?, workspacePath?, by?} | comment: {id, body} | move: {id, status: todo|in_progress|backlog|canceled|archived}；交活用 report，不要 move 到 in_review/done | checklist: {id, items, ifVersion?} | check: {id, itemId 或 index, note（必填：写清这一项怎么验的；宿主交 ready 时逐项检查，缺 note 会被拒收）, evidence?, ifVersion?} | report: {id, summary, outcome, checks, changedFiles?, risk?, friction?, question?, ifVersion?}；report 的 dropped 不对接外部，交活必须 ready 且过清单门禁',
        },
      },
      required: ['action', 'payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'board_request_status',
    description: '查询一个写请求的结果。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'board_queue_pending',
    description: '列出尚未消费的写请求（供消费方或调试使用）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const HANDLERS = {
  board_list: (a) => listTasks(a || {}),
  board_get: (a) => getTask(a || {}),
  board_projects: () => listProjects(),
  board_pending_list: () => listPendingItems(),
  board_request: (a) => enqueue(a || {}),
  board_request_status: (a) => requestStatus(a || {}),
  board_queue_pending: () => pendingRequests(),
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(req) {
  const { id, method, params } = req || {};
  if (method === undefined) return; // response/notification we never send
  const isNotification = id === undefined || id === null;
  const reply = (result) => { if (!isNotification) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (!isNotification) send({ jsonrpc: '2.0', id, error: { code, message } }); };

  if (method === 'initialize') {
    return reply({
      protocolVersion: params?.protocolVersion && String(params.protocolVersion) >= '2024-11-05' ? PROTOCOL : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const fn = HANDLERS[name];
    if (!fn) return fail(-32602, `unknown tool: ${name}`);
    try {
      const text = fn(args);
      return reply({ content: [{ type: 'text', text }] });
    } catch (err) {
      return reply({ content: [{ type: 'text', text: `读取失败：${err.message}` }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); } catch { return; }
  try { handle(req); } catch (err) {
    if (req?.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err.message } });
  }
});
