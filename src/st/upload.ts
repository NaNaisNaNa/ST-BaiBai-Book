/**
 * 图片上传:把用户选的本地图片**压缩**后存到 ST 服务器,拿回一个短路径串
 * (如 /user/images/baibai_book/orb.webp)。
 *
 * 为什么不直接把 base64 存进设置:base64 会把图塞进 settings.json,大图让该文件膨胀、
 * 每次保存都带上它。改存「服务器路径串」——既跨设备同步(同一 ST 实例各端共享图片),
 * 又不撑大 settings。压缩在前端做(canvas → webp),控制服务器侧体积。
 *
 * 实现方式:**直接 POST 后端稳定 REST 端点 /api/images/upload**,认证头取自
 * getContext().getRequestHeaders()(ST 稳定 API)。不 import 酒馆内部 JS 文件——
 * 那些文件的导出会随版本变动(saveBase64AsFile 在 utils.js,script.js 并未 re-export,
 * 旧实现从 /script.js 取必然失败)。REST 端点契约比内部导出稳定得多。
 */
import { getContext } from '@/st/context';

const MAX_SIDE = 256; // 悬浮球很小,256px 足够清晰
const QUALITY = 0.85;

/** 把 File 读成 dataURL(base64)。 */
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 加载成 <img>,供 canvas 取像素。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 等比缩放到最长边 ≤ MAX_SIDE,转 webp,返回**纯 base64**(去掉 data:*;base64, 前缀)。
 * saveBase64AsFile 收的是不带前缀的裸 base64(见 ST utils.js)。
 */
async function compressToBase64(file: File): Promise<string> {
  const dataUrl = await readAsDataURL(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/webp', QUALITY);
  return out.split(',')[1] ?? '';
}

/**
 * 上传一张本地图片作悬浮球图标,返回服务器路径串;失败抛错(调用方提示用户)。
 * 文件名带一个序号避免覆盖(纯前端拼,不依赖时间戳——Date.now 在某些环境受限)。
 *
 * 直接 POST /api/images/upload(后端稳定端点):
 *   body { image: 纯base64, format: 'webp', ch_name: 子目录, filename: 不含扩展名 }
 *   返回 { path }。认证头走 getRequestHeaders(含 CSRF token)。
 */
let seq = 0;
export async function uploadOrbImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const base64 = await compressToBase64(file);
  if (!base64) throw new Error('图片压缩失败');

  const ctx = getContext();
  const headers = ctx?.getRequestHeaders?.();
  if (!headers) throw new Error('SillyTavern 未就绪,请稍后再试');

  const res = await fetch('/api/images/upload', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image: base64,
      format: 'webp',
      ch_name: 'baibai_book',
      filename: `orb_${++seq}`,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error ?? '';
    } catch {
      /* 响应非 JSON */
    }
    throw new Error(detail || `上传失败(${res.status})`);
  }
  const data = (await res.json()) as { path?: string };
  if (!data.path) throw new Error('服务器未返回图片路径');
  return data.path;
}
