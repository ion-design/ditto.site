<p align="center">
  <img src="docs/assets/ditto.svg" alt="ditto.site 标志" width="112" />
</p>

# [ditto.site](https://ditto.site)

[![CI](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml/badge.svg)](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

ditto.site 可将公开 URL 转换为独立的 TypeScript 应用。它会捕获
浏览器实际渲染的内容，然后默认输出确定性的 Next.js App
Router 项目，也可按需输出 Vite React 项目。

该编译器不是使用 LLM 创作页面，而是一条从捕获到代码的流水线：
输入相同的冻结捕获结果，即可输出字节级稳定的应用。

> **此处的“克隆”是指从实时 URL 生成代码库，而不是 `git clone`。**
> 你不需要已有仓库，也不需要网站源代码。只需让 ditto.site
> 指向一个公开 URL，它就会
> 根据浏览器中渲染的页面编写一个全新项目。

公开的开发与评估方法请参阅
[docs/METHODOLOGY.md](docs/METHODOLOGY.md)。所有文档的索引请参阅
[docs/README.md](docs/README.md)。

## 使用方法

- REST API：`https://api.ditto.site`
- MCP 服务器：`https://api.ditto.site/mcp`

你可以在 `https://www.ditto.site/api-key` 获取托管密钥，也可以直接调用
基于验证邮件的注册流程：

```bash
curl -sS -X POST "https://api.ditto.site/v1/signup/request" \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com"}'
```

邮件中的验证链接会跳转到 `/api-key?token=...`，该页面会调用
`POST /v1/signup/verify`，并显示一次新生成的 `dtto_live_...` 密钥。

> **密钥属于机密信息。** 请将密钥放入环境变量（`export
> DITTO_API_KEY=dtto_live_...`），并在每条命令中引用 `$DITTO_API_KEY`，
> 切勿直接粘贴原始密钥，否则它会留在 shell 历史记录、日志或聊天中。
> 不要提交密钥。你可以随时在控制面板中轮换密钥。

### REST API

启动克隆任务：

```bash
export DITTO_API_URL="https://api.ditto.site"
export DITTO_API_KEY="ditto_live_example"

curl -sS -X POST "$DITTO_API_URL/v1/clones" \
  -H "authorization: Bearer $DITTO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com/",
    "options": {
      "mode": "single",
      "styling": "tailwind",
      "framework": "next"
    }
  }'
```

服务会返回排队中的任务或内联结果。已完成的结果
是一个文件映射，其中每个生成文件都以应用内的相对路径为键：

```json
{
  "jobId": "job_123",
  "status": "succeeded",
  "files": {
    "package.json": { "type": "text", "content": "{ ... }", "bytes": 812, "sha256": "..." },
    "src/app/page.tsx": { "type": "text", "content": "export default ...", "bytes": 2048, "sha256": "..." },
    "public/assets/logo.png": { "type": "binary", "url": ".../files/public/assets/logo.png", "bytes": 5123, "sha256": "..." }
  }
}
```

使用官方解包器**将该 JSON 转换为磁盘上的项目**。请在
已检出且安装好依赖的 `ditto.site` 仓库中直接通过管道传入响应，
无需临时文件：

```bash
curl -sS -X POST "$DITTO_API_URL/v1/clones" \
  -H "authorization: Bearer $DITTO_API_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}' \
  | npm run --silent unpack -- - ./out
```

`npm run unpack -- <clone.json|-> <out-dir>` 会直接写入文本文件，并
生成二进制资源（内联 base64，或使用 `$DITTO_API_URL` /
`$DITTO_API_KEY` 从其 `url` 获取）。CLI 包在 npm 发布方案就绪前仅供仓库内部使用，
因此暂时不要使用 `npx ditto`。选项请参阅
[`packages/cli`](packages/cli/README.md)。

如果返回的是排队任务（`{ "jobId": "job_123", "status": "queued" }`），
请轮询任务，随后解包完成的结果；也可以将整个应用下载为单个
归档文件：

```bash
JOB_ID="job_123"

# poll status, then unpack the finished file map
curl -sS -H "authorization: Bearer $DITTO_API_KEY" \
  "$DITTO_API_URL/v1/clones/$JOB_ID/result" \
  | npm run --silent unpack -- - ./out

# ...or grab the whole app as a single archive
curl -L -H "authorization: Bearer $DITTO_API_KEY" \
  "$DITTO_API_URL/v1/clones/$JOB_ID/bundle?format=tgz" \
  -o ditto-clone.tgz
```

常用选项：

| 选项 | 可选值 | 默认值 |
| --- | --- | --- |
| `mode` | `single`、`multi` | `single` |
| `styling` | `tailwind`、`css` | `tailwind` |
| `framework` | `next`、`vite` | `next` |
| `verify` | `true`、`false` | `false` |
| `asyncVerify` | `true`、`false` | `false` |
| `maxRoutes` | 数字 | 服务默认值 |

REST 端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/clones` | 启动克隆任务 |
| `GET` | `/v1/clones/:id` | 读取任务状态和元数据 |
| `GET` | `/v1/clones/:id/result` | 读取即时文件映射 |
| `GET` | `/v1/clones/:id/files/*` | 流式传输一个生成文件 |
| `GET` | `/v1/clones/:id/bundle?format=tgz` | 下载整个应用 |
| `DELETE` | `/v1/clones/:id` | 删除克隆任务及其产物 |

### MCP

将 MCP 客户端连接到托管的 Streamable HTTP 端点：

```json
{
  "mcpServers": {
    "ditto": {
      "url": "https://api.ditto.site/mcp",
      "headers": {
        "Authorization": "Bearer ${DITTO_API_KEY}"
      }
    }
  }
}
```

MCP 服务器专为智能体设计。它会先返回任务 ID、元数据、清单和
文件引用，然后让智能体只读取所需的文件。

核心 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `clone_website` | 启动克隆任务并返回 `{ jobId, status }` |
| `get_clone_status` | 轮询任务进度 |
| `get_clone_result` | 读取不含文件内容的结果元数据 |
| `list_clone_files` | 列出生成文件的路径、大小和哈希值 |
| `read_clone_files` | 读取选定的文本文件或二进制 URL |
| `get_clone_bundle` | 获取生成应用的下载 URL |

智能体提示词示例：

```text
Use the ditto MCP server to clone https://example.com as a Next.js app.
Wait for the job to finish, list the generated files, then read package.json,
src/app/page.tsx, and src/app/ditto.css.
```

### 本地 CLI

```bash
# this git clone gets the ditto.site tool itself — the URL you clone into a
# codebase comes later, as the argument to `npm run clone`.
git clone https://github.com/ion-design/ditto.site.git
cd ditto.site

npm ci
npx playwright install chromium

npm run clone -- https://example.com/ --out=./output
```

生成的应用位于 `output/<site>/app`。成功后，CLI 会输出一段
可安全复制粘贴的摘要，其中包含一行加引号的 `cd … && npm install && npm run dev`
命令，以及可安全编辑的文件路径（`src/app/content.ts`、
`src/app/components/`；应用中的 `AGENTS.md` 提供完整指南）。

如果希望完全跳过复制粘贴，直接启动运行中的预览：

```bash
npm run clone -- https://example.com/ --serve        # clone, npm install, npm run dev
npm run clone -- https://example.com/ --open         # ...and open the browser too
```

常见的本地运行变体：

```bash
npm run clone -- https://example.com/ --mode=multi
npm run clone -- https://example.com/ --styling=css
npm run clone -- https://example.com/ --framework=vite
npm run validate-site -- runs/site-example.com/<timestamp>
```

未指定 `--out` 时，运行结果会放在 `runs/<site>/<timestamp>/` 下，而稳定的
`runs/<site>/latest` 符号链接始终指向最新克隆，因此脚本和
`cd` 目标无需依赖时间戳。

### 本地 REST 和 MCP 服务

无需数据库的快速内联模式：

```bash
npm ci
npx playwright install chromium

SSRF_ALLOW_LOOPBACK=true npm run dev:api
```

随后调用本地 REST API：

```bash
curl -sS -X POST "http://localhost:8787/v1/clones" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}'
```

如需使用 Postgres 和 MinIO 的队列服务：

```bash
docker compose up -d
cp .env.example .env

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ditto_site \
  npm run db:migrate

npm run dev:api
npm run dev:worker
```

本地 MCP 端点为 `http://localhost:8787/mcp`。

## 生成内容

生成的应用包括：

- 可运行的 Next.js 或 Vite React 项目；
- 重建的页面和路由模块；
- 捕获的资源、字体、图标、清单文件和元数据；
- 可发现时生成的 `robots`、`sitemap`、`llms.txt` 和 JSON-LD；
- 用于已识别交互和动画的轻量 `ditto` 运行时辅助工具；
- 生成的 `AGENTS.md` 和 `ARCHITECTURE.md` 交接文档。

验证期间的交付输出位于 `generated/app/`，CLI 交付时则位于
`<out>/<site>/app`。

## 工作原理

```text
URL
  -> browser capture
  -> normalized render IR
  -> deterministic inference
  -> app generation
  -> asset materialization
  -> optional validation
```

捕获过程会记录 DOM、计算样式、布局框、源元数据、CSS、字体、
资源、截图、交互状态，以及能够安全观测的可复现动画。
不支持的应用逻辑、身份验证、支付、个性化和任意第三方 JavaScript
不会被重放。

服务 API 详解请参阅 [docs/SERVICE.md](docs/SERVICE.md)。部署方法请参阅
[docs/DEPLOY.md](docs/DEPLOY.md)。编译器背后的开发方法请参阅
[docs/METHODOLOGY.md](docs/METHODOLOGY.md)。

托管部署应将 `/v1/clones*` 和 `/mcp` 置于 API 密钥身份验证之后。
在数据库模式下启用 `SIGNUP_ENABLED=true` 时，由 Resend 支持的
`POST /v1/signup/request` 和 `POST /v1/signup/verify` 流程可以通过
验证邮件链接公开生成 `dtto_live_...` 密钥，同时仅存储密钥哈希。
除非明确需要直接、未经身份验证地生成密钥，否则生产环境中应保持
`SIGNUP_DIRECT_ENABLED=false`。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `compiler/` | 确定性捕获、推断、生成和验证 |
| `packages/core/` | 编译器适配器和文件映射辅助工具 |
| `packages/cli/` | `ditto` CLI——将克隆结果 JSON 解包到项目树中 |
| `packages/api/` | Hono REST API 和 MCP 服务器 |
| `packages/db/` | Drizzle 架构、迁移、仓库和队列封装 |
| `packages/storage/` | 本地及 S3/R2 产物存储 |
| `packages/worker/` | 队列克隆运行器和可选验证 |
| `docs/` | 方法、服务、部署、发布和负责任使用文档 |
| `examples/` | 基准测试结果和视觉证据 |

## 负责任使用

仅在你有权检查、复制、转换和操作目标内容时使用 ditto.site。
请勿将其用于网络钓鱼、冒充他人、获取凭据、绕过访问控制，
或未经许可进行大规模第三方捕获。

请参阅 [docs/RESPONSIBLE_USE.md](docs/RESPONSIBLE_USE.md)。

## 贡献

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
```

浏览器测试需要 Chromium。基于 Postgres 的测试使用 `TEST_DATABASE_URL`
或本地 compose 技术栈。改变编译器输出的变更应包含
有针对性的 fixture 或基准测试说明。

本仓库是采用 MIT 许可证的开源项目。在包边界准备好公开发布到 npm 前，
npm 工作区会有意标记为 `private`。

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、
[SUPPORT.md](SUPPORT.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE) © ion-design 及贡献者。
