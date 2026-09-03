const INVALID_SESSION_PATTERN =
  /(?:session|conversation).*(?:not found|does not exist|invalid|expired)|no (?:session|conversation) found/i;
const AUTHENTICATION_ERROR_PATTERN =
  /login expired|authentication(?:_failed| failed)|not authenticated/i;
const RATE_LIMIT_PATTERN =
  /weekly limit|usage limit|rate[_ -]?limit|too many requests/i;

export class ClaudeCliError extends Error {
  /**
   * 役割: Claude CLI失敗を再試行可否付きの意味あるエラーとして表す。
   * 入力: 利用者向けメッセージ、分類・終了コード・原因。
   * 出力: ClaudeCliErrorインスタンス。
   */
  constructor(message, { category = "execution", exitCode = null, cause } = {}) {
    super(message, { cause });
    this.name = "ClaudeCliError";
    this.category = category;
    this.exitCode = exitCode;
  }
}

/**
 * 役割: Claude CLIのJSON出力を安全に読み取る。
 * 入力: 標準出力の文字列。
 * 出力: JSONオブジェクト。JSONでなければnull。
 */
function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * 役割: Claude CLIの利用量から現在の文脈量を保守的に見積もる。
 * 入力: Claude CLIのusage。出力: 非負整数の推定トークン数。
 */
function estimateContextTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;

  return [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].reduce((totalTokens, tokenValue) => {
    const numericTokens = Number(tokenValue);
    if (!Number.isFinite(numericTokens) || numericTokens < 0) {
      return totalTokens;
    }
    return totalTokens + Math.round(numericTokens);
  }, 0);
}

/**
 * 役割: Claude CLIの失敗を利用者が判断できる分類へ変換する。
 * 入力: JSON出力、Claudeが返した詳細文字列。
 * 出力: エラー分類。
 */
function classifyClaudeError(parsedOutput, errorDetails) {
  if (
    parsedOutput?.api_error_status === 429 ||
    RATE_LIMIT_PATTERN.test(errorDetails)
  ) {
    return "rate_limit";
  }
  if (INVALID_SESSION_PATTERN.test(errorDetails)) return "invalid_session";
  if (AUTHENTICATION_ERROR_PATTERN.test(errorDetails)) return "authentication";
  return "execution";
}

/**
 * 役割: Claude CLIの失敗を日本語の案内へ変換する。
 * 入力: エラー分類、Claudeが返した詳細文字列、終了コード。
 * 出力: Discordへ表示できるエラーメッセージ。
 */
function buildErrorMessage(category, errorDetails, exitCode) {
  if (category === "rate_limit") {
    return (
      "Claudeの週間利用上限に達しています。利用枠のリセット後にもう一度お試しください。" +
      (errorDetails ? `\nClaude側の表示: ${errorDetails}` : "")
    );
  }
  if (category === "authentication") {
    return "Claudeのログイン期限が切れています。PC側でClaude Codeへの再ログインが必要です。";
  }
  if (errorDetails) return errorDetails;
  return `claude が異常終了しました (code ${exitCode})`;
}

/**
 * 役割: Claude CLIの終了結果を成功応答またはClaudeCliErrorへ変換する。
 * 入力: 終了コード、標準出力、標準エラー出力。
 * 出力: 応答本文と会話ID。失敗時はClaudeCliErrorを送出する。
 */
export function parseClaudeProcessResult({ exitCode, stdout, stderr }) {
  const parsedOutput = parseJsonOutput(stdout);
  const failed = exitCode !== 0 || parsedOutput?.is_error === true;

  if (failed) {
    const errorDetails =
      (typeof parsedOutput?.result === "string" && parsedOutput.result.trim()) ||
      stderr.trim() ||
      "";
    const category = classifyClaudeError(parsedOutput, errorDetails);
    throw new ClaudeCliError(
      buildErrorMessage(category, errorDetails, exitCode),
      { category, exitCode },
    );
  }

  if (!parsedOutput) {
    return {
      sessionId: null,
      text: stdout.trim() || "(空の応答)",
      contextTokens: 0,
    };
  }

  return {
    sessionId:
      typeof parsedOutput.session_id === "string"
        ? parsedOutput.session_id
        : null,
    text:
      typeof parsedOutput.result === "string"
        ? parsedOutput.result
        : "(空の応答)",
    contextTokens: estimateContextTokens(parsedOutput.usage),
  };
}

/**
 * 役割: 新規会話で一度だけ再試行すべきセッション不整合かを判定する。
 * 入力: runClaudeOnceが送出したエラー。
 * 出力: セッションを破棄して再試行する場合true。
 */
export function shouldRetryWithoutSession(error) {
  return (
    error instanceof ClaudeCliError && error.category === "invalid_session"
  );
}
