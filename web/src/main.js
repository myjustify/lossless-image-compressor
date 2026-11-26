import JSZip from 'jszip';
import { createPool } from './pool.js';
import { sniffFormat, FORMAT_LABEL, formatBytes } from './format.js';

const MAX_FILES = 30;
const MAX_SIZE = 40 * 1024 * 1024;

const state = { items: [], busy: false, done: 0, total: 0 };
const wasmBase = new URL('wasm/', document.baseURI).href;
const poolSize = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
const pool = createPool(poolSize, wasmBase);

const el = {
  dropzone: document.getElementById('dropzone'),
  pickBtn: document.getElementById('pickBtn'),
  fileInput: document.getElementById('fileInput'),
  mode: document.getElementById('mode'),
  quality: document.getElementById('quality'),
  qualityValue: document.getElementById('qualityValue'),
  qualityField: document.getElementById('qualityField'),
  target: document.getElementById('target'),
  targetField: document.getElementById('targetField'),
  effort: document.getElementById('effort'),
  effortField: document.getElementById('effortField'),
  engineNote: document.getElementById('engineNote'),
  resultCard: document.getElementById('resultCard'),
  countBadge: document.getElementById('countBadge'),
  compressBtn: document.getElementById('compressBtn'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  clearBtn: document.getElementById('clearBtn'),
  summary: document.getElementById('summary'),
  statOriginal: document.getElementById('statOriginal'),
  statCompressed: document.getElementById('statCompressed'),
  statSavedBox: document.getElementById('statSavedBox'),
  statSavedLabel: document.getElementById('statSavedLabel'),
  statSaved: document.getElementById('statSaved'),
  elapsed: document.getElementById('elapsed'),
  fileList: document.getElementById('fileList'),
  toast: document.getElementById('toast'),
  modal: document.getElementById('previewModal'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  closeModal: document.getElementById('closeModal'),
  imgBefore: document.getElementById('imgBefore'),
  imgAfter: document.getElementById('imgAfter'),
  sizeBefore: document.getElementById('sizeBefore'),
  sizeAfter: document.getElementById('sizeAfter'),
  modalNote: document.getElementById('modalNote')
};

/* ---------------- 工具 ---------------- */

function uid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
}

function makeChip(text, cls, title) {
  const span = document.createElement('span');
  span.className = 'chip ' + cls;
  if (title) span.title = title;
  span.textContent = text;
  return span;
}

function toast(message, kind) {
  el.toast.textContent = message;
  el.toast.className = 'toast' + (kind ? ' toast-' + kind : '');
  el.toast.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.toast.hidden = true; }, 4200);
}

function saveUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function syncSettings() {
  const auto = el.mode.value === 'auto';
  el.qualityField.style.visibility = auto ? 'visible' : 'hidden';
  el.qualityValue.textContent = el.quality.value;
}

function currentSettings() {
  return {
    mode: el.mode.value,
    quality: Number(el.quality.value),
    target: el.target.value,
    effort: el.effort.value
  };
}

/* ---------------- 文件管理 ---------------- */

async function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  let added = 0;

  for (const file of incoming) {
    if (state.items.length >= MAX_FILES) {
      toast(`一次最多 ${MAX_FILES} 张，其余已跳过`, 'warn');
      break;
    }
    if (file.size > MAX_SIZE) {
      toast(`${file.name} 超过 40MB，已跳过`, 'warn');
      continue;
    }
    if (file.size === 0) continue;

    let format = 'unknown';
    try {
      const head = await file.slice(0, 32).arrayBuffer();
      format = sniffFormat(head);
    } catch (err) {
      format = 'unknown';
    }
    if (format === 'unknown' && !/^image\//.test(file.type)) continue;

    state.items.push({
      id: uid(),
      file,
      name: file.name,
      format,
      originalSize: file.size,
      sourceUrl: URL.createObjectURL(file),
      status: 'ready',
      result: null,
      error: ''
    });
    added++;
  }

  if (added) {
    el.elapsed.hidden = true;
    render();
  }
}

function releaseResult(item) {
  if (item.result && item.result.url) URL.revokeObjectURL(item.result.url);
  item.result = null;
}

