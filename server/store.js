const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;          // 结果保留 30 分钟
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 内存上限 512MB

const items = new Map();
let totalBytes = 0;

function sweep() {
  const now = Date.now();
  for (const [id, item] of items) {
    if (now - item.at > TTL_MS) {
      totalBytes -= item.buffer.length;
      items.delete(id);
    }
  }
  while (totalBytes > MAX_TOTAL_BYTES && items.size > 0) {
    const oldestId = items.keys().next().value;
    const item = items.get(oldestId);
    totalBytes -= item.buffer.length;
    items.delete(oldestId);
  }
}

function put(buffer, mime, name) {
  sweep();
  const id = crypto.randomUUID();
  items.set(id, { buffer, mime, name, at: Date.now() });
  totalBytes += buffer.length;
  return id;
}

function get(id) {
  return items.get(id) || null;
}

const timer = setInterval(sweep, 60 * 1000);
timer.unref();

module.exports = { put, get, sweep };
