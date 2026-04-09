#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Runs openclaw onboard --non-interactive to configure from env vars
# 2. Patches config for features onboard doesn't cover (channels, gateway auth)
# 3. Starts the gateway
#
# NOTE: Persistence (backup/restore) is handled by the Sandbox SDK at the
# Worker level, not inside the container. The Worker calls createBackup()
# and restoreBackup() which use squashfs snapshots stored in R2.
# No rclone or R2 credentials are needed inside the container.

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    # Determine auth choice — openclaw onboard reads the actual key values
    # from environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    # so we only pass --auth-choice, never the key itself, to avoid
    # exposing secrets in process arguments visible via ps/proc.
    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID"
    elif [ -n "$ZAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice zai-api-key"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Workspace configuration
// デフォルトは ~/.openclaw/workspace だが、skills を /home/openclaw/clawd/skills に
// 置いているためワークスペースを明示的に指定する
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.workspace = '/home/openclaw/clawd';

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Allow any origin to connect to the gateway control UI.
// The gateway runs inside a Cloudflare Container behind the Worker, which
// proxies requests from the public workers.dev domain. Without this,
// openclaw >= 2026.2.26 rejects WebSocket connections because the browser's
// origin (https://....workers.dev) doesn't match the gateway's localhost.
// Security is handled by CF Access + gateway token auth, not origin checks.
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: providerName + '/' + modelId };
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Z.AI (GLM) model configuration with Gemini fallback
if (process.env.ZAI_API_KEY) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    const fallbacks = [];
    if (process.env.GEMINI_API_KEY) fallbacks.push('google/gemini-2.5-flash');
    config.agents.defaults.model = fallbacks.length > 0
        ? { primary: 'zai/glm-4.7', fallbacks }
        : { primary: 'zai/glm-4.7' };
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}


// ============================================================
// MCP SERVERS
// ============================================================

// GitHub Issue 起票に @modelcontextprotocol/server-github を使用する
if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries.acpx = config.plugins.entries.acpx || { enabled: true, config: {} };
    config.plugins.entries.acpx.config = config.plugins.entries.acpx.config || {};
    config.plugins.entries.acpx.config.mcpServers = config.plugins.entries.acpx.config.mcpServers || {};
    config.plugins.entries.acpx.config.mcpServers.github = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
        },
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');

// ============================================================
// WORKSPACE FILES
// ============================================================

const workspaceDir = '/home/openclaw/clawd';
fs.mkdirSync(workspaceDir, { recursive: true });

// SOUL.md: 行動原則・委譲ルール（毎回上書き — デプロイで常に最新を反映）
fs.writeFileSync(workspaceDir + '/SOUL.md', `# Identity

あなたは haruvv の専属アシスタント「clawd」。
チャットに常駐し、あらゆるタスクの受付・整理・委譲を担う。
名前・口調・性格の詳細は IDENTITY.md を参照すること。

# Language

ユーザーへの返答は必ず日本語で行う。
思考・内部処理は英語でよいが、出力は日本語。

# Role

- ユーザーからの依頼を受け取り、性質を判断して適切なエージェントに委譲する
- 開発タスク（コード実装・バグ修正・機能追加・デプロイ）は自分では行わず dev team に委ねる
- 調査・要約・調整などの軽作業は自分で対応する
- タスクの進捗を把握し、完了報告をユーザーに届ける

# Behavior

- 実装は引き受けない。dev-team スキルで委譲する
- 曖昧な依頼はまず要件を確認してから動く
- 報告は簡潔に。余計な前置きや謝辞は不要
- ユーザーが忙しいことを前提に、必要最小限の確認で進める

# Task Delegation（開発タスクの委譲手順）

コード実装・バグ修正・機能追加・デプロイなど開発を伴うタスクは以下の手順で委譲する。

1. ユーザーの意図から実装仕様を整理する
   - 何を作るか
   - どこにデプロイするか（Cloudflare Workers / Pages / dev 環境など）
   - 完成の判断基準

2. GitHub MCP の create_issue でリポジトリ haruvv/openclaw-dev に Issue を起票する
   - title: 一行で概要を表すタイトル
   - body: 整理した仕様（要件・デプロイ先・完成基準を含める）
   - labels: ["ai-dev"] ← **必ずこの値のみ**。enhancement など他のラベルは絶対に使わない
   - Issue は1件にまとめる。複数の sub-issue に分割しない

3. ユーザーに「着手しました。完了したら通知します」と返す

4. Telegram に完了通知が来たら成果物を確認する
   - 問題なければ URL と概要をユーザーに報告する
   - 問題があれば追加の Issue を起票して再依頼する（最大3回）
`);

// USER.md: ユーザープロフィール（毎回上書き）
fs.writeFileSync(workspaceDir + '/USER.md', `# User Profile

**Name**: haruvv
**Role**: 開発者・アーキテクト
**Project**: 自律エージェント基盤の設計・開発

# Context

- 自律エージェントを組み合わせたプラットフォームを構築中
- OpenClaw をチャット常駐ハブとして使い、専門エージェントに委譲する構成
- 開発作業は別エージェント（dev team）に任せる方針

# Preferences

- 返答は簡潔でよい
- 実装の細部より全体方針を重視する
- 日本語でコミュニケーションする
`);

// IDENTITY.md: 名前・口調・性格（初回のみ作成 — チャットで育てる）
const identityPath = workspaceDir + '/IDENTITY.md';
if (!fs.existsSync(identityPath)) {
    fs.writeFileSync(identityPath, `# Identity

まだ何も決まっていない。
haruvv との会話を通じて、名前・口調・性格を育てていく。
`);
    console.log('IDENTITY.md created (first boot)');
}

// MEMORY.md: エージェントが自律的に書き込む動的メモリ（初回のみ作成 — 上書きしない）
// OpenClaw が学習した内容・ユーザーの癖・過去の決定を蓄積する。
// start-openclaw.sh が上書きすると学習内容が消えるため、初回作成のみ行う。
const memoryPath = workspaceDir + '/MEMORY.md';
if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, `# Memory

エージェントが会話を通じて学習した内容を記録する。
このファイルは clawd が自律的に更新する。手動編集も可。
`);
    console.log('MEMORY.md created (first boot)');
}

EOFPATCH

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

# Gateway token (if set) is already written to openclaw.json by the config
# patch above (gateway.auth.token). We deliberately avoid passing --token on
# the command line because CLI arguments are visible to all processes in the
# container via ps/proc.
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
else
    echo "Starting gateway with device pairing (no token)..."
fi
exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
