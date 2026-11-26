/* 浏览器端压缩内核：在 Worker 里跑 WASM 编解码器，主线程只负责界面 */
import pngDecode, { init as initPngDecode } from '@jsquash/png/decode';
import pngEncode, { init as initPngEncode } from '@jsquash/png/encode';
import jpegDecode, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import jpegEncode, { init as initJpegEncode } from '@jsquash/jpeg/encode';
import webpDecode, { init as initWebpDecode } from '@jsquash/webp/decode';
import webpEncode, { init as initWebpEncode } from '@jsquash/webp/encode';
import initOxipng, { optimise as oxipngOptimise, optimise_raw as oxipngOptimiseRaw }
  from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';

// 用打包器处理 wasm 资源：带内容哈希、可被 CDN 缓存，也避免重复打包
import pngWasmUrl from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url';
import oxipngWasmUrl from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?url';
import mozjpegEncWasmUrl from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url';
import mozjpegDecWasmUrl from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?url';
import webpEncWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url';
import webpEncSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';
import webpDecWasmUrl from '@jsquash/webp/codec/dec/webp_dec.wasm?url';

const WASM = {
  'squoosh_png_bg.wasm': pngWasmUrl,
  'squoosh_oxipng_bg.wasm': oxipngWasmUrl,
  'mozjpeg_enc.wasm': mozjpegEncWasmUrl,
  'mozjpeg_dec.wasm': mozjpegDecWasmUrl,
  'webp_enc.wasm': webpEncWasmUrl,
  'webp_enc_simd.wasm': webpEncSimdWasmUrl,
  'webp_dec.wasm': webpDecWasmUrl
};

const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tiff: 'image/tiff'
};

const EXT = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  avif: 'avif',
  tiff: 'tiff'
};

/* ---------------- wasm 初始化（按需，只做一次） ---------------- */

let wasmBase = '';
const inits = {};

function ensure(key, factory) {
  if (!inits[key]) inits[key] = factory();
  return inits[key];
}

const codecs = {
  pngDecode: () => ensure('pngDecode', () => initPngDecode(pngWasmUrl)),
  pngEncode: () => ensure('pngEncode', () => initPngEncode(pngWasmUrl)),
  oxipng: () => ensure('oxipng', () => initOxipng(oxipngWasmUrl)),
  jpegDecode: () => ensure('jpegDecode', () => initJpegDecode({ locateFile: locate })),
  jpegEncode: () => ensure('jpegEncode', () => initJpegEncode({ locateFile: locate })),
  webpDecode: () => ensure('webpDecode', () => initWebpDecode({ locateFile: locate })),
  webpEncode: () => ensure('webpEncode', () => initWebpEncode({ locateFile: locate }))
};

function locate(path) {
  return WASM[path] || wasmBase + path;
}

/* ---------------- 解码 ---------------- */

/** 用浏览器自带解码器解码任意格式（GIF 取首帧，按 EXIF 方向摆正） */
async function decodeWithBrowser(buffer, format) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('当前浏览器不支持在后台线程解码，请使用较新的 Chrome / Edge / Safari');
  }
  const blob = new Blob([buffer], { type: MIME[format] || 'application/octet-stream' });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error('浏览器无法解码该图片（可能是 TIFF 或损坏文件）');
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  if (bitmap.close) bitmap.close();
  return data;
}

async function decodeSource(buffer, format) {
  if (format === 'png') {
    try {
      await codecs.pngDecode();
      return await pngDecode(buffer);
    } catch (err) {
      // 16bit / 特殊色型的 PNG 交给浏览器兜底
      return decodeWithBrowser(buffer, format);
    }
  }
  if (format === 'webp') {
    try {
      await codecs.webpDecode();
      return await webpDecode(buffer);
    } catch (err) {
      return decodeWithBrowser(buffer, format);
    }
  }
  if (format === 'jpeg') {
    try {
      await codecs.jpegDecode();
      return await jpegDecode(buffer, { preserveOrientation: true });
    } catch (err) {
      return decodeWithBrowser(buffer, format);
    }
  }
  return decodeWithBrowser(buffer, format);
}

