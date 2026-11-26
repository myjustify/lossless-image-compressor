# 图片压缩（PixelSafe）

本地运行的图片压缩工具：前端提供界面，后端用 Node + `sharp`（libvips / mozjpeg / libwebp）执行压缩。服务默认只监听 `127.0.0.1`，图片不会上传到外部网络。

- **严格无损模式**：PNG / WebP 重新编码后回读解码，逐像素比对，完全一致才标记「像素一致」
- **智能模式**：按源格式选真正能减小体积的方案，JPEG 照片走高质量重编码

## 为什么从纯前端改成后端

第一版是纯浏览器方案（canvas + UPNG.js），实际使用暴露了三个硬伤：

1. **慢**：PNG 的 deflate 编码是单线程 JS，1200 万像素的图要跑好几秒
2. **压缩率差**：浏览器里没有 mozjpeg / libwebp / pngquant 这类专业编码器
3. **策略受限**：JPEG 转 PNG 会膨胀约 3 倍，前端拿不到更合适的编码工具，只能输出更大的文件

后端用 `sharp` 调 C 库，同样一张图通常百毫秒级完成，压缩率也明显更好。

## 快速开始

```bash
cd lossless-image-compressor
pnpm install
pnpm start
# 打开 http://127.0.0.1:5173
```

> 需要 Node 18+。`sharp` 会自动安装对应平台的预编译二进制，无需本地编译 libvips。

开发时可用 `pnpm dev`（Node 的 `--watch` 自动重启）。

## 用 PM2 管理

```bash
pnpm pm2:start     # 按 ecosystem.config.cjs 启动
pnpm pm2:status    # 查看进程状态
pnpm pm2:logs      # 查看实时日志
pnpm pm2:restart   # 重启
pnpm pm2:stop      # 停止
pnpm pm2:delete    # 从 PM2 列表移除
```

开机自启（需要一次管理员授权，会打印一条 `sudo ...` 命令）：

```bash
pnpm exec pm2 startup
pnpm exec pm2 save
```

> 配置固定为**单实例 fork 模式**：压缩结果存在进程内存里，若改成 cluster 多实例，下载请求可能落到没有该结果的进程上而 404。

## 目录结构

```
lossless-image-compressor/
├── server/
│   ├── index.js        # Express 服务、上传接口、下载与打包
│   ├── compressor.js   # 各格式压缩策略 + 逐像素无损校验
│   └── store.js        # 结果临时存储（内存，30 分钟过期）
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js       # 前端交互，只负责调用接口
├── package.json
└── pnpm-lock.yaml
```

## 压缩策略

| 源格式 | 严格无损模式 | 智能模式 |
| --- | --- | --- |
| PNG | 尝试 PNG 无损 + WebP 无损，取最小且逐像素校验通过者 | 先试无损，收益太小则调色板量化 |
| JPEG / HEIC | 直接保留原图（源本身有损，重编码只会更大） | JPEG / WebP / AVIF 重编码，画质阶梯自动降级 |
| WebP | WebP 无损，校验通过才用 | 先试无损，不行再走有损 |
| AVIF | 保留原图 | AVIF 重编码 |
| TIFF | 转 PNG 无损并校验 | 转 PNG |
| GIF | 保留原图 | 保留原图 |

任何情况下，**如果压缩后没有变小，就直接保留原文件**，不会产出更大的文件。

## 无损是怎么保证的

1. `sharp` 把原图和输出都解码成统一的 RGBA raw 像素（都先按 EXIF 旋转对齐）；
2. 比较两个 Buffer 是否逐字节相同；
3. 只有相同才返回 `lossless: true, verified: true`，前端才显示「像素一致」。

前端的「像素一致」不是自己声明的，来自服务端这次真实比对的结果。

## API

- `POST /api/compress` — `multipart/form-data`
  - `files`：一个或多个图片（最多 20 个，单个 60MB）
  - `mode`：`auto` | `lossless`
  - `quality`：40–100，智能模式画质
  - `photoFormat`：`jpeg` | `webp` | `avif`
- `GET /api/file/:id` — 预览；加 `?download=1` 下载
- `POST /api/zip` — `{ ids: [...] }`，返回 ZIP

## 性能参考

在 Apple Silicon 上实测（合成测试图，非真实照片）：

| 场景 | 结果 |
| --- | --- |
| 15.2KB PNG → 严格无损 | 2.7KB WebP 无损，像素完全一致 |
| 271KB 高噪点 JPEG → 智能 q85 | 207KB（-26%），真实照片通常 -40%~-70% |
| 1200×900 JPEG 单张处理 | 约 0.1–0.4 秒 |

## 限制

- 不保留 EXIF / ICC 元数据（libvips 输出时默认丢弃，sRGB 图像无影响）
- GIF 只做保留原图处理，暂不支持动图优化
- 结果存在内存中，30 分钟或服务重启后失效
- 单张上限 60MB / 5000 万像素

## 许可

MIT。依赖库：express、multer、sharp、jszip，均为开源项目。
