// Discord常駐ボット: Discordのメッセージを受け取り、このPCの claude CLI に渡して返答する。
// 役割: Discord ⇄ claude CLI の薄い中継。ビジネスロジックは持たない。
// 入力: 許可ユーザーからのDiscordメッセージ。出力: claude の応答をDiscordへ投稿。
// セキュリティ: ALLOWED_USER_ID 以外のメッセージは完全に無視する（フルモードの唯一の防御線）。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import "dotenv/config";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";

import { buildClaudeInvocation } from "./claude-command.js";
import {
  ClaudeCliError,
  parseClaudeProcessResult,
  shouldRetryWithoutSession,
} from "./claude-response.js";
import {
  cleanupDownloadedImages,
  downloadDiscordImages,
  loadImageSettings,
} from "./discord-images.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import {
  loadSessionPolicy,
  parseSessionCommand,
} from "./session-policy.js";
import {
  EMPTY_SESSION_STATE,
  loadSessionState,
  saveSessionState,
  SessionStoreError,
} from "./session-store.js";

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const CLAUDE_CWD = process.env.CLAUDE_CWD || process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 300000);
const IMAGE_SETTINGS = loadImageSettings(process.env);
const SESSION_POLICY = loadSessionPolicy(process.env);
const DEFAULT_IMAGE_PROMPT = "添付画像を確認して、内容を説明してください。";

// Discord経由で呼ばれるときの振る舞い（フルモードでも暴走させないための歯止め）
const SYSTEM_PROMPT =
  "あなたはDiscord経由で持ち主から呼ばれているAI秘書です。" +
  "返答は日本語で、スマホで読みやすいよう簡潔にする。" +
  "お金の支払い・購入、メールやメッセージの送信、ファイルの削除、外部への公開など" +
  "『取り消せない操作・外部に影響する操作』は、実行する前に必ずDiscordで内容を伝えて確認を取ること。" +
  "確認が取れるまでは実行しない。";

// 起動時の設定チェック（早期に失敗させて原因を明示する）
if (!TOKEN) {
  console.error("[FATAL] DISCORD_TOKEN が未設定です。.env を確認してください。");
  process.exit(1);
}
// ペアリング（持ち主ID）の記憶ファイル。一度覚えたら再起動しても保持する。
const PAIR_FILE = new URL("./paired.json", import.meta.url);
// Claudeの会話ID。再起動後も同じ会話をresumeするために保存する。
const SESSION_FILE = new URL("./session.json", import.meta.url);

function loadPairedId() {
  try {
    if (existsSync(PAIR_FILE)) {
      return JSON.parse(readFileSync(PAIR_FILE, "utf8")).userId || null;
    }
  } catch {
    /* 壊れていても無視して未ペアリング扱い */
  }
  return null;
}

function savePairedId(id) {
  try {
    writeFileSync(PAIR_FILE, JSON.stringify({ userId: id }, null, 2));
  } catch (e) {
    console.error("[WARN] ペアリング情報の保存に失敗:", e.message);
  }
}

// 許可ユーザーの決定: .env で明示(AUTO以外) > 記憶済み > 未設定(=最初の1人を登録)
let allowedUserId =
  (ALLOWED_USER_ID && ALLOWED_USER_ID !== "AUTO" ? ALLOWED_USER_ID : null) ||
  loadPairedId();

/**
 * 役割: Bot起動時に前回のClaude会話状態を復元する。
 * 入力: なし。
 * 出力: 保存済み状態。未保存または読込失敗なら空状態。
 */
function loadInitialSessionState() {
  try {
    return loadSessionState(SESSION_FILE);
  } catch (error) {
    console.error("[WARN] 保存済みのClaude会話状態を読み込めません:", error.message);
    return { ...EMPTY_SESSION_STATE };
  }
}

/**
 * 役割: 実行中の状態を再起動後も使えるよう保存する。
 * 入力: セッション状態。出力: なし。失敗時は意味ある例外を維持する。
 */
function persistSessionState(nextSessionState) {
  try {
    saveSessionState(SESSION_FILE, nextSessionState);
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError("Claude会話状態を保存できません", error);
  }
}

const sessionLifecycle = new SessionLifecycle({
  initialState: loadInitialSessionState(),
  policy: SESSION_POLICY,
  persistState: persistSessionState,
  invokeClaude,
  shouldRetryWithoutSession,
});

