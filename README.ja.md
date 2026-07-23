<p align="center">
  <img src="docs/assets/ditto.svg" alt="ditto.site ロゴ" width="112" />
</p>

# [ditto.site](https://ditto.site)

[![CI](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml/badge.svg)](https://github.com/ion-design/ditto.site/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

ditto.site は、公開 URL を自己完結型の TypeScript アプリへ変換します。
ブラウザーが実際にレンダリングした内容をキャプチャし、デフォルトでは決定論的な
Next.js App Router プロジェクトを、指定に応じて Vite React を出力します。

このコンパイラーは、LLM によるページ作成ツールではありません。同じ
固定済みキャプチャを入力すると、バイト単位で安定したアプリを出力するキャプチャ・ツー・コードのパイプラインです。

> **ここでの「クローン」とは、`git clone` ではなく、稼働中の URL からコードベースを生成することです。**
> 既存のリポジトリも、サイトのソースも必要ありません。ditto.site に
> 公開 URL を指定すると、ブラウザーでレンダリングされたページを基に
> 新しいプロジェクトを作成します。

公開されている開発・評価手法については
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) を参照してください。全ドキュメントの一覧は
[docs/README.md](docs/README.md) にあります。

## 使い方

- REST API：`https://api.ditto.site`
- MCP サーバー：`https://api.ditto.site/mcp`

`https://www.ditto.site/api-key` でホスト済みキーを取得するか、
メール検証付きサインアップフローを直接呼び出します。

```bash
curl -sS -X POST "https://api.ditto.site/v1/signup/request" \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com"}'
```

メールで届く検証リンクは `/api-key?token=...` に移動し、そこで
`POST /v1/signup/verify` が呼び出され、新しい `dtto_live_...` キーが一度だけ表示されます。

> **キーは機密情報です。** キーを環境変数に格納し（`export
> DITTO_API_KEY=dtto_live_...`）、すべてのコマンドで `$DITTO_API_KEY` を参照してください。
> 生のキーを直接貼り付けると、シェル履歴、ログ、チャットに残るため、絶対に避けてください。
> キーをコミットしないでください。キーはダッシュボードからいつでもローテーションできます。

### REST API

クローンジョブを開始します。

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

サービスは、キューに入ったジョブまたはインライン結果を返します。完了した結果は
ファイルマップであり、生成された各ファイルがアプリ内の相対パスをキーとして格納されます。

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

公式アンパッカーを使って、**この JSON をディスク上のプロジェクトへ変換**します。
依存関係をインストール済みのチェックアウトされた `ditto.site` リポジトリから、
一時ファイルを作らずにレスポンスをそのままパイプで渡します。

```bash
curl -sS -X POST "$DITTO_API_URL/v1/clones" \
  -H "authorization: Bearer $DITTO_API_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}' \
  | npm run --silent unpack -- - ./out
```

`npm run unpack -- <clone.json|-> <out-dir>` はテキストファイルを直接書き出し、
バイナリアセットを実体化します（インライン base64、または
`$DITTO_API_URL` / `$DITTO_API_KEY` を使って各 `url` から取得）。CLI パッケージは
npm での配布準備が整うまでリポジトリ内専用なので、まだ `npx ditto` は使用しないでください。
オプションについては [`packages/cli`](packages/cli/README.md) を参照してください。

キューに入ったジョブ（`{ "jobId": "job_123", "status": "queued" }`）が返された場合は、
完了までポーリングして結果を展開するか、アプリ全体を単一の
アーカイブとしてダウンロードします。

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

主なオプション：

| オプション | 値 | デフォルト |
| --- | --- | --- |
| `mode` | `single`、`multi` | `single` |
| `styling` | `tailwind`、`css` | `tailwind` |
| `framework` | `next`、`vite` | `next` |
| `verify` | `true`、`false` | `false` |
| `asyncVerify` | `true`、`false` | `false` |
| `maxRoutes` | 数値 | サービスのデフォルト |

REST エンドポイント：

| メソッド | パス | 用途 |
| --- | --- | --- |
| `POST` | `/v1/clones` | クローンを開始 |
| `GET` | `/v1/clones/:id` | ジョブのステータスとメタデータを取得 |
| `GET` | `/v1/clones/:id/result` | 即時ファイルマップを取得 |
| `GET` | `/v1/clones/:id/files/*` | 生成されたファイルを 1 件ストリーミング |
| `GET` | `/v1/clones/:id/bundle?format=tgz` | アプリ全体をダウンロード |
| `DELETE` | `/v1/clones/:id` | クローンとその生成物を削除 |

### MCP

MCP クライアントを、ホストされている Streamable HTTP エンドポイントへ接続します。

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

MCP サーバーはエージェント向けに設計されています。まずジョブ ID、メタデータ、
マニフェスト、ファイル参照を返し、その後エージェントが必要なファイルだけを読み取れるようにします。

主要な MCP ツール：

| ツール | 用途 |
| --- | --- |
| `clone_website` | クローンを開始し、`{ jobId, status }` を返す |
| `get_clone_status` | ジョブの進行状況をポーリング |
| `get_clone_result` | ファイル内容を含まない結果メタデータを取得 |
| `list_clone_files` | 生成ファイルのパス、サイズ、ハッシュを一覧表示 |
| `read_clone_files` | 選択したテキストファイルまたはバイナリ URL を読み取る |
| `get_clone_bundle` | 生成されたアプリのダウンロード URL を取得 |

エージェント向けプロンプトの例：

```text
Use the ditto MCP server to clone https://example.com as a Next.js app.
Wait for the job to finish, list the generated files, then read package.json,
src/app/page.tsx, and src/app/ditto.css.
```

### ローカル CLI