function clearAll() {
  state.items.forEach((item) => {
    releaseResult(item);
    if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
  });
  state.items = [];
  el.fileInput.value = '';
  el.elapsed.hidden = true;
  render();
}

function invalidateResults() {
  if (state.busy) return;
  state.items.forEach((item) => {
    releaseResult(item);
    item.status = 'ready';
    item.error = '';
  });
  el.elapsed.hidden = true;
  render();
}

/* ---------------- 渲染 ---------------- */

function render() {
  const items = state.items;
  const done = items.filter((i) => i.status === 'done' && i.result);

  el.resultCard.hidden = items.length === 0;
  el.countBadge.textContent = String(items.length);

  el.mode.disabled = state.busy;
  el.quality.disabled = state.busy;
  el.target.disabled = state.busy;
  el.effort.disabled = state.busy;
  el.compressBtn.disabled = state.busy || items.length === 0;
  el.compressBtn.textContent = state.busy
    ? '压缩中…'
    : (done.length ? '重新压缩全部' : '开始压缩');
  el.downloadAllBtn.disabled = state.busy || done.length === 0;

  el.summary.hidden = done.length === 0;
  if (done.length) {
    const original = done.reduce((s, i) => s + i.originalSize, 0);
    const compressed = done.reduce((s, i) => s + i.result.outputSize, 0);
    const saved = original - compressed;
    const pct = original ? (Math.abs(saved) / original * 100).toFixed(1) : '0.0';

    el.statOriginal.textContent = formatBytes(original);
    el.statCompressed.textContent = formatBytes(compressed);

    el.statSavedBox.className = 'stat';
    if (saved > 0) {
      el.statSavedLabel.textContent = '共节省';
      el.statSaved.textContent = formatBytes(saved) + '（' + pct + '%）';
      el.statSavedBox.classList.add('stat-accent');
    } else if (saved === 0) {
      el.statSavedLabel.textContent = '体积变化';
      el.statSaved.textContent = '0 B';
    } else {
      el.statSavedLabel.textContent = '共增大';
      el.statSaved.textContent = '+' + formatBytes(-saved) + '（' + pct + '%）';
      el.statSavedBox.classList.add('stat-warn');
    }
  }

  el.fileList.textContent = '';
  items.forEach((item) => {
    el.fileList.appendChild(renderRow(item));
  });
}

