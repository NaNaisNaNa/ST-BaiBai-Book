/**
 * 向量化 / 重排的前端调用层。
 *
 * embedding 与 rerank 直接前端 fetch 上游(渠道 url/key 用户自填,与副 API 渠道独立)。
 * 走前端而非 ST 服务端代理:ST 的 /api/vector 端点绑定它自己的 source 配置,无法用我们
 * 独立配置的向量渠道;Horae 同样前端直连,已验证可行(代价是上游需允许跨域)。
 *
 * 兼容两种 embedding 端点:OpenAI /embeddings 与 Gemini batchEmbedContents(借鉴 Horae)。
 * 向量在前后端之间用 base64(float32 小端)传输。
 */

import type { VectorEndpoint } from '@/api/settings';
import { resolveVectorModel } from '@/api/settings';

export class EmbedError extends Error {}

/* ============ float32 ↔ base64 ============ */

/** Float32Array(或 number[]) → base64(小端字节序),用于上传后端存 BLOB */
export function encodeFloat32Base64(vec: number[] | Float32Array): string {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  // 分块拼,避免超长 apply 爆栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64(小端 float32) → Float32Array */
export function decodeFloat32Base64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/* ============ endpoint 适配 ============ */

function isGeminiEndpoint(url: string, model: string): boolean {
  return /gemini|googleapis|generativelanguage|v1beta/i.test(`${url} ${model}`);
}

function isGoogleUrl(url: string): boolean {
  return /googleapis\.com|generativelanguage/i.test(url || '');
}

/** 去掉 url 尾部的 /chat/completions、/embeddings、/v1 等,得到 base */
function embeddingBase(url: string): string {
  return String(url || '')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/embeddings$/i, '');
}

interface EmbeddingRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  parse: (json: any) => number[][];
}

function buildEmbeddingRequest(ep: VectorEndpoint, model: string, texts: string[]): EmbeddingRequest {
  const url = ep.url;
  const key = ep.key || '';

  if (!isGeminiEndpoint(url, model)) {
    const base = embeddingBase(url);
    return {
      endpoint: `${base}/embeddings`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
      parse: (json) => {
        if (!json?.data || !Array.isArray(json.data)) throw new EmbedError('embedding 返回缺少 data 数组');
        return json.data.slice().sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
      },
    };
  }

  // Gemini batchEmbedContents
  const base = embeddingBase(url).replace(/\/v\d+(beta\d*|alpha\d*)?(?:\/.*)?$/i, '');
  const modelName = model.startsWith('models/') ? model : `models/${model}`;
  const google = isGoogleUrl(base);
  const endpoint = `${base}/v1beta/${modelName}:batchEmbedContents${google ? `?key=${encodeURIComponent(key)}` : ''}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!google) headers.Authorization = `Bearer ${key}`;
  return {
    endpoint,
    headers,
    body: JSON.stringify({ requests: texts.map((text) => ({ model: modelName, content: { parts: [{ text }] } })) }),
    parse: (json) => {
      if (!json?.embeddings || !Array.isArray(json.embeddings)) throw new EmbedError('Gemini embedding 返回缺少 embeddings 数组');
      return json.embeddings.map((e: any) => e.values);
    },
  };
}

/* ============ 对外:embed / rerank ============ */

/** 单次 embedding 请求最多塞几条文本(多数上游 batch 上限 ≤64,取保守值分批)。 */
const EMBED_BATCH = 64;

/** 发一批(≤EMBED_BATCH)文本的 embedding 请求,返回向量数组(顺序对应)。 */
async function embedBatch(ep: VectorEndpoint, model: string, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const req = buildEmbeddingRequest(ep, model, texts);
  let resp: Response;
  try {
    resp = await fetch(req.endpoint, { method: 'POST', headers: req.headers, body: req.body, signal });
  } catch (e) {
    throw new EmbedError(`embedding 网络异常:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new EmbedError(`embedding API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const vectors = req.parse(json);
  if (!Array.isArray(vectors) || vectors.some((v) => !Array.isArray(v))) {
    throw new EmbedError('embedding 返回的向量数据无效');
  }
  return vectors.map((v) => Float32Array.from(v));
}

/**
 * 向量化一批文本,返回 Float32Array[](顺序与输入对应)。渠道未配齐则抛错。
 * 超过 EMBED_BATCH 条自动切片分批串行请求(上游单次 batch 有上限,补建几百条时必走多批)。
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const ep = resolveVectorModel('embedding');
  if (!ep.url) throw new EmbedError('向量记忆:Embedding 地址未配置');
  if (!ep.model) throw new EmbedError('向量记忆:Embedding 模型未配置');

  if (texts.length <= EMBED_BATCH) return embedBatch(ep, ep.model, texts, signal);

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const part = await embedBatch(ep, ep.model, texts.slice(i, i + EMBED_BATCH), signal);
    out.push(...part);
  }
  return out;
}

/** 向量化单条文本 → base64,索引/检索时用。 */
export async function embedToBase64(text: string, signal?: AbortSignal): Promise<string> {
  const [v] = await embedTexts([text], signal);
  if (!v) throw new EmbedError('embedding 返回为空');
  return encodeFloat32Base64(v);
}

export interface RerankResult {
  index: number;
  score: number;
}

/**
 * 重排:把候选文档按与 query 的相关度打分。返回按 score 降序的 {index, score}。
 * rerank 渠道未配齐时抛错(由调用方决定降级:跳过 rerank、直接用 embedding 序)。
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  topN: number,
  signal?: AbortSignal,
): Promise<RerankResult[]> {
  if (!documents.length) return [];
  const ep = resolveVectorModel('rerank');
  if (!ep.url) throw new EmbedError('向量记忆:Rerank 地址未配置');
  if (!ep.model) throw new EmbedError('向量记忆:Rerank 模型未配置');

  const base = embeddingBase(ep.url);
  const endpoint = `${base}/rerank`;
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key || ''}` },
      body: JSON.stringify({ model: ep.model, query, documents, top_n: topN }),
      signal,
    });
  } catch (e) {
    throw new EmbedError(`rerank 网络异常:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new EmbedError(`rerank API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const results = json?.results ?? json?.data;
  if (!Array.isArray(results)) throw new EmbedError('rerank 返回缺少 results 数组');
  return results
    .map((r: any) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
    .sort((a: RerankResult, b: RerankResult) => b.score - a.score);
}
