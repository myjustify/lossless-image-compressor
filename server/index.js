const path = require('path');
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');

const { compressBuffer } = require('./compressor');
const store = require('./store');

const PORT = Number(process.env.PORT || 5173);
// 默认只监听本机回环地址，图片不会离开这台电脑
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 60 * 1024 * 1024,
    files: 20
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* multer 默认按 latin1 解析文件名，中文会乱码，这里纠正一次 */
function fixFileName(name) {
  if (!name) return 'image';
  const converted = Buffer.from(name, 'latin1').toString('utf8');
  return converted.includes('\uFFFD') ? name : converted;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

app.post('/api/compress', upload.array('files', 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: '没有收到文件' });
  }

  const mode = req.body.mode === 'lossless' ? 'lossless' : 'auto';
  const quality = clamp(Number(req.body.quality) || 85, 40, 100);
  const photoFormat = ['jpeg', 'webp', 'avif'].includes(req.body.photoFormat)
    ? req.body.photoFormat
    : 'jpeg';

  const started = Date.now();
  const items = [];

  for (const file of files) {
    const name = fixFileName(file.originalname);
    try {
      const result = await compressBuffer(file.buffer, name, { mode, quality, photoFormat });
      const id = store.put(result.buffer, result.mime, result.outputName || name);

      items.push({
        id,
        name,
        outputName: result.outputName || name,
        originalSize: file.size,
        outputSize: result.buffer.length,
        format: result.format,
        lossless: result.lossless,
        keptOriginal: result.keptOriginal,
        verified: result.verified,
        note: result.note,
        width: result.width,
        height: result.height,
        previewUrl: result.previewable ? '/api/file/' + id : null,
        downloadUrl: '/api/file/' + id + '?download=1'
      });
    } catch (err) {
      items.push({ name, error: err.message || '压缩失败' });
    }
  }

  res.json({ items, elapsedMs: Date.now() - started });
});

app.get('/api/file/:id', (req, res) => {
  const item = store.get(req.params.id);
  if (!item) {
    return res.status(404).json({ error: '文件不存在或已过期，请重新压缩' });
  }
  const asDownload = req.query.download === '1';
  res.setHeader('Content-Type', item.mime);
  res.setHeader('Content-Length', item.buffer.length);
  res.setHeader(
    'Content-Disposition',
    (asDownload ? 'attachment' : 'inline') +
      "; filename*=UTF-8''" + encodeURIComponent(item.name)
  );
  res.end(item.buffer);
});

app.post('/api/zip', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 100) : [];
  if (!ids.length) {
    return res.status(400).json({ error: '没有可打包的文件' });
  }

  const zip = new JSZip();
  const used = new Set();
  let count = 0;

  for (const id of ids) {
    const item = store.get(id);
    if (!item) continue;

    let name = item.name || 'image';
    if (used.has(name)) {
      const ext = (name.match(/\.[^./\\]+$/) || [''])[0];
      const stem = ext ? name.slice(0, -ext.length) : name;
      let n = 2;
      while (used.has(stem + '-' + n + ext)) n++;
      name = stem + '-' + n + ext;
    }
    used.add(name);
    zip.file(name, item.buffer);
    count++;
  }

  if (!count) {
    return res.status(404).json({ error: '文件不存在或已过期，请重新压缩' });
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  const zipName = '压缩图片-' + new Date().toISOString().slice(0, 10) + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(zipName));
  res.end(buffer);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? '单张图片超过 60MB 限制'
      : '上传失败：' + err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  console.log('图片压缩服务已启动：http://' + HOST + ':' + PORT);
});
