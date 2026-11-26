/** 通过文件头判断真实格式，比 MIME 可靠（拖拽、改后缀都能识别） */
export function sniffFormat(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 32));
  const ascii = (from, len) => String.fromCharCode.apply(null, b.subarray(from, from + len));

  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return 'tiff';
  return 'unknown';
}

export const FORMAT_LABEL = {
  png: 'PNG',
  jpeg: 'JPG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  avif: 'AVIF',
  tiff: 'TIFF',
  unknown: '未知'
};

export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  const sign = bytes < 0 ? '-' : '';
  const n = Math.abs(bytes);
  if (n < 1024) return sign + Math.round(n) + ' B';
  if (n < 1024 * 1024) return sign + (n / 1024).toFixed(1) + ' KB';
  return sign + (n / 1024 / 1024).toFixed(2) + ' MB';
}
