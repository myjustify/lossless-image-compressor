/* 图片压缩 — 前端只负责交互，压缩由本机 Node 服务（sharp/libvips）完成 */
(function () {
  'use strict';

  var state = { items: [], busy: false };
  var timerHandle = null;

  var el = {
    dropzone: document.getElementById('dropzone'),
    pickBtn: document.getElementById('pickBtn'),
    fileInput: document.getElementById('fileInput'),
    mode: document.getElementById('mode'),
    quality: document.getElementById('quality'),
    qualityValue: document.getElementById('qualityValue'),
    qualityField: document.getElementById('qualityField'),
    photoFormat: document.getElementById('photoFormat'),
    photoFormatField: document.getElementById('photoFormatField'),
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

  /* ---------------- 通用工具 ---------------- */

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    var sign = bytes < 0 ? '-' : '';
    var n = Math.abs(bytes);
    if (n < 1024) return sign + Math.round(n) + ' B';
    if (n < 1024 * 1024) return sign + (n / 1024).toFixed(1) + ' KB';
    return sign + (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function uid() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  }

  function makeChip(text, cls, title) {
    var span = document.createElement('span');
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
    toast._timer = setTimeout(function () { el.toast.hidden = true; }, 4000);
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function syncSettings() {
    var auto = el.mode.value === 'auto';
    el.qualityField.hidden = !auto;
    el.photoFormatField.hidden = !auto;
    el.qualityValue.textContent = el.quality.value;
  }

  function currentSettings() {
    return {
      mode: el.mode.value,
      quality: Number(el.quality.value),
      photoFormat: el.photoFormat.value
    };
  }

  /* ---------------- 请求服务端压缩 ---------------- */

  async function compressItem(item, settings) {
    item.status = 'processing';
    render();

    try {
      var form = new FormData();
      form.append('files', item.file, item.name);
      form.append('mode', settings.mode);
      form.append('quality', String(settings.quality));
      form.append('photoFormat', settings.photoFormat);

      var res = await fetch('/api/compress', { method: 'POST', body: form });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));

      var result = data.items && data.items[0];
      if (!result) throw new Error('服务端没有返回结果');
      if (result.error) throw new Error(result.error);

      item.result = result;
      item.status = 'done';
      item.error = '';
    } catch (err) {
      item.status = 'error';
      item.error = (err && err.message) ? err.message : '压缩失败';
      if (/failed to fetch|networkerror|load failed/i.test(item.error)) {
        item.error = '无法连接本地服务，请先在项目目录运行 pnpm start';
      }
    }

    render();
  }

  /* ---------------- 文件管理 ---------------- */

  function addFiles(fileList) {
    var incoming = Array.prototype.slice.call(fileList || []);
    var added = 0;

    incoming.forEach(function (file) {
      var isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|avif|tiff?|gif)$/i.test(file.name);
      if (!isImage) return;
      if (file.size > 60 * 1024 * 1024) {
        toast(file.name + ' 超过 60MB，已跳过', 'warn');
        return;
      }
      state.items.push({
        id: uid(),
        file: file,
        name: file.name,
        originalSize: file.size,
        sourceUrl: URL.createObjectURL(file),
        status: 'ready',
        result: null,
        error: ''
      });
      added++;
    });

    if (added) {
      el.elapsed.hidden = true;
      render();
    }
  }

  function clearAll() {
    state.items.forEach(function (item) {
      if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
    });
    state.items = [];
    el.fileInput.value = '';
    el.elapsed.hidden = true;
    render();
  }

  function invalidateResults() {
    if (state.busy) return;
    state.items.forEach(function (item) {
      item.status = 'ready';
      item.result = null;
      item.error = '';
    });
    el.elapsed.hidden = true;
    render();
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    var items = state.items;
    var done = items.filter(function (i) { return i.status === 'done' && i.result; });

    el.resultCard.hidden = items.length === 0;
    el.countBadge.textContent = String(items.length);

    el.mode.disabled = state.busy;
    el.quality.disabled = state.busy;
    el.photoFormat.disabled = state.busy;
    el.compressBtn.disabled = state.busy || items.length === 0;
    el.compressBtn.textContent = state.busy
      ? '压缩中…'
      : (done.length ? '重新压缩全部' : '开始压缩');
    el.downloadAllBtn.disabled = state.busy || done.length === 0;

    el.summary.hidden = done.length === 0;
    if (done.length) {
      var original = done.reduce(function (s, i) { return s + i.originalSize; }, 0);
      var compressed = done.reduce(function (s, i) { return s + i.result.outputSize; }, 0);
      var saved = original - compressed;
      var pct = original ? (Math.abs(saved) / original * 100).toFixed(1) : '0.0';

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
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'file-row';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.title = '点击查看对比';
      var img = document.createElement('img');
      img.src = item.sourceUrl;
      img.alt = item.name;
      thumb.appendChild(img);
      thumb.addEventListener('click', function () { openPreview(item); });

      var meta = document.createElement('div');
      meta.className = 'file-meta';

      var name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = item.name;
      name.title = item.name;

      var detail = document.createElement('div');
      detail.className = 'file-detail';
      detail.textContent = formatBytes(item.originalSize);
      if (item.status === 'done' && item.result) {
        detail.textContent += '  →  ' + formatBytes(item.result.outputSize) +
          '  ·  ' + item.result.format;
        if (item.result.width && item.result.height) {
          detail.textContent += '  ·  ' + item.result.width + '×' + item.result.height;
        }
      }

      meta.appendChild(name);
      meta.appendChild(detail);

      var statusBox = document.createElement('div');
      statusBox.className = 'file-status';

      if (item.status === 'ready') {
        statusBox.appendChild(makeChip('待压缩', 'ready'));
      } else if (item.status === 'processing') {
        var spinner = document.createElement('span');
        spinner.className = 'spinner';
        statusBox.appendChild(spinner);
        statusBox.appendChild(makeChip('压缩中', 'processing'));
      } else if (item.status === 'error') {
        statusBox.appendChild(makeChip('失败', 'error', item.error));
      } else if (item.result) {
        var r = item.result;
        if (r.keptOriginal) {
          statusBox.appendChild(makeChip('已是最优', 'ready', r.note || '压缩后体积没有减小，已保留原图'));
        } else {
          if (r.lossless) {
            statusBox.appendChild(r.verified
              ? makeChip('像素一致', 'chip-verified', '服务端逐像素校验通过')
              : makeChip('校验未通过', 'error', '像素不一致，请勿使用'));
          } else {
            statusBox.appendChild(makeChip('视觉无损', 'chip-visual', r.note || '重编码后画质接近原图'));
          }
          var delta = item.originalSize - r.outputSize;
          var savedPct = ((delta / item.originalSize) * 100).toFixed(1);
          statusBox.appendChild(makeChip('-' + savedPct + '%', 'done'));
        }

        var dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'btn btn-ghost';
        dl.textContent = '下载';
        dl.addEventListener('click', function () { downloadItem(item); });
        statusBox.appendChild(dl);
      }

      row.appendChild(thumb);
      row.appendChild(meta);
      row.appendChild(statusBox);
      el.fileList.appendChild(row);
    });
  }

  function downloadItem(item) {
    var r = item.result;
    if (!r) return;
    var a = document.createElement('a');
    a.href = r.downloadUrl;
    a.download = r.outputName || item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------------- 对比弹窗 ---------------- */

  function openPreview(item) {
    var r = item.result;
    el.imgBefore.src = item.sourceUrl;
    el.imgAfter.src = (r && r.previewUrl) ? r.previewUrl : item.sourceUrl;
    el.sizeBefore.textContent = formatBytes(item.originalSize);
    el.sizeAfter.textContent = r ? formatBytes(r.outputSize) : '待压缩';

    var lines = [];
    if (!r) {
      lines.push('点击「开始压缩」后即可查看对比结果。');
    } else if (r.keptOriginal) {
      lines.push('压缩后体积没有减小，已保留原文件：' + (r.note || '') + '。');
    } else {
      var delta = item.originalSize - r.outputSize;
      lines.push('节省 ' + formatBytes(delta) + '（' + ((delta / item.originalSize) * 100).toFixed(1) + '%），输出 ' + r.format + '。');
      if (r.lossless && r.verified) lines.push('服务端已回读解码校验：压缩前后像素数据完全相同。');
      if (!r.lossless) lines.push('该结果经过有损重编码，画质接近原图但像素并非完全一致。');
      if (r.note) lines.push(r.note);
    }

    el.modalNote.textContent = lines.join(' ');
    el.modal.hidden = false;
  }

  function closePreview() {
    el.modal.hidden = true;
    el.imgBefore.src = '';
    el.imgAfter.src = '';
  }

  /* ---------------- 事件绑定 ---------------- */

  el.pickBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    el.fileInput.click();
  });

  el.dropzone.addEventListener('click', function () { el.fileInput.click(); });

  el.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });

  el.fileInput.addEventListener('change', function (e) {
    addFiles(e.target.files);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    el.dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(function (type) {
    el.dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.dropzone.classList.remove('dragover');
    });
  });

  el.dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  el.mode.addEventListener('change', function () {
    syncSettings();
    invalidateResults();
  });
  el.quality.addEventListener('input', syncSettings);
  el.quality.addEventListener('change', invalidateResults);
  el.photoFormat.addEventListener('change', invalidateResults);

  el.compressBtn.addEventListener('click', async function () {
    if (state.busy || !state.items.length) return;

    var targets = state.items.filter(function (i) { return i.status !== 'done'; });
    if (!targets.length) {
      state.items.forEach(function (i) {
        i.status = 'ready';
        i.result = null;
      });
      targets = state.items.slice();
    }

    var settings = currentSettings();
    state.busy = true;
    el.elapsed.hidden = false;
    render();

    var started = performance.now();
    el.elapsed.textContent = '正在压缩… 0.0 秒';
    timerHandle = setInterval(function () {
      el.elapsed.textContent = '正在压缩… ' + ((performance.now() - started) / 1000).toFixed(1) + ' 秒';
    }, 100);

    for (var i = 0; i < targets.length; i++) {
      await compressItem(targets[i], settings);
    }

    clearInterval(timerHandle);
    timerHandle = null;
    state.busy = false;
    el.elapsed.textContent = '本次处理 ' + targets.length + ' 张，用时 ' +
      ((performance.now() - started) / 1000).toFixed(1) + ' 秒';
    render();
  });

  el.downloadAllBtn.addEventListener('click', async function () {
    var ids = state.items
      .filter(function (i) { return i.status === 'done' && i.result; })
      .map(function (i) { return i.result.id; });
    if (!ids.length || state.busy) return;

    var label = el.downloadAllBtn.textContent;
    el.downloadAllBtn.disabled = true;
    el.downloadAllBtn.textContent = '打包中…';
    try {
      var res = await fetch('/api/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids })
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || ('打包失败（HTTP ' + res.status + '）'));
      }
      var blob = await res.blob();
      saveBlob(blob, '压缩图片-' + new Date().toISOString().slice(0, 10) + '.zip');
    } catch (err) {
      toast(err.message || '打包失败', 'error');
    } finally {
      el.downloadAllBtn.textContent = label;
      render();
    }
  });

  el.clearBtn.addEventListener('click', clearAll);

  el.closeModal.addEventListener('click', closePreview);
  el.modalBackdrop.addEventListener('click', closePreview);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.modal.hidden) closePreview();
  });

  syncSettings();
  render();
})();