function renderRow(item) {
  const row = document.createElement('div');
  row.className = 'file-row';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.title = '点击查看对比';
  const img = document.createElement('img');
  img.src = item.sourceUrl;
  img.alt = item.name;
  img.loading = 'lazy';
  thumb.appendChild(img);
  thumb.addEventListener('click', () => openPreview(item));

  const meta = document.createElement('div');
  meta.className = 'file-meta';

  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = item.name;
  name.title = item.name;

  const detail = document.createElement('div');
  detail.className = 'file-detail';
  detail.textContent = (FORMAT_LABEL[item.format] || '图片') + ' · ' + formatBytes(item.originalSize);
  if (item.status === 'done' && item.result) {
    const r = item.result;
    if (!r.keptOriginal) {
      detail.textContent += '  →  ' + formatBytes(r.outputSize) + '  ·  ' + (FORMAT_LABEL[r.format] || r.format);
    }
    if (r.width && r.height) detail.textContent += '  ·  ' + r.width + '×' + r.height;
    if (r.ms != null) detail.textContent += '  ·  ' + (r.ms / 1000).toFixed(2) + 's';
  }

  meta.appendChild(name);
  meta.appendChild(detail);

  const statusBox = document.createElement('div');
  statusBox.className = 'file-status';

  if (item.status === 'ready') {
    statusBox.appendChild(makeChip('待压缩', 'ready'));
  } else if (item.status === 'processing') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    statusBox.appendChild(spinner);
    statusBox.appendChild(makeChip(item.stage ? '压缩中 · ' + item.stage : '压缩中', 'processing'));
  } else if (item.status === 'error') {
    statusBox.appendChild(makeChip('失败', 'error', item.error));
  } else if (item.result) {
    const r = item.result;
    if (r.keptOriginal) {
      statusBox.appendChild(makeChip('已是最优', 'ready', r.note || '压缩后体积没有减小，已保留原图'));
    } else {
      if (r.lossless) {
        statusBox.appendChild(r.verified
          ? makeChip('像素一致', 'chip-verified', '输出回读解码后与原始像素逐字节相同')
          : makeChip('无损重压缩', 'chip-verified', r.note || '未做有损处理'));
      } else if (r.psnr && isFinite(r.psnr)) {
        // 按 PSNR 如实描述画质，避免把 34dB 说成“视觉无损”
        if (r.psnr >= 40) {
          statusBox.appendChild(makeChip('视觉无损', 'chip-visual',
            'PSNR ' + r.psnr.toFixed(1) + ' dB，肉眼几乎无法分辨差异'));
        } else if (r.psnr >= 36) {
          statusBox.appendChild(makeChip('画质接近', 'chip-bigger',
            'PSNR ' + r.psnr.toFixed(1) + ' dB，细心对比能看出轻微差异'));
        } else {
          statusBox.appendChild(makeChip('有损重编码', 'chip-bigger',
            'PSNR ' + r.psnr.toFixed(1) + ' dB，有可见画质损失，介意可提高画质或保留原图'));
        }
      } else {
        statusBox.appendChild(makeChip('有损重编码', 'chip-visual', r.note || '重编码后画质接近原图'));
      }
      if (r.psnr && isFinite(r.psnr)) {
        statusBox.appendChild(makeChip('PSNR ' + r.psnr.toFixed(1) + ' dB', 'chip-psnr', '与原图的峰值信噪比，40dB 以上肉眼几乎无法分辨'));
      }
      const delta = item.originalSize - r.outputSize;
      const savedPct = ((delta / item.originalSize) * 100).toFixed(1);
      statusBox.appendChild(makeChip('-' + savedPct + '%', 'done'));
    }

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn btn-ghost';
    dl.textContent = '下载';
    dl.addEventListener('click', () => downloadItem(item));
    statusBox.appendChild(dl);
  }

  row.appendChild(thumb);
  row.appendChild(meta);
  row.appendChild(statusBox);
  return row;
}

function downloadItem(item) {
  const r = item.result;
  if (!r) return;
  if (r.keptOriginal || !r.url) {
    saveUrl(item.sourceUrl, item.name);
    return;
  }
  saveUrl(r.url, r.downloadName);
}

/* ---------------- 对比弹窗 ---------------- */

function openPreview(item) {
  const r = item.result;
  el.imgBefore.src = item.sourceUrl;
  el.imgAfter.src = (r && r.url) ? r.url : item.sourceUrl;
  el.sizeBefore.textContent = formatBytes(item.originalSize);
  el.sizeAfter.textContent = r ? formatBytes(r.outputSize) : '待压缩';

  const lines = [];
  if (!r) {
    lines.push('点击「开始压缩」后即可查看对比结果。');
  } else if (r.keptOriginal) {
    lines.push('压缩后体积没有减小，已保留原文件：' + (r.note || '') + '。');
  } else {
    const delta = item.originalSize - r.outputSize;
    lines.push('节省 ' + formatBytes(delta) + '（' + ((delta / item.originalSize) * 100).toFixed(1) + '%），输出 ' +
      (FORMAT_LABEL[r.format] || r.format) + '。');
    if (r.lossless && r.verified) lines.push('已把输出解码回像素逐一比对：压缩前后完全一致。');
    if (!r.lossless) {
      lines.push('该结果经过有损重编码，画质接近原图但像素并非完全一致' +
        (r.psnr && isFinite(r.psnr) ? '（PSNR ' + r.psnr.toFixed(1) + ' dB）' : '') + '。');
    }
  }
  el.modalNote.textContent = lines.join(' ');
  el.modal.hidden = false;
}

function closePreview() {
  el.modal.hidden = true;
  el.imgBefore.src = '';
  el.imgAfter.src = '';
}

/* ---------------- 压缩流程 ---------------- */

