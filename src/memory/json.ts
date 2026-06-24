/**
 * 从 LLM 文本输出里健壮地提取 JSON 对象。
 * 应对:```json 围栏、思维链前后缀、智能引号、尾随逗号。
 */
export function extractJsonObject<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim();

  // 去掉 <think>…</think> / <thinking>…</thinking> 思维链(大小写不敏感)
  s = s.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

  // assistant prefill 场景下,返回可能只包含续写的思维链正文 + </thinking> + JSON,
  // 没有开头 <thinking>。此时丢弃最后一个闭合标签及其之前的全部文本。
  const danglingThinkClose = s.match(/<\/think(?:ing)?>/gi);
  if (danglingThinkClose) {
    const lastClose = Math.max(
      s.toLowerCase().lastIndexOf('</think>'),
      s.toLowerCase().lastIndexOf('</thinking>'),
    );
    if (lastClose >= 0) {
      const close = s.slice(lastClose).match(/^<\/think(?:ing)?>/i)?.[0] ?? '';
      s = s.slice(lastClose + close.length).trim();
    }
  }

  // 去掉 ```json ... ``` / ``` ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 截取第一个 { 到最后一个 } 之间(去掉前后说明文字)
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  let body = s.slice(first, last + 1);

  // 直接尝试
  const direct = tryParse<T>(body);
  if (direct !== null) return direct;

  // 容错清洗:智能引号 -> 直引号,去尾随逗号
  body = body
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');

  return tryParse<T>(body);
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