/* ---------------- 编码 ---------------- */

async function encodePng(image) {
  await codecs.pngEncode();
  return pngEncode(image);
}

/** 对原始 PNG 字节做无损重压缩（只换滤波与压缩参数，像素不变） */
async function optimisePngBytes(buffer, level) {
  await codecs.oxipng();
  const out = oxipngOptimise(new Uint8Array(buffer), level, false, true);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

async function encodePngFromRaw(image, level) {
  await codecs.oxipng();
  const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const out = oxipngOptimiseRaw(data, image.width, image.height, level, false, true);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

async function encodeJpeg(image, quality) {
  await codecs.jpegEncode();
  return jpegEncode(image, { quality, progressive: true, optimize_coding: true });
}

async function encodeWebp(image, { quality, lossless }) {
  await codecs.webpEncode();
  return webpEncode(image, {
    quality,
    lossless: lossless ? 1 : 0,
    method: lossless ? 4 : 4,
    sns_strength: 50,
    filter_strength: 60,
    alpha_quality: 100,
    exact: lossless ? 1 : 0
  });
}

/* ---------------- 校验与质量指标 ---------------- */

function samePixels(a, b) {
  if (!a || !b) return false;
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = a.data;
  const y = b.data;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

function computePsnr(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  const x = a.data;
  const y = b.data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) {
    const dr = x[i] - y[i];
    const dg = x[i + 1] - y[i + 1];
    const db = x[i + 2] - y[i + 2];
    sum += dr * dr + dg * dg + db * db;
    n += 3;
  }
  if (!n) return null;
  const mse = sum / n;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

function hasAlpha(image) {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) return true;
  }
  return false;
}

/* ---------------- 主流程 ---------------- */

function baseName(name) {
  return name.replace(/\.[^.\\/]+$/, '') || 'image';
}

function outputName(name, ext) {
  return baseName(name) + '-min.' + ext;
}

async function verifyLossless(buffer, format, reference) {
  try {
    const decoded = await decodeSource(buffer, format);
    return samePixels(decoded, reference);
  } catch (err) {
    return false;
  }
}

async function compress(job) {
  const { buffer, name, format, size, settings } = job;
  const mode = settings.mode;
  const target = settings.target; // keep | webp
  const quality = settings.quality;
  const level = settings.effort === 'deep' ? 4 : 2;
  const started = performance.now();
  const tick = (stage) => self.postMessage({ type: 'stage', id: job.id, stage });

  const unsupportedLossless = format === 'jpeg' || format === 'avif';
  if (mode === 'lossless' && unsupportedLossless) {
    return kept(buffer, name, format, size, started,
      (format === 'jpeg' ? 'JPEG' : 'AVIF') + ' 本身是有损格式，转成无损格式体积会明显变大，已保留原文件');
  }

  let image = null;
  const getImage = async () => {
    if (!image) {
      tick('解码');
      image = await decodeSource(buffer, format);
    }
    return image;
  };

  /** 收集候选结果 */
  const candidates = [];

  if (mode === 'lossless') {
    if (format === 'png' && target !== 'webp') {
      try {
        tick('PNG 无损重压缩');
        const out = await optimisePngBytes(buffer, level);
        const ref = await getImage();
        tick('像素校验');
        const ok = await verifyLossless(out, 'png', ref);
        candidates.push({ buffer: out, format: 'png', lossless: true, verified: ok });
      } catch (err) {
        /* 忽略单个候选失败 */
      }
    }
    const wantWebpLossless = target === 'webp' || format !== 'png';
    if (wantWebpLossless) {
      try {
        tick('WebP 无损编码');
        const img = await getImage();
        const out = await encodeWebp(img, { quality: 100, lossless: true });
        // PNG / WebP 源才有逐字节比对的意义；其他格式以浏览器解码结果为基准
        const ok = (format === 'png' || format === 'webp')
          ? await verifyLossless(out, 'webp', img)
          : null;
        candidates.push({ buffer: out, format: 'webp', lossless: true, verified: ok });
      } catch (err) {
        /* WebP 无损不可用时忽略 */
      }
    }
  } else if (format === 'png' && target === 'keep') {
    tick('PNG 无损重压缩');
    const out = await optimisePngBytes(buffer, level);
    const ref = await getImage();
    tick('像素校验');
    candidates.push({
      buffer: out,
      format: 'png',
      lossless: true,
      verified: await verifyLossless(out, 'png', ref)
    });
  } else {
    const img = await getImage();
    const wantWebp = target === 'webp' || format === 'webp';
    const alpha = wantWebp ? true : hasAlpha(img);

    if (wantWebp) {
      candidates.push({ buffer: await encodeWebp(img, { quality, lossless: false }), format: 'webp' });
    } else if (alpha) {
      candidates.push({ buffer: await encodePngFromRaw(img, level), format: 'png', lossless: true });
    } else {
      candidates.push({ buffer: await encodeJpeg(img, quality), format: 'jpeg' });
    }
  }

  // 过滤掉校验失败的候选
  const valid = candidates.filter((c) => !(c.lossless && c.verified === false));
  if (!valid.length) {
    return kept(buffer, name, format, size, started, '没有找到可靠的压缩方案，已保留原文件');
  }

  valid.sort((a, b) => a.buffer.byteLength - b.buffer.byteLength);
  let best = valid[0];

  // 体积没变小：智能模式降一档画质再试一次，仍然不行就保留原图
  if (best.buffer.byteLength >= size && !best.lossless && quality > 58) {
    const img = await getImage();
    const retry = Math.max(55, quality - 12);
    const out = best.format === 'webp'
      ? await encodeWebp(img, { quality: retry, lossless: false })
      : await encodeJpeg(img, retry);
    if (out.byteLength < size) {
      best = { buffer: out, format: best.format, quality: retry };
    }
  }

  if (best.buffer.byteLength >= size) {
    const img = await getImage();
    return kept(buffer, name, format, size, started,
      mode === 'lossless' ? '已经接近最优，无损压缩无法再减小体积' : '再压缩就会明显损失画质，已保留原文件',
      img);
  }

  const img = await getImage();
  let verified = best.verified;
  let psnr = null;

  if (best.lossless) {
    if (verified == null) verified = await verifyLossless(best.buffer, best.format, img);
  } else {
    try {
      const decoded = await decodeSource(best.buffer, best.format);
      psnr = computePsnr(img, decoded);
    } catch (err) {
      psnr = null;
    }
  }

  return {
    type: 'result',
    ok: true,
    buffer: best.buffer,
    outputName: outputName(name, EXT[best.format] || best.format),
    format: best.format,
    mime: MIME[best.format] || 'application/octet-stream',
    outputSize: best.buffer.byteLength,
    width: img.width,
    height: img.height,
    lossless: !!best.lossless,
    verified: best.lossless ? !!verified : false,
    keptOriginal: false,
    psnr,
    quality: best.quality || (best.lossless ? null : quality),
    ms: Math.round(performance.now() - started),
    note: best.lossless
      ? (verified ? '输出已回读解码，与原始像素逐字节一致' : '无损重压缩，像素未做改动')
      : '重编码后画质接近原图'
  };
}

function kept(buffer, name, format, size, started, note, image) {
  return {
    type: 'result',
    ok: true,
    keptOriginal: true,
    buffer: null,
    outputSize: size,
    format,
    mime: MIME[format] || 'application/octet-stream',
    outputName: name,
    width: image ? image.width : null,
    height: image ? image.height : null,
    lossless: false,
    verified: false,
    psnr: null,
    ms: Math.round(performance.now() - started),
    note
  };
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === 'config') {
    wasmBase = data.wasmBase;
    return;
  }
  if (data.type !== 'job') return;

  const { id } = data;
  try {
    const result = await compress(data);
    const transfer = result.buffer ? [result.buffer] : [];
    self.postMessage(Object.assign({ id }, result), transfer);
  } catch (err) {
    self.postMessage({
      id,
      type: 'result',
      ok: false,
      error: (err && err.message) || '压缩失败'
    });
  }
};