async function compressAll() {
  if (state.busy || !state.items.length) return;

  let targets = state.items.filter((i) => i.status !== 'done');
  if (!targets.length) {
    state.items.forEach((i) => {
      releaseResult(i);
      i.status = 'ready';
      i.error = '';
    });
    targets = state.items.slice();
  }

  const settings = currentSettings();
  state.busy = true;
  state.total = targets.length;
  state.done = 0;
  el.elapsed.hidden = false;
  el.elapsed.textContent = '正在加载编码器…';
  render();

  const started = performance.now();
  const timer = setInterval(() => {
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    el.elapsed.textContent = state.done < state.total
      ? `正在压缩 ${state.done}/${state.total} · ${secs} 秒`
      : `本次处理 ${state.total} 张，用时 ${secs} 秒`;
  }, 100);

  await Promise.all(targets.map(async (item) => {
    item.status = 'processing';
    item.error = '';
    item.stage = '';
    render();

    try {
      const buffer = await item.file.arrayBuffer();
      const res = await pool.run({
        buffer,
        name: item.name,
        format: item.format,
        size: item.originalSize,
        settings
      }, (stage) => {
        item.stage = stage;
        render();
      });

      if (res.keptOriginal) {
        item.result = Object.assign({}, res, { blob: null, url: null, downloadName: item.name });
      } else {
        const blob = new Blob([res.buffer], { type: res.mime });
        item.result = Object.assign({}, res, {
          blob,
          url: URL.createObjectURL(blob),
          downloadName: res.outputName
        });
      }
      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.error = (err && err.message) || '压缩失败';
    }

    state.done++;
    render();
  }));

  clearInterval(timer);
  state.busy = false;
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  el.elapsed.textContent = `本次处理 ${targets.length} 张，用时 ${secs} 秒`;
  el.engineNote.textContent = `${poolSize} 个编码线程 · mozjpeg / libwebp / oxipng`;
  el.engineNote.className = 'section-note engine-ready';
  render();
}

/* ---------------- 打包下载 ---------------- */

async function downloadAll() {
  const done = state.items.filter((i) => i.status === 'done' && i.result);
  if (!done.length || state.busy) return;

  const label = el.downloadAllBtn.textContent;
  el.downloadAllBtn.disabled = true;
  el.downloadAllBtn.textContent = '打包中…';

  try {
    const zip = new JSZip();
    const used = new Set();

    for (const item of done) {
      const r = item.result;
      const blob = r.blob || item.file;
      let filename = r.downloadName || item.name;
      if (used.has(filename)) {
        const dot = filename.lastIndexOf('.');
        const base = dot > 0 ? filename.slice(0, dot) : filename;
        const ext = dot > 0 ? filename.slice(dot) : '';
        let n = 2;
        while (used.has(`${base}-${n}${ext}`)) n++;
        filename = `${base}-${n}${ext}`;
      }
      used.add(filename);
      zip.file(filename, blob);
    }

    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url = URL.createObjectURL(out);
    saveUrl(url, '压缩图片-' + new Date().toISOString().slice(0, 10) + '.zip');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    toast(err.message || '打包失败', 'error');
  } finally {
    el.downloadAllBtn.textContent = label;
    render();
  }
}

/* ---------------- 事件绑定 ---------------- */

el.pickBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.click();
});

el.dropzone.addEventListener('click', () => el.fileInput.click());

el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.fileInput.click();
  }
});

el.fileInput.addEventListener('change', (e) => {
  addFiles(e.target.files);
  el.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.dropzone.classList.remove('dragover');
  });
});

el.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el.mode.addEventListener('change', () => {
  syncSettings();
  invalidateResults();
});
el.quality.addEventListener('input', syncSettings);
el.quality.addEventListener('change', invalidateResults);
el.target.addEventListener('change', invalidateResults);
el.effort.addEventListener('change', invalidateResults);

el.compressBtn.addEventListener('click', compressAll);
el.downloadAllBtn.addEventListener('click', downloadAll);
el.clearBtn.addEventListener('click', clearAll);

el.closeModal.addEventListener('click', closePreview);
el.modalBackdrop.addEventListener('click', closePreview);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.modal.hidden) closePreview();
});

window.addEventListener('beforeunload', () => pool.dispose());

syncSettings();
render();
