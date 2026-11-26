import CompressorWorker from './worker.js?worker';

/**
 * 极简 Worker 池：文件级并发，每个 Worker 一次只处理一张图。
 * 压缩本身在 WASM 里跑，开 2-3 个 Worker 基本能占满多核，又不会耗尽内存。
 */
export function createPool(size, wasmBase) {
  const total = Math.max(1, size);
  const workers = [];
  const idle = [];
  const queue = [];
  const pending = new Map();
  let seq = 0;
  let disposed = false;
  let respawns = 0;

  function createWorker() {
    // Vite 的 ?worker 导出的是一个返回 Worker 的构造函数
    const worker = new CompressorWorker({ name: 'compressor' });
    worker.postMessage({ type: 'config', wasmBase });
    return worker;
  }

  function spawn() {
    let worker;
    try {
      worker = createWorker();
    } catch (err) {
      return null;
    }

    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'stage') {
        worker.__stage = msg.stage;
        const running = pending.get(msg.id);
        if (running && running.stageCb) running.stageCb(msg.stage);
        return;
      }
      const task = pending.get(msg.id);
      pending.delete(msg.id);
      if (worker.__current === task) worker.__current = null;
      if (task) {
        if (msg.ok === false) task.reject(new Error(msg.error || '压缩失败'));
        else task.resolve(msg);
      }
      idle.push(worker);
      drain();
    };

    worker.onerror = (event) => {
      const task = worker.__current;
      const reason = (event && (event.message || event.filename)) || '编码器线程异常';
      if (task) {
        task.reject(new Error(reason));
        pending.delete(task.id);
      }
      const index = idle.indexOf(worker);
      if (index >= 0) idle.splice(index, 1);
      const wi = workers.indexOf(worker);
      if (wi >= 0) workers.splice(wi, 1);
      try { worker.terminate(); } catch (err) { /* 忽略 */ }
      // 允许少量重试，但避免反复崩溃导致无限重启
      if (!disposed && respawns < 3) {
        respawns++;
        spawn();
      }
      drain();
    };

    workers.push(worker);
    idle.push(worker);
    return worker;
  }

  function drain() {
    while (idle.length && queue.length) {
      const worker = idle.pop();
      const task = queue.shift();
      worker.__current = task;
      pending.set(task.id, task);
      worker.postMessage(task.payload, [task.payload.buffer]);
    }
  }

  for (let i = 0; i < total; i++) spawn();

  return {
    size: total,
    run(payload, stageCb) {
      return new Promise((resolve, reject) => {
        const task = {
          id: ++seq,
          stageCb,
          payload: Object.assign({ id: seq, type: 'job' }, payload),
          resolve,
          reject
        };
        queue.push(task);
        drain();
      });
    },
    dispose() {
      disposed = true;
      workers.forEach((w) => { try { w.terminate(); } catch (err) { /* 忽略 */ } });
      workers.length = 0;
      idle.length = 0;
    }
  };
}
