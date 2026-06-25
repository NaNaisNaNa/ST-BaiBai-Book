import { getContext } from '@/st/context';
import { reactive, watch } from 'vue';

/**
 * 副 API 设置(全局,跨聊天)。存进 ST 的 extension_settings(→ 服务器 settings.json),
 * 因而跨设备同步:手机/局域网另一端打开同一 ST 账户即可见到同一份设置。
 * (旧版本曾存浏览器 localStorage,只在本机生效;见 hydrateSettings 的一次性迁移。)
 * 渠道可配多个;两类摘要任务各指派一个渠道:summary=摘要,resummary=总结。
 */

export interface ApiChannel {
  id: string;
  /** 显示名 */
  name: string;
  /** OpenAI 兼容的 base url,如 https://api.openai.com/v1 */
  url: string;
  /** 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token */
  maxTokens: number;
}

export type TaskType = 'summary' | 'resummary';

/** 自定义提示词:空串表示沿用 prompts.ts 内置模板,非空则整体覆盖该任务的模板。 */
export interface CustomPrompts {
  summary: string;
  resummary: string;
  /** 破限提示词:附加在摘要/总结请求里;空串=不附加。 */
  jailbreak: string;
}

/** 单个向量模型的配置。channel 空=复用 embedding 的渠道;model 空=复用 embedding 的模型名。 */
export interface VectorModelConfig {
  /** 指派的渠道 id(取自 channels);空串=复用 embedding 的渠道 */
  channel: string;
  /** 模型名;空串=复用 embedding 的模型 */
  model: string;
}

/** 向量记忆设置。embedding 为基准,rerank/queryRewrite 留空则整体复用 embedding。 */
export interface VectorSettings {
  /** 向量记忆开关 */
  enabled: boolean;
  /** 向量专用渠道列表(与副 API 的 channels 相互独立) */
  channels: ApiChannel[];
  /** 文本向量化模型(基准,其余两个可复用它) */
  embedding: VectorModelConfig;
  /** 重排模型;留空复用 embedding */
  rerank: VectorModelConfig;
  /** 查询重写模型;留空复用 embedding */
  queryRewrite: VectorModelConfig;
}

export interface ApiSettings {
  /** 插件总开关。关闭后停止一切自动注入/摘要/总结/隐藏;ST 菜单入口仍在,可重新打开界面再开启。 */
  enabled: boolean;
  /** 自定义提示词模板(空=用内置) */
  prompts: CustomPrompts;
  /** 向量记忆配置 */
  vector: VectorSettings;
  channels: ApiChannel[];
  /** 各任务指派的渠道 id */
  assignments: Record<TaskType, string>;
  /** 自动摘要开关 */
  autoSummaryEnabled: boolean;
  /** 保留最近 N 条 AI 消息发全文(滑动窗口);更早的自动摘要并隐藏 */
  keepRecent: number;
  /** 自动隐藏被摘要覆盖的消息 */
  autoHide: boolean;
  /** 积压拦截:发消息前若有 >=2 个已滑出窗口却仍未摘的楼,拦截本次生成并提示去补摘 */
  blockOnBacklog: boolean;
  /** 排除的角色名:这些名字(含重名卡)的聊天里,记忆系统所有功能都不生效 */
  excludedChars: string[];
  /** 叶子摘要积累到 N 条时,压成一条 L1 总结(L0→L1 阈值,0=关闭) */
  leafBatchThreshold: number;
  /** L1 及以上每积累到 N 条时,压成上一层总结(L≥1→L+1 阈值,0=关闭) */
  resummaryThreshold: number;
}

// extension_settings 里的命名空间键;localStorage 是旧版残留,仅用于一次性迁移。
const SETTINGS_KEY = 'baibai_book';
const LEGACY_STORAGE_KEY = 'bbs.api.v1';

function defaults(): ApiSettings {
  return {
    enabled: true,
    prompts: { summary: '', resummary: '', jailbreak: '' },
    vector: {
      enabled: false,
      channels: [],
      embedding: { channel: '', model: '' },
      rerank: { channel: '', model: '' },
      queryRewrite: { channel: '', model: '' },
    },
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: false,
    keepRecent: 5,
    autoHide: true,
    blockOnBacklog: true,
    excludedChars: [],
    leafBatchThreshold: 12,
    resummaryThreshold: 7,
  };
}

