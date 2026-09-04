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
| `handoff-archive.js` | 引き継ぎ要約を `handoffs/` へ日時つきで残す（上書きしない） |
| `session-store.js` | Claude会話ID・会話数・文脈量・要約の保存と復元 |
| `discord-images.js` | Discord添付画像の検証・取得・一時保存・後始末 |
| `session.json` | 現在の会話ID。自動生成・外部公開対象外 |
| `test/` | 会話継続、保存・復元、画像処理のテスト |
| `.env` | Discordトークンなどの秘密設定。雛形は `.env.example` |
| `com.hisho.discord-bot.plist.template` | launchd用の汎用テンプレート。Mac固有パスは含めない |

## Usage（使い方）

`.env.example` を `.env` にコピーし、`DISCORD_TOKEN` を設定します。
`CLAUDE_CWD` と `CLAUDE_BIN` は、そのMacの絶対パスへ置き換えます。

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
- **自動更新が失敗しても、その依頼は普通に処理する。** 今の会話をそのまま続け、5件先まで再挑戦を控える
  （20件を超えたあと、何を送ってもエラーになり続ける状態を作らないため）。
- 自動更新を始める前に「🔄 …引き継ぎ要約を作って、新しいセッションに切り替えます…」とDiscordへ伝える。
- **作った要約は `handoffs/handoff-<日時>.md` に必ず残す。上書きも削除もしない。**
- 旧形式の `session.json` は、次の依頼前に一度だけ要約して新形式へ移行する。

閾値は `.env` の `CLAUDE_SESSION_MAX_REQUESTS`、
`CLAUDE_SESSION_MAX_CONTEXT_TOKENS`、`CLAUDE_HANDOFF_MAX_CHARS` で変更できます。

## 画像添付

- 対応形式: PNG、JPEG、WebP
- 既定上限: 1投稿4枚、1枚10MB、取得15秒
- 本文＋画像、画像だけのどちらも対応
- Claude CLIへ一時保存先を許可し、Readツールで画像を開くよう指示する
- 上限は `.env` の `DISCORD_IMAGE_MAX_COUNT`、`DISCORD_IMAGE_MAX_BYTES`、`DISCORD_IMAGE_TIMEOUT_MS` で変更可能
- Discord公式CDN以外のURL（添付以外のパス・認証情報つき・httpも含む）は拒否する
- リダイレクトは追わない。受信しながら容量上限を超えた時点で打ち切る
- 拡張子やContent-Typeではなく、ファイル先頭の中身から実形式を判定する
- 対応外の添付（動画など）は無視して本文だけ処理する
- 解析用の一時コピーは応答後に削除する。Discord上の元画像は削除しない

テスト:

```bash
npm test
```

## 常駐化（自動起動）

`com.hisho.discord-bot.plist.template` の次の印を各Macの値へ置き換え、
`~/Library/LaunchAgents/com.hisho.discord-bot.plist` として保存します。

- `__NODE_BIN__`: `node` 実行体の絶対パス
- `__BOT_DIR__`: このリポジトリの絶対パス
- `__PATH__`: Botへ渡す実行検索パス
- `__HOME__`: そのMacのホームディレクトリ

生成後の `.plist` はMac固有ファイルのためGitへ含めません。

秘密設定と `session.json` は共有・公開しないでください。