// 同時に複数の claude を走らせないための直列キュー（セッション競合を防ぐ）
let queue = Promise.resolve();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  // DM(ダイレクトメッセージ)を受け取るために必要
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[READY] ${c.user.tag} としてログインしました`);
  if (allowedUserId) {
    console.log(`[INFO] 許可ユーザーID: ${allowedUserId}`);
  } else {
    console.log("[INFO] ペアリング待ち: 最初に話しかけてきた人を持ち主として登録します");
  }
  console.log(`[INFO] claude 実行ディレクトリ: ${CLAUDE_CWD}`);
  const sessionState = sessionLifecycle.getState();
  console.log(
    sessionState.sessionId
      ? sessionState.rotationPending
        ? "[INFO] 旧会話を次の依頼前に要約して更新します"
        : "[INFO] 保存済みのClaude会話を継続します"
      : "[INFO] 新しいClaude会話を開始します",
  );
  console.log(
    `[INFO] 自動更新: ${SESSION_POLICY.maxRequests}件 または ` +
      `${SESSION_POLICY.maxContextTokens}トークン`,
  );
});

/**
 * claude CLI を1回実行する。
 * 入力: prompt、会話ID、画像パス。
 * 出力: 応答本文・会話ID・推定文脈量（Promise）。
 */
function invokeClaude({ prompt, sessionId, imagePaths }) {
  return new Promise((resolve, reject) => {
    const invocation = buildClaudeInvocation({
      claudeCwd: CLAUDE_CWD,
      systemPrompt: SYSTEM_PROMPT,
      sessionId,
      prompt,
      imagePaths,
    });

    // shell を介さず配列で渡すため、プロンプトによるコマンドインジェクションは起きない
    const child = spawn(CLAUDE_BIN, invocation.args, invocation.options);

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new ClaudeCliError(
          `タイムアウト(${CLAUDE_TIMEOUT_MS}ms)により中断しました`,
          { category: "timeout" },
        ),
      );
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new ClaudeCliError("Claude CLIを起動できませんでした", {
          category: "process_start",
          cause: e,
        }),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const claudeResult = parseClaudeProcessResult({
          exitCode: code,
          stdout,
          stderr,
        });
        resolve(claudeResult);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * 役割: Discordの新規会話コマンドを実行する。
 * 入力: handoffまたはfresh。出力: 持ち主向け完了メッセージ。
 */
async function runSessionCommand(sessionCommand) {
  if (sessionCommand === "fresh") {
    sessionLifecycle.rotateFresh();
    return "✅ 引き継ぎなしの新しいセッションへ切り替えました。過去ログは削除していません。";
  }

  const rotated = await sessionLifecycle.rotateWithHandoff();
  return rotated
    ? "✅ 引き継ぎ要約を作り、新しいセッションへ切り替えました。"
    : "ℹ️ すでに新しいセッションです。";
}

/**
 * Discordの2000文字制限に合わせて分割送信する。
 * 入力: 返信対象message, 本文text。出力: なし（送信を行う）
 */
async function sendChunked(message, text) {
  const LIMIT = 1900;
  const body = text && text.length ? text : "(空の応答)";
  for (let i = 0; i < body.length; i += LIMIT) {
    const chunk = body.slice(i, i + LIMIT);
    if (i === 0) await message.reply(chunk);
    else await message.channel.send(chunk);
  }
}

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // 自分や他ボットは無視

  // 診断用: 届いたメッセージを記録（原因調査が終わったら消してよい）
  console.log(
    `[MSG] guild=${message.guild?.name ?? "DM"} ch=${message.channelId} ` +
      `from=${message.author.tag}(${message.author.id}) len=${message.content?.length ?? 0} ` +
      `attachments=${message.attachments.size}`,
  );

  // まだ持ち主が未登録なら、最初に話しかけてきた本人を登録する（ペアリング）
  if (!allowedUserId) {
    allowedUserId = message.author.id;
    savePairedId(allowedUserId);
    console.log("[PAIR] 持ち主を登録しました:", allowedUserId);
    message
      .reply(
        `✅ ペアリング完了！これから、あなた専用の秘書として動きます。\nもう一度、聞きたいことを送ってみてください。`,
      )
      .catch(() => {});
    return;
  }

  if (message.author.id !== allowedUserId) return; // 許可ユーザー以外は完全無視
  const content = message.content?.trim() || "";
  const attachments = [...message.attachments.values()];
  if (!content && attachments.length === 0) return;
  const sessionCommand = parseSessionCommand(content);

  // 直列キューに積んで順番に処理（同時実行によるセッション競合を防ぐ）
  queue = queue.then(async () => {
    // 「入力中...」表示を維持（claudeの応答は時間がかかることがある）
    await message.channel.sendTyping().catch(() => {});
    const keepTyping = setInterval(
      () => message.channel.sendTyping().catch(() => {}),
      8000,
    );
    let downloadedImages = { directoryPath: null, imagePaths: [] };
    try {
      if (sessionCommand) {
        const commandReply = await runSessionCommand(sessionCommand);
        await message.reply(commandReply);
        return;
      }

      downloadedImages = await downloadDiscordImages(attachments, IMAGE_SETTINGS);
      const prompt = content || DEFAULT_IMAGE_PROMPT;
      const claudeResult = await sessionLifecycle.runOwnerPrompt(
        prompt,
        downloadedImages.imagePaths,
      );
      const reply = claudeResult.rotated
        ? `♻️ 会話履歴を要約して新しいセッションへ切り替えました。\n\n${claudeResult.text}`
        : claudeResult.text;
      await sendChunked(message, reply);
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 1800);
      await message.reply(`⚠️ エラーが発生しました:\n\`\`\`\n${detail}\n\`\`\``).catch(() => {});
      console.error("[ERROR]", e);
    } finally {
      clearInterval(keepTyping);
      try {
        cleanupDownloadedImages(downloadedImages.directoryPath);
      } catch (error) {
        console.error("[WARN] 一時画像を削除できません:", error.message);
      }
    }
  });
});

client.login(TOKEN).catch((e) => {
  console.error("[FATAL] Discordへのログインに失敗しました:", e.message);
  process.exit(1);
});
