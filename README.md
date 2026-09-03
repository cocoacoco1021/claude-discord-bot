# claude-discord-bot

スマホのDiscordから、このMacで動くClaude Codeを呼べるAI秘書ボットです。

## Context（役割）

- Discordのメッセージと添付画像をClaude Codeへ渡し、返答をDiscordへ返す
- 持ち主以外のメッセージには応答しない
- 取り消せない操作は、実行前にDiscordで確認を取る

## Structure（構成）

| ファイル | 責務 |
|---|---|
| `bot.js` | Discord受信、Claude実行、Discord返信 |
| `claude-command.js` | Claude CLIの新規・継続呼び出し設定 |
| `claude-response.js` | Claude CLI応答の解析、利用上限などのエラー分類 |
| `session-policy.js` | 新規会話コマンド、自動更新の閾値、引き継ぎ文面 |
| `session-lifecycle.js` | 要約作成、新旧セッションの切替、利用量の更新 |
| `session-store.js` | Claude会話ID・会話数・文脈量・要約の保存と復元 |
| `discord-images.js` | Discord添付画像の検証・取得・一時保存・後始末 |
| `session.json` | 現在の会話ID。自動生成・外部公開対象外 |
| `test/` | 会話継続、保存・復元、画像処理のテスト |
| `.env` | Discordトークンなどの秘密設定。雛形は `.env.example` |

## Usage（使い方）

```bash
npm start
```

2回目以降のメッセージは、保存済みの会話IDを `claude --resume` へ渡します。`session.json` を読み込むため、BotやMacを再起動しても同じ会話を継続します。

Claude側の利用上限やログイン切れでは会話IDを消さず、Discordへ原因を表示します。存在しない会話IDが返された場合だけ、新しい会話で1回再試行します。

## セッションの更新

- Discordで `!new` と送ると、現在の会話を3,000文字以内へ要約し、新しい会話へ切り替える。
- `!new fresh` は引き継ぎなしで切り替える。旧会話ログ自体は削除しない。
- 持ち主の依頼20件、または推定文脈量80,000トークンへ到達すると、次の依頼前に自動更新する。
- 新しい会話へ渡す過去情報は引き継ぎ要約だけ。パスワード・APIキー・Botトークン・画像データを要約へ含めないようClaudeへ明示する。
- 要約作成に失敗した場合は旧会話を維持し、履歴なしで勝手に切り替えない。
- 旧形式の `session.json` は、次の依頼前に一度だけ要約して新形式へ移行する。

閾値は `.env` の `CLAUDE_SESSION_MAX_REQUESTS`、
`CLAUDE_SESSION_MAX_CONTEXT_TOKENS`、`CLAUDE_HANDOFF_MAX_CHARS` で変更できます。

## 画像添付

- 対応形式: PNG、JPEG、WebP
- 既定上限: 1投稿4枚、1枚10MB、取得15秒
- 本文＋画像、画像だけのどちらも対応
- Claude CLIへ一時保存先を許可し、Readツールで画像を開くよう指示する
- 上限は `.env` の `DISCORD_IMAGE_MAX_COUNT`、`DISCORD_IMAGE_MAX_BYTES`、`DISCORD_IMAGE_TIMEOUT_MS` で変更可能
- Discord公式CDN以外のURLや、拡張子を偽装したファイルは拒否する
- 解析用の一時コピーは応答後に削除する。Discord上の元画像は削除しない

テスト:

```bash
npm test
```

秘密設定と `session.json` は共有・公開しないでください。
