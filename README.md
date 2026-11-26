# 图片压缩（PixelSafe）

同一个压缩工具的两种形态，各自独立、互不影响：

| 版本 | 位置 | 运行方式 | 适合场景 |
| --- | --- | --- | --- |
| **在线版（纯静态）** | `web/` | 部署在 GitHub Pages，浏览器内 WASM 编码 | 随手压图，打开就能用，图片不上传 |
| **本地服务版（Node）** | `server/` + `public/` | 本机跑 Express + `sharp`，监听 `127.0.0.1` | 大批量、大图，或用自己服务器长期部署 |

在线版地址：<https://myjustify.github.io/lossless-image-compressor/>

两者的共同点：都能做到 **PNG 像素级无损**（输出回读解码、逐字节比对通过才标记「像素一致」），并且**压缩后不小于原图时一律保留原文件**，绝不产出更大的结果。

---

## 一、在线版（静态，浏览器内 WASM）

`web/` 是一个 Vite 工程，把 Squoosh 的解码器编译产物搬进浏览器：

- **PNG 无损**：`oxipng` 直接对原始 PNG 字节做重压缩（只改滤波与压缩参数，像素不变）
- **PNG / WebP 无损**：`libwebp` 无损模式作为第二候选，体积更小就用它
- **JPEG / WebP 有损**：`mozjpeg`（progressive + 4:2:0 + trellis）按画质重编码
- **并发**：按 CPU 核数开 2–3 个 Web Worker，多张图并行；编码在主线程之外，界面不卡
- **画质如实标注**：有损结果会解码回来算 PSNR，≥40dB 才标「视觉无损」，36–40dB 标「画质接近」，更低直接标「有损重编码」

### 本地开发

```bash
cd web
pnpm install
pnpm dev      # http://localhost:5174
pnpm build    # 产物在 web/dist
```

`web/dist` 是纯静态目录，丢到任何静态托管（Pages / Netlify / Nginx / 对象存储）都能直接跑，不依赖 Node。

### 部署到 GitHub Pages

仓库里带了 `.github/workflows/pages.yml`：推到 `main` 后自动构建 `web/dist` 并发布。首次使用时在仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**（或让 `actions/configure-pages` 自动开启），之后每次改动 `web/` 都会自动更新。

因为产物用相对路径（`base: './'`），放在 `/<仓库名>/` 这种子路径下也能正常工作。

### 在线版的边界

- 图片全程在浏览器内处理，**不会发往任何服务器**，断网也能用（首次加载后）
- 受浏览器内存限制：单张建议 ≤40MB（工具会拦截），超大的图可能触发内存不足
- 首次使用要下载约 1.5MB 的 wasm 编码器，之后走浏览器缓存
- GIF 只取首帧；TIFF 交给浏览器解码，多数浏览器不支持
- 不支持 AVIF 编码（wasm 体积 3MB+ 且编码很慢），AVIF 源会被正常解码后转成 PNG/WebP
- 元数据（EXIF / ICC）不保留

---

## 二、本地服务版（Node + sharp）

前端只负责界面，压缩交给 `sharp`（libvips / mozjpeg / libwebp）。服务默认只监听 `127.0.0.1`，图片不出本机。

### 快速开始

```bash
pnpm install
pnpm start
# 打开 http://127.0.0.1:5173
```

> 需要 Node 18+。`sharp` 会自动安装对应平台的预编译二进制，无需本地编译 libvips。

开发时用 `pnpm dev`（Node 的 `--watch` 自动重启）。

### 用 PM2 管理

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
>
> 若在注入了 `NODE_OPTIONS` 的终端里启动失败，配置里的 `NODE_OPTIONS: ''` 已经处理掉这个情况。

### 压缩策略

| 源格式 | 严格无损模式 | 智能模式 |
| --- | --- | --- |
| PNG | 尝试 PNG 无损 + WebP 无损，取最小且逐像素校验通过者 | 先试无损，收益太小则调色板量化 |
| JPEG / HEIC | 直接保留原图（源本身有损，重编码只会更大） | JPEG / WebP / AVIF 重编码，画质阶梯自动降级 |
| WebP | WebP 无损，校验通过才用 | 先试无损，不行再走有损 |
| AVIF | 保留原图 | AVIF 重编码 |
| TIFF | 转 PNG 无损并校验 | 转 PNG |
| GIF | 保留原图 | 保留原图 |

任何情况下，**如果压缩后没有变小，就直接保留原文件**。

### API

- `POST /api/compress` — `multipart/form-data`
  - `files`：一个或多个图片（最多 20 个，单个 60MB）
  - `mode`：`auto` | `lossless`
  - `quality`：40–100，智能模式画质
  - `photoFormat`：`jpeg` | `webp` | `avif`
- `GET /api/file/:id` — 预览；加 `?download=1` 下载
- `POST /api/zip` — `{ ids: [...] }`，返回 ZIP

### 本地服务版的边界

- 不保留 EXIF / ICC 元数据（libvips 输出时默认丢弃，sRGB 图像无影响）
- GIF 只做保留原图处理，暂不支持动图优化
- 结果存在内存中，30 分钟或服务重启后失效
- 单张上限 60MB / 5000 万像素

---

## 目录结构

```
lossless-image-compressor/
├── web/                        # 在线版：纯静态，可上 GitHub Pages
│   ├── index.html
│   ├── src/
│   │   ├── main.js             # 界面交互、批量调度、打包下载
│   │   ├── worker.js           # 压缩内核：解码 / 编码 / 像素校验 / PSNR
│   │   ├── pool.js             # Worker 池，文件级并发
│   │   ├── format.js           # 文件头识别与体积格式化
│   │   └── style.css
│   └── vite.config.js
├── server/                     # 本地服务版
│   ├── index.js                # Express 服务、上传接口、下载与打包
│   ├── compressor.js           # 各格式压缩策略 + 逐像素无损校验
│   └── store.js                # 结果临时存储（内存，30 分钟过期）
├── public/                     # 本地服务版的页面
├── ecosystem.config.cjs        # PM2 配置
└── .github/workflows/pages.yml # 自动构建并发布在线版
```

## 无损是怎么保证的

两个版本的思路一致：把原图和输出都解码成统一的 RGBA 像素，逐字节比较，只有完全相同才标记「像素一致」。

- 在线版在 Worker 里用对应格式的 WASM 解码器回读输出（PNG 用 `squoosh_png`，WebP 用 `libwebp`），再和原图解码结果逐字节比对
- 本地服务版用 `sharp` 把两边都解成 raw RGBA 再比

前端没有能力“自证”无损，标记来自这次真实比对的结果。

## 性能参考

Apple Silicon 实测，合成测试图（真实照片的 JPEG 收益通常更高）：

| 场景 | 在线版 | 本地服务版 |
| --- | --- | --- |
| 16.3MB PNG（3000×2000）无损 | 11.3MB（-30.7%），2.3s | 10.8MB WebP 无损（-37%），2.1s |
| 1.24MB JPEG → q85 | 707KB（-44.2%），0.86s | 596KB（-54%），0.36s |
| 1.24MB JPEG → WebP q80 | 439KB（-65.3%），0.70s | — |
| 800×600 简单 PNG 无损 | 5.2KB（-64.7%），0.18s | 2.7KB，约 0.05s |

后端 `sharp` 依然更快、压缩率略好；在线版胜在免部署、图片不出本机。

## 许可

MIT。依赖库：express、multer、sharp、jszip、vite、@jsquash/*（Squoosh 的 WASM 编解码器），均为开源项目。
