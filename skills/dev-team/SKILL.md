---
name: dev-team
description: Delegate development tasks (code implementation, bug fixes, feature additions, deployments) to the dev team. The dev team runs Claude Code via GitHub Actions and deploys directly to production without review.
---

# Dev Team Delegation

コード実装・バグ修正・機能追加・デプロイを dev team に委譲する。
dev team は Claude Code（GitHub Actions）が担当し、実装後は本番環境に自動デプロイする。

## When to use

- コード実装・バグ修正・機能追加
- Cloudflare Workers / Pages へのデプロイ
- ファイル編集や git コミットを伴うすべての作業

## 委譲手順

1. 仕様を整理する（何を作るか・デプロイ先・完成基準）

2. dev-team API に task を作成する

```bash
node skills/dev-team/scripts/run-task.js \
  --spec "<仕様詳細>" \
  --callback-url "$OPENCLAW_GATEWAY_URL" \
  --callback-token "$OPENCLAW_GATEWAY_TOKEN" \
  --label "ai-dev"
```

3. 返ってきた `task_id` を控え、ユーザーに「着手しました。完了したら通知します」と返す

4. 状態確認が必要な場合は task を取得する

```bash
node skills/dev-team/scripts/get-task.js --task-id "<task_id>"
```

## 完了通知

Telegram に完了通知が来たら成果物を確認する。
- 成功: URL と概要をユーザーに報告する
- 失敗: 追加の Issue を起票して再依頼する（最大3回）

## Notes

- PR レビューは不要。dev team が main に直接プッシュして本番デプロイする
- Issue の body に「dev 環境」と書くと dev 環境にデプロイされる
- `$DEV_TEAM_MCP_URL` と `$DEV_TEAM_MCP_TOKEN` は環境変数として利用可能
- fallback が必要な場合のみ GitHub Issue 直接起票を検討する
