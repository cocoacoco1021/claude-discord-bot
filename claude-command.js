import { dirname } from "node:path";

const DEFAULT_IMAGE_PROMPT = "添付画像を確認して、内容を説明してください。";

/**
 * 役割: ClaudeがReadツールで添付画像を開ける本文を組み立てる。
 * 入力: 持ち主の本文と、一時保存した画像ファイルのパス配列。
 * 出力: Claudeへ渡す本文。画像がなければ元の本文。
 */
function buildClaudePrompt(prompt, imagePaths) {
  if (imagePaths.length === 0) return prompt;

  const ownerPrompt = prompt || DEFAULT_IMAGE_PROMPT;
  const imageList = imagePaths.map((imagePath) => `- ${imagePath}`).join("\n");
  return (
    `${ownerPrompt}\n\nDiscordで受け取った添付画像ファイル:\n${imageList}\n` +
    "上記の画像ファイルをReadツールで開き、内容を確認してから回答してください。"
  );
}

/**
 * 役割: Claude CLIを新規会話または継続会話で呼ぶ設定を組み立てる。
 * 入力: 作業場所、安全指示、会話ID、持ち主の本文、画像パス。
 * 出力: child_process.spawnへ渡す引数と起動設定。
 */
export function buildClaudeInvocation({
  claudeCwd,
  systemPrompt,
  sessionId,
  prompt,
  imagePaths = [],
}) {
  const args = [
    "-p",
    "--output-format",
    "json",
  ];

  if (imagePaths.length > 0) {
    args.push("--add-dir", dirname(imagePaths[0]));
  }

  args.push(
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    systemPrompt,
  );

  if (sessionId) args.push("--resume", sessionId);
  args.push(buildClaudePrompt(prompt, imagePaths));

  return {
    args,
    options: {
      cwd: claudeCwd,
      // Claudeが入力待ちで警告終了しないよう、未使用の標準入力を明示的に閉じる。
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}
