const sharp = require('sharp');
const path = require('path');

const MAX_PIXELS = 50000000; // 50MP，防解码炸内存
const SHARP_OPTS = { failOn: 'none', limitInputPixels: MAX_PIXELS };

const MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tiff: 'image/tiff'
};

const SUPPORTED = new Set(Object.keys(MIME));

function baseName(name) {
  return path.basename(name || 'image').replace(/\.[^./\\]+$/, '') || 'image';
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ---------- 编码器 ---------- */

function pngLossless(input) {
  return sharp(input, SHARP_OPTS).rotate()
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer();
}

function pngPalette(input, quality) {
  return sharp(input, SHARP_OPTS).rotate()
    .png({ compressionLevel: 9, palette: true, quality: clamp(quality, 50, 100), effort: 8 })
    .toBuffer();
}

function webpLossless(input) {
  return sharp(input, SHARP_OPTS).rotate()
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
}

function webpLossy(input, quality) {
  return sharp(input, SHARP_OPTS).rotate()
    .webp({ quality: clamp(quality, 30, 100), effort: 5 })
    .toBuffer();
}

/* 不指定 chromaSubsampling，让 libvips 用默认 4:2:0，体积比 4:4:4 小很多 */
function jpegLossy(input, quality) {
  return sharp(input, SHARP_OPTS).rotate()
    .jpeg({ quality: clamp(quality, 30, 100), mozjpeg: true })
    .toBuffer();
}

function avifLossy(input, quality) {
  return sharp(input, SHARP_OPTS).rotate()
    .avif({ quality: clamp(quality, 25, 100), effort: 4 })
    .toBuffer();
}

function tiffToPng(input) {
  return sharp(input, SHARP_OPTS).rotate()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

/* ---------- 无损校验 ---------- */

async function toRaw(buffer) {
  return sharp(buffer, SHARP_OPTS)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function pixelIdentical(a, b) {
  const [ra, rb] = await Promise.all([toRaw(a), toRaw(b)]);
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return false;
  return ra.data.equals(rb.data);
}

/* ---------- 结果构造 ---------- */

function keepOriginal(input, format, width, height, note) {
  return {
    buffer: input,
    format: '原始文件',
    mime: MIME[format] || 'application/octet-stream',
    outputName: null,
    lossless: true,
    keptOriginal: true,
    verified: true,
    note,
    width,
    height,
    previewable: true
  };
}

function losslessResult(buffer, format, mime, ext, name, width, height) {
  return {
    buffer,
    format,
    mime,
    outputName: baseName(name) + '-无损' + ext,
    lossless: true,
    keptOriginal: false,
    verified: true,
    note: '',
    width,
    height,
    previewable: true
  };
}

function lossyResult(buffer, format, mime, ext, name, width, height, note) {
  return {
    buffer,
    format,
    mime,
    outputName: baseName(name) + '-压缩' + ext,
    lossless: false,
    keptOriginal: false,
    verified: null,
    note: note || '',
    width,
    height,
    previewable: true
  };
}

/* ---------- 严格无损 ---------- */

async function compressLossless(input, format, name, width, height) {
  if (format === 'jpeg' || format === 'avif' || format === 'heif') {
    // 源文件本身有损，重新无损编码只会更大，不做无意义的 CPU 消耗
    return keepOriginal(input, format, width, height,
      '源文件本身已是有损压缩格式，无法在不改变像素的前提下变小');
  }
  if (format === 'gif') {
    return keepOriginal(input, format, width, height, 'GIF 暂不做无损优化，已保留原图');
  }
  if (format === 'tiff') {
    const png = await tiffToPng(input);
    if (png.length < input.length && await pixelIdentical(input, png)) {
      return losslessResult(png, 'PNG', 'image/png', '.png', name, width, height);
    }
    return keepOriginal(input, format, width, height, '重新编码后体积没有减小，已保留原图');
  }

  const candidates = [
    { buffer: await pngLossless(input), format: 'PNG', mime: 'image/png', ext: '.png' },
    { buffer: await webpLossless(input), format: 'WebP 无损', mime: 'image/webp', ext: '.webp' }
  ].sort((a, b) => a.buffer.length - b.buffer.length);

  for (const c of candidates) {
    if (c.buffer.length >= input.length) break;
    if (await pixelIdentical(input, c.buffer)) {
      return losslessResult(c.buffer, c.format, c.mime, c.ext, name, width, height);
    }
  }

  return keepOriginal(input, format, width, height, '重新编码后体积没有减小，已保留原图');
}

/* ---------- 智能模式 ---------- */

async function compressLossyPhoto(input, name, width, height, opts) {
  const target = opts.photoFormat;
  // 画质阶梯：从用户设定值逐级下降，找到第一个能真正变小的结果
  const levels = [opts.quality, opts.quality - 6, opts.quality - 12, opts.quality - 18]
    .filter(function (q) { return q >= 45; });

  for (const q of levels) {
    let buffer, format, mime, ext;
    if (target === 'webp') {
      buffer = await webpLossy(input, q); format = 'WebP'; mime = 'image/webp'; ext = '.webp';
    } else if (target === 'avif') {
      buffer = await avifLossy(input, q); format = 'AVIF'; mime = 'image/avif'; ext = '.avif';
    } else {
      buffer = await jpegLossy(input, q); format = 'JPEG'; mime = 'image/jpeg'; ext = '.jpg';
    }

    if (buffer.length < input.length) {
      const note = q < opts.quality
        ? '为保证体积下降，画质已自动降到 ' + q
        : '';
      return lossyResult(buffer, format, mime, ext, name, width, height, note);
    }
  }

  return keepOriginal(input, format, width, height,
    '当前画质下无法再变小，已保留原图；可调低画质后重试');
}

async function compressSmart(input, format, name, width, height, opts) {
  if (format === 'jpeg' || format === 'heif') {
    return compressLossyPhoto(input, name, width, height, opts);
  }

  if (format === 'png') {
    const png = await pngLossless(input);
    if (png.length < input.length * 0.995 && await pixelIdentical(input, png)) {
      return losslessResult(png, 'PNG', 'image/png', '.png', name, width, height);
    }
    // 无损收益太小，退而做调色板量化，体积通常能明显下降
    const palette = await pngPalette(input, opts.quality);
    if (palette.length < input.length) {
      return lossyResult(palette, 'PNG·调色板', 'image/png', '.png', name, width, height,
        '调色板量化会有极轻微的色彩变化，肉眼通常不可辨');
    }
    return keepOriginal(input, format, width, height, '重新编码后体积没有减小，已保留原图');
  }

  if (format === 'webp') {
    const wl = await webpLossless(input);
    if (wl.length < input.length && await pixelIdentical(input, wl)) {
      return losslessResult(wl, 'WebP 无损', 'image/webp', '.webp', name, width, height);
    }
    const w = await webpLossy(input, opts.quality);
    if (w.length < input.length) {
      return lossyResult(w, 'WebP', 'image/webp', '.webp', name, width, height);
    }
    return keepOriginal(input, format, width, height, '当前画质下无法再变小，已保留原图');
  }

  if (format === 'avif') {
    for (const q of [opts.quality, opts.quality - 10]) {
      const a = await avifLossy(input, q);
      if (a.length < input.length) {
        return lossyResult(a, 'AVIF', 'image/avif', '.avif', name, width, height);
      }
    }
    return keepOriginal(input, format, width, height, '当前画质下无法再变小，已保留原图');
  }

  if (format === 'tiff') {
    const png = await tiffToPng(input);
    if (png.length < input.length) {
      return lossyResult(png, 'PNG', 'image/png', '.png', name, width, height);
    }
    return keepOriginal(input, format, width, height, '转换后体积没有减小，已保留原图');
  }

  return keepOriginal(input, format, width, height, '该格式暂不支持优化，已保留原图');
}

async function compressBuffer(input, filename, opts) {
  const meta = await sharp(input, SHARP_OPTS).metadata();
  const format = meta.format;
  if (!SUPPORTED.has(format)) {
    throw new Error('暂不支持该图片格式：' + (format || '未知'));
  }

  const orient = meta.autoOrient;
  const width = orient ? orient.width : meta.width;
  const height = orient ? orient.height : meta.height;

  if (opts.mode === 'lossless') {
    return compressLossless(input, format, filename, width, height);
  }
  return compressSmart(input, format, filename, width, height, opts);
}

module.exports = { compressBuffer, MIME, SUPPORTED };