```bash
# this git clone gets the ditto.site tool itself — the URL you clone into a
# codebase comes later, as the argument to `npm run clone`.
git clone https://github.com/ion-design/ditto.site.git
cd ditto.site

npm ci
npx playwright install chromium

npm run clone -- https://example.com/ --out=./output
```

生成されたアプリは `output/<site>/app` に配置されます。成功すると CLI は、
コピー＆ペーストしても安全な概要を出力します。これには引用符で囲まれた
`cd … && npm install && npm run dev` の 1 行と、安全に編集できるファイルへの参照
（`src/app/content.ts`、`src/app/components/`。完全なガイドはアプリの `AGENTS.md`）
が含まれます。

コピー＆ペーストを省き、そのまま実行中のプレビューを開くには：

```bash
npm run clone -- https://example.com/ --serve        # clone, npm install, npm run dev
npm run clone -- https://example.com/ --open         # ...and open the browser too
```

一般的なローカル実行のバリエーション：

```bash
npm run clone -- https://example.com/ --mode=multi
npm run clone -- https://example.com/ --styling=css
npm run clone -- https://example.com/ --framework=vite
npm run validate-site -- runs/site-example.com/<timestamp>
```

`--out` を指定しない場合、実行結果は `runs/<site>/<timestamp>/` に保存され、
安定した `runs/<site>/latest` シンボリックリンクが常に最新のクローンを指すため、
スクリプトや `cd` の対象がタイムスタンプに依存しません。

### ローカル REST および MCP サービス

データベースを使わない簡易インラインモード：

```bash
npm ci
npx playwright install chromium

SSRF_ALLOW_LOOPBACK=true npm run dev:api
```

続いてローカル REST API を呼び出します。

```bash
curl -sS -X POST "http://localhost:8787/v1/clones" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}'
```

Postgres と MinIO を使用するキューサービスの場合：

```bash
docker compose up -d
cp .env.example .env

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ditto_site \
  npm run db:migrate

npm run dev:api
npm run dev:worker
```

ローカル MCP エンドポイントは `http://localhost:8787/mcp` です。

## 生成されるもの

生成されたアプリには次のものが含まれます。

- 実行可能な Next.js または Vite React プロジェクト
- 再構築されたページおよびルートモジュール
- キャプチャされたアセット、フォント、アイコン、マニフェストファイル、メタデータ
- 検出できた場合の `robots`、`sitemap`、`llms.txt`、JSON-LD
- 認識されたインタラクションやモーション向けの小さな `ditto` ランタイムヘルパー
- 生成された `AGENTS.md` と `ARCHITECTURE.md` の引き継ぎドキュメント

検証中の成果物は `generated/app/` に、CLI での配布時は
`<out>/<site>/app` に出力されます。

## 仕組み

```text
URL
  -> browser capture
  -> normalized render IR
  -> deterministic inference
  -> app generation
  -> asset materialization
  -> optional validation
```

キャプチャでは、DOM、計算済みスタイル、レイアウトボックス、ソースメタデータ、
CSS、フォント、アセット、スクリーンショット、インタラクション状態、および安全に
観測できる再現可能なモーションを記録します。未対応のアプリロジック、認証、決済、
パーソナライズ、任意のサードパーティ JavaScript は再生されません。

サービス API の詳細は [docs/SERVICE.md](docs/SERVICE.md)、デプロイについては
[docs/DEPLOY.md](docs/DEPLOY.md)、コンパイラーの開発手法については
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) を参照してください。

ホスト環境では `/v1/clones*` と `/mcp` を API キー認証で保護してください。
DB モードで `SIGNUP_ENABLED=true` の場合、Resend を利用する
`POST /v1/signup/request` と `POST /v1/signup/verify` のフローにより、
検証済みメールリンクから `dtto_live_...` キーを公開発行しつつ、キーのハッシュのみを保存できます。
認証なしの直接発行を意図していない限り、本番環境では
`SIGNUP_DIRECT_ENABLED=false` を維持してください。

## リポジトリ構成

| パス | 用途 |
| --- | --- |
| `compiler/` | 決定論的なキャプチャ、推論、生成、検証 |
| `packages/core/` | コンパイラーアダプターとファイルマップヘルパー |
| `packages/cli/` | クローン結果 JSON をプロジェクトツリーへ展開する `ditto` CLI |
| `packages/api/` | Hono REST API と MCP サーバー |
| `packages/db/` | Drizzle スキーマ、マイグレーション、リポジトリ、キューラッパー |
| `packages/storage/` | ローカルおよび S3/R2 の生成物ストレージ |
| `packages/worker/` | キュー形式のクローンランナーとオプションの検証 |
| `docs/` | 手法、サービス、デプロイ、リリース、責任ある利用のドキュメント |
| `examples/` | ベンチマーク結果と視覚的な検証資料 |

## 責任ある利用

対象コンテンツを調査、コピー、変換、運用する権利がある場合にのみ
ditto.site を使用してください。フィッシング、なりすまし、認証情報の取得、
アクセス制御の回避、許可のない大量のサードパーティキャプチャには使用しないでください。

[docs/RESPONSIBLE_USE.md](docs/RESPONSIBLE_USE.md) を参照してください。

## コントリビューション

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
```

ブラウザーテストには Chromium が必要です。Postgres を使用するテストは
`TEST_DATABASE_URL` またはローカルの compose スタックを使います。
コンパイラーの出力を変更する場合は、対象を絞った fixture またはベンチマークの説明を含めてください。

このリポジトリは MIT ライセンスのオープンソースです。npm での公開に向けて
パッケージ境界の準備が整うまで、npm ワークスペースは意図的に `private`
とされています。

[CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、
[SUPPORT.md](SUPPORT.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) を参照してください。

## ライセンス

[MIT](LICENSE) © ion-design およびコントリビューター。
