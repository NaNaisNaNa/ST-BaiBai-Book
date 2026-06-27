/**
 * 向量召回的查询重写(Query Rewrite)。
 *
 * 复刻 Horae 的「小模型把当前剧情重写成 INTENT + 多条检索 Q」思路与提示词(用户已优化版),
 * 但**上下文构造是柏宝书自己的**(见 .carryover-plan.md「查询重写上下文构造」):
 *  结构 = [历史剧情摘要] + 最近窗口全文 + [状态快照] + [用户输入]
 *  - 状态一律走 deriveMemory(不假设 getLatestState 干净);
 *  - 状态快照精确放置:从窗口起点扫到第一个「无有效叶子」的楼停下,
 *    快照 = deriveMemory(chat, 洞楼index),插在「连续叶子前缀末尾」之后、洞楼之前;
 *  - 快照只含**滚出窗口的 items/plans**(时间/地点/在场已在全文里,不重复)。
 *
 * 产出多条 query,各自 embed → 后端 vec/search 多路检索 + RRF 融合;INTENT 兼作 rerank 的 query。
 * 任何失败都抛错,由召回侧 catch 后降级为「最近上下文当单 query」。
 */

import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { resolveVectorModel } from '@/api/settings';
import { deriveMemory, getLeaf, leafValid, stripHtml } from '../apply';
import { resolveKeepStart } from '../engine';
import { renderHistoryNodes, selectHistoryNodesBefore } from '../inject';
import { fmtItems, fmtPlans, QUERY_REWRITE_SYSTEM, QUERY_REWRITE_TAIL } from '../prompts';
import { memory } from '../store';

/** rewrite 模型最多取几条 query(对齐 Horae) */
const MAX_QUERIES = 6;
/** 单条 query 限长 */
const MAX_QUERY_LEN = 220;

export interface RewriteResult {
  /** 场景意图描述(兼作 rerank 的 query) */
  intent: string;
  /** 多条检索 query(已去重限长) */
  queries: string[];
}

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 把楼层正文清洗成可读文本(复用 stripHtml:去思维链/物品旁注/标签) */
function cleanFloor(m: STMessage): string {
  return stripHtml(m.mes);
}

/**
 * 构造状态快照文本(只含滚出窗口、长期有效的 items/plans)。
 * upTo = 第一个无叶子楼的索引(快照截到它之前)。无有意义内容返回空串。
 */
function buildStateSnapshot(chat: STMessage[], upTo: number): string {
  const st = deriveMemory(chat, upTo);
  const lines: string[] = [];
  if (st.items.length) {
    lines.push(`物品清单:\n${fmtItems(st.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`);
  }
  const openPlans = st.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    lines.push(`未了结的计划/悬念:\n${fmtPlans(openPlans.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })))}`);
  }
  if (!lines.length) return '';
  return `[状态快照:以下为已滚出最近窗口、但仍有效的物品与未了结计划,供你解析模糊指代]\n${lines.join('\n')}`;
}

/**
 * 找状态快照的插入点:从窗口起点向后扫,返回第一个「无有效叶子」楼的索引。
 * 全部有叶子则返回 chat.length(快照截到全部窗口,放最末)。
 */
function findSnapshotCut(chat: STMessage[], windowStart: number): number {
  for (let i = windowStart; i < chat.length; i++) {
    if (!leafValid(chat[i])) return i;
  }
  return chat.length;
}

/**
 * 构造发给 rewrite 模型的消息序列。
 * 窗口楼层按真实角色(user/assistant)交替平铺;状态快照作为一条 system 插在 cut 点之前。
 */
function buildMessages(chat: STMessage[]): ChatMsg[] {
  const windowStart = resolveKeepStart(chat);
  const cut = findSnapshotCut(chat, windowStart);

  const messages: ChatMsg[] = [{ role: 'system', content: QUERY_REWRITE_SYSTEM }];

  // [历史剧情摘要]:窗口之前的剧情(选最高存活压缩层),作为前置背景
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, windowStart));
  if (history) messages.push({ role: 'system', content: `[历史剧情摘要]\n${history}` });

  // 最近窗口楼层:按角色交替平铺;在 cut 点(第一个无叶子楼)之前插状态快照
  const snapshot = buildStateSnapshot(chat, cut);
  let snapshotInserted = false;
  for (let i = windowStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    if (m.is_system && m.extra?.type) continue; // 原生系统楼跳过
    // 到达 cut 点、且快照还没插 → 先插快照(放在连续叶子前缀末尾之后、洞楼之前)
    if (!snapshotInserted && i === cut && snapshot) {
      messages.push({ role: 'system', content: snapshot });
      snapshotInserted = true;
    }
    const text = cleanFloor(m);
    if (!text) continue;
    messages.push({ role: m.is_user ? 'user' : 'assistant', content: text });
  }
  // cut == chat.length(窗口全有叶子)→ 快照还没插,补在末尾
  if (!snapshotInserted && snapshot) messages.push({ role: 'system', content: snapshot });

  // 收尾提示词
  messages.push({ role: 'user', content: QUERY_REWRITE_TAIL });
  return messages;
}

/** base url 规整到 /chat/completions 端点 */
function chatCompletionsEndpoint(rawUrl: string): string {
  const base = String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/chat\/completions$/i, '');
  return base ? `${base}/chat/completions` : '';
}

/** 解析 INTENT + 多行 Q(对齐 Horae:去前缀符号、去重、限长) */
function parseResponse(text: string): RewriteResult {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let intent = '';
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    // 去掉行首的 -/*/•、数字编号
    const line = raw.replace(/^\s*(?:[-*•]\s*)?(?:\d+[.)、]\s*)?/, '').trim();
    const im = line.match(/^INTENT\s*[:：]\s*(.+)$/i);
    if (im) {
      intent = sanitize(im[1]);
      continue;
    }
    const qm = line.match(/^Q\s*\d*\s*[:：]\s*(.+)$/i);
    if (qm) {
      const q = sanitize(qm[1]);
      if (!q) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(q);
      if (queries.length >= MAX_QUERIES) break;
    }
  }
  return { intent, queries };
}

function sanitize(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

/**
 * 执行查询重写。queryRewrite 端点未配 model 时抛错(调用方降级)。
 * 走前端直连 chat/completions(与 embed 同源策略,渠道地址/密钥可留空复用 embedding)。
 */
export async function rewriteQuery(signal?: AbortSignal): Promise<RewriteResult> {
  const ep = resolveVectorModel('queryRewrite');
  if (!ep.model) throw new Error('Query 重写模型未配置');
  const endpoint = chatCompletionsEndpoint(ep.url);
  if (!endpoint) throw new Error('Query 重写地址未配置');

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!chat.length) throw new Error('无对话上下文可重写');

  const messages = buildMessages(chat);

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key || ''}` },
      body: JSON.stringify({
        model: ep.model,
        messages,
        temperature: 0.3,
        max_tokens: 800,
        stream: false,
      }),
      signal,
    });
  } catch (e) {
    throw new Error(`Query 重写网络异常:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Query 重写 API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content;
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) throw new Error('Query 重写返回空内容');

  const parsed = parseResponse(raw);
  if (!parsed.queries.length) throw new Error('Query 重写未解析出任何检索 query');
  return parsed;
}
