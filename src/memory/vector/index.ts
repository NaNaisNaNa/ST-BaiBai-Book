/**
 * 向量索引编排:把当前聊天的有效叶子同步进后端向量库(该角色的 chat:<chatId> scope)。
 *
 * 流程(增量、幂等):
 *  1. 扫 chat 收集有效叶子 → present = [{leafId, docHash}](docHash 按叶子摘要文本算)。
 *  2. vec/reconcile:后端删掉陈旧(重摘换 id/删楼/编辑失效),返回需 embed 的 leafId(新增或 hash 变了)。
 *  3. 对缺失叶子 embed 其摘要文本 → vec/upsert。
 * 同文本(同 hash)不重复 embed —— 这是「边玩边索引」不卡的关键。
 *
 * 调用时机:叶子生成/编辑/删除后(防抖触发,见 schedule)。全程 try/catch 静默,
 * 向量是增强项,失败绝不影响摘要主流程。
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings } from '@/api/settings';
import { isBaiBaoKuAvailable, vecReconcile, vecUpsert, type VecItem } from '@/api/baibaoku';
import { getLeaf, leafValid, stripHtml } from '../apply';
import { resolveKeepStart } from '../engine';
import type { LeafExtra } from '../types';
import { embedTexts, encodeFloat32Base64 } from './embed';
import { currentChatId, currentVectorDb } from './scope';

/** 轻量稳定 hash(FNV-1a,16 进制);叶子摘要文本变了 hash 即变,触发重 embed。 */
function docHashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 楼层原文清洗:去思维链/物品旁注/标签(复用 stripHtml),供跨聊天召回「全文档」用。 */
function cleanMesFull(mes: string): string {
  return stripHtml(mes);
}

interface LeafForIndex {
  leafId: string;
  docHash: string;
  document: string; // 叶子摘要文本(向量化对象 + 摘要档回传)
  mesFull: string; // 楼层原文(全文档回传)
  storyTime: string;
  msgIndex: number;
}

/** 扫当前 chat 收集所有有效叶子的索引素材。 */
function collectLeaves(chat: STMessage[]): LeafForIndex[] {
  const out: LeafForIndex[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i]) as LeafExtra;
    const document = (leaf.text ?? '').trim();
    if (!document) continue; // 空摘要不索引
    out.push({
      leafId: leaf.id,
      docHash: docHashOf(document),
      document,
      mesFull: cleanMesFull(chat[i].mes),
      storyTime: leaf.timeEnd?.trim() || leaf.timeStart?.trim() || leaf.timeLabel?.trim() || '',
      msgIndex: i,
    });
  }
  return out;
}

let indexing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 向量记忆是否在当前聊天可索引(开关开 + 进入了单角色聊天)。 */
export function vectorIndexableHere(): boolean {
  if (!apiSettings.vector.enabled) return false;
  return !!currentVectorDb() && !!currentChatId();
}

/**
 * 把当前聊天的叶子同步进向量库(增量)。可被防抖 schedule 或手动「重建索引」直接调用。
 * @returns 实际 embed+upsert 的条数(0 = 全是增量命中或无可索引)。
 */
export async function syncVectorIndex(signal?: AbortSignal): Promise<number> {
  if (!vectorIndexableHere()) return 0;
  if (indexing) return 0;
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return 0;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const scope = `chat:${chatId}`;

  indexing = true;
  try {
    if (!(await isBaiBaoKuAvailable())) return 0;

    const leaves = collectLeaves(chat);
    const present = leaves.map(l => ({ leafId: l.leafId, docHash: l.docHash }));

    // reconcile:删陈旧、得出需 embed 的 leafId。空 present 也要发(可能要清掉删光的旧索引)。
    const { missing } = await vecReconcile(database, scope, present);
    if (!missing.length) return 0;

    const missingSet = new Set(missing);
    const todo = leaves.filter(l => missingSet.has(l.leafId));
    return await embedAndUpsert(database, scope, todo, signal);
  } catch (e) {
    console.warn('[柏宝书向量] 索引同步失败(不影响摘要):', e);
    return 0;
  } finally {
    indexing = false;
  }
}

/** embed 一批叶子并 upsert 到指定 scope;返回实际写入条数。embedTexts 内部按 64 分批。 */
async function embedAndUpsert(database: string, scope: string, todo: LeafForIndex[], signal?: AbortSignal): Promise<number> {
  if (!todo.length) return 0;
  const vectors = await embedTexts(todo.map(l => l.document), signal);
  const items: VecItem[] = todo.map((l, i) => {
    const vec = vectors[i];
    return {
      leafId: l.leafId,
      docHash: l.docHash,
      vector: encodeFloat32Base64(vec),
      dim: vec.length,
      document: l.document,
      mesFull: l.mesFull,
      storyTime: l.storyTime,
      msgIndex: l.msgIndex,
    };
  });
  await vecUpsert(database, scope, items);
  return items.length;
}

/**
 * 召回前的「补齐窗口外缺失索引」:确保滑动窗口**之前**的叶子都已索引,才放行召回。
 *
 * 为何只补窗口外:窗口内的叶子召回本就排除(避免与全文重复),它们的索引留给防抖增量即可,
 * 不必阻塞生成;而窗口外的旧叶子是召回的真正目标,缺索引会直接漏召回——必须先补。
 *
 * 复用 reconcile 全量对账(同时清陈旧、得 missing),但只对「窗口外 missing」阻塞 embed。
 * 全程 try/catch 静默:补建失败不阻断召回(召回侧自有降级),更不影响生成。
 */
export async function ensureRecallIndex(signal?: AbortSignal): Promise<void> {
  if (!vectorIndexableHere()) return;
  if (indexing) return; // 正在跑防抖同步,让它去做,避免重复 embed
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const scope = `chat:${chatId}`;

  indexing = true;
  try {
    if (!(await isBaiBaoKuAvailable())) return;

    const leaves = collectLeaves(chat);
    const present = leaves.map(l => ({ leafId: l.leafId, docHash: l.docHash }));
    const { missing } = await vecReconcile(database, scope, present);
    if (!missing.length) return;

    // 只阻塞补窗口外(< keepStart)缺失的叶子;窗口内缺失交给防抖增量
    const keepStart = resolveKeepStart(chat);
    const missingSet = new Set(missing);
    const todo = leaves.filter(l => missingSet.has(l.leafId) && l.msgIndex < keepStart);
    if (todo.length) await embedAndUpsert(database, scope, todo, signal);
  } catch (e) {
    console.warn('[柏宝书向量] 召回前补建索引失败(降级为不补):', e);
  } finally {
    indexing = false;
  }
}

/** 防抖触发索引同步:叶子生成/编辑/删除后调用,合并连续变动为一次。 */
export function scheduleVectorIndex(): void {
  if (!vectorIndexableHere()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncVectorIndex();
  }, 2500);
}