/** 把任意来源的原始对象并入默认值,容错缺字段/类型不符。 */
function normalize(raw: unknown): ApiSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const merged = { ...d, ...(raw as Partial<ApiSettings>) };
  // prompts 是嵌套对象,展开合并不会补全缺字段,单独兜底(老数据没有 prompts 键时回退默认)
  merged.prompts = { ...d.prompts, ...((raw as Partial<ApiSettings>).prompts ?? {}) };
  // excludedChars 必须是字符串数组,旧值类型不符时回退空数组
  merged.excludedChars = Array.isArray(merged.excludedChars)
    ? merged.excludedChars.filter((x): x is string => typeof x === 'string')
    : [];
  // vector 同为嵌套对象(且内含子对象),逐层兜底,老数据缺字段时回退默认
  const rv = ((raw as Partial<ApiSettings>).vector ?? {}) as Partial<VectorSettings>;
  merged.vector = {
    ...d.vector,
    ...rv,
    embedding: { ...d.vector.embedding, ...(rv.embedding ?? {}) },
    rerank: { ...d.vector.rerank, ...(rv.rerank ?? {}) },
    queryRewrite: { ...d.vector.queryRewrite, ...(rv.queryRewrite ?? {}) },
  };
  return merged;
}

// import 阶段 ST 往往尚未就绪,先以默认值建 reactive;真实值由 hydrateSettings 灌入。
export const apiSettings = reactive<ApiSettings>(defaults());

// 守门标志:hydrate 完成前不回写,避免「默认值」覆盖服务器上已存的设置。
let ready = false;

function applyInto(target: ApiSettings, src: ApiSettings): void {
  target.enabled = src.enabled;
  target.prompts = src.prompts;
  target.vector = src.vector;
  target.channels = src.channels;
  target.assignments = src.assignments;
  target.autoSummaryEnabled = src.autoSummaryEnabled;
  target.keepRecent = src.keepRecent;
  target.autoHide = src.autoHide;
  target.blockOnBacklog = src.blockOnBacklog;
  target.excludedChars = src.excludedChars;
  target.leafBatchThreshold = src.leafBatchThreshold;
  target.resummaryThreshold = src.resummaryThreshold;
}

/** 写回 extension_settings 并防抖落盘到服务器(跨设备同步的关键)。 */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
  ctx.saveSettingsDebounced?.();
}

/**
 * ST 就绪后调用:从 extension_settings 载入真实设置;
 * 若那里还没有、但 localStorage 有旧值,则迁移过去(老用户不丢配置),迁移后清掉旧键。
 * 完成后放行 watch 回写。可安全重复调用(只在首次真正 hydrate)。
 */
export function hydrateSettings(): void {
  if (ready) return;
  const ctx = getContext();
  if (!ctx?.extensionSettings) return; // ST 未就绪,稍后重试

  const stored = ctx.extensionSettings[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    applyInto(apiSettings, normalize(stored));
  } else {
    // 迁移:extension_settings 里没有 → 尝试搬运旧 localStorage
    let migrated: ApiSettings | null = null;
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) migrated = normalize(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    if (migrated) applyInto(apiSettings, migrated);
    // 把当前值(迁移来的或默认)写进 extension_settings,确立同步源
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  ready = true;
}

watch(
  apiSettings,
  () => {
    if (!ready) return; // hydrate 前不回写,防止默认值覆盖服务器设置
    persist();
  },
  { deep: true },
);

let chanSeq = 0;
export function newChannel(): ApiChannel {
  chanSeq += 1;
  return {
    id: `ch_${Date.now()}_${chanSeq}`,
    name: '新渠道',
    url: '',
    key: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
  };
}

/** 当前单角色聊天的角色名;群聊或未进入聊天时返回 null(群聊不参与排除)。 */
export function currentCharName(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊:多角色,不按单名排除
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  return ch?.name ?? null;
}

/**
 * 当前聊天是否被排除(该角色名在排除名单里)。被排除则记忆系统所有功能停用。
 * 按「名字」匹配:同名的重名卡会被一并排除——符合用户「这批重名卡一起排除」的诉求。
 */
export function isCurrentChatExcluded(): boolean {
  if (!apiSettings.excludedChars.length) return false;
  const name = currentCharName();
  return name !== null && apiSettings.excludedChars.includes(name);
}

/** 引擎是否在当前聊天生效:总开关开着且当前角色未被排除。各功能闸门统一走它。 */
export function engineActiveHere(): boolean {
  return apiSettings.enabled && !isCurrentChatExcluded();
}

export function getChannelForTask(task: TaskType): ApiChannel | null {
  const id = apiSettings.assignments[task];
  if (!id) return null;
  return apiSettings.channels.find(c => c.id === id) ?? null;
}

/**
 * 解析某个向量子任务实际使用的渠道与模型:rerank/queryRewrite 任一项留空就回落到 embedding。
 * 返回 { channel, model };渠道可能为 null(没指派/找不到),交由调用方处理。
 */
export function resolveVectorModel(role: 'embedding' | 'rerank' | 'queryRewrite'): {
  channel: ApiChannel | null;
  model: string;
} {
  const v = apiSettings.vector;
  const base = v.embedding;
  const cfg = v[role];
  const channelId = cfg.channel || base.channel;
  const model = cfg.model || base.model;
  // 渠道取自向量专用列表(与副 API 渠道独立)
  const channel = channelId ? v.channels.find(c => c.id === channelId) ?? null : null;
  return { channel, model };
}
