/**
 * PM2 配置
 * 启动：pnpm pm2:start      或  pm2 start ecosystem.config.cjs
 * 查看：pnpm pm2:status
 * 日志：pnpm pm2:logs
 * 停止：pnpm pm2:stop
 *
 * 注意：压缩结果保存在进程内存中，因此必须是单实例 fork 模式。
 * 改成 cluster 会导致「下载」请求落到没有该结果的进程上，出现 404。
 */
module.exports = {
  apps: [
    {
      name: 'image-compressor',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 5000,
      time: true,
      merge_logs: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 5173,
        // 部分 IDE / 沙箱终端会注入 NODE_OPTIONS 预加载脚本，
        // PM2 子进程继承后可能启动失败，这里显式清空。
        NODE_OPTIONS: ''
      }
    }
  ]
};
