import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATE_VERSION = 2;

export const EMPTY_SESSION_STATE = Object.freeze({
  sessionId: null,
  requestCount: 0,
  contextTokens: 0,
  handoffSummary: null,
  rotationPending: false,
});

export class SessionStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "SessionStoreError";
  }
}

/** URLでもパス文字列でも受け取れるようにする。 */
function toFilePath(filePath) {
  return filePath instanceof URL ? fileURLToPath(filePath) : String(filePath);
}

/**
 * 役割: 保存済みのClaude会話状態を読み込む。
 * 入力: 保存ファイルのパスまたはURL。
 * 出力: 検証済み状態。旧形式は初回更新待ちへ移行する。
 */
export function loadSessionState(filePath) {
  const targetPath = toFilePath(filePath);
  if (!existsSync(targetPath)) return { ...EMPTY_SESSION_STATE };

  try {
    const savedSession = JSON.parse(readFileSync(targetPath, "utf8"));
    validateSessionId(savedSession.sessionId);

    // 旧版は利用量を持たないため、次の依頼前に一度だけ要約更新する。
    if (savedSession.version !== SESSION_STATE_VERSION) {
      return {
        ...EMPTY_SESSION_STATE,
        sessionId: savedSession.sessionId,
        rotationPending: savedSession.sessionId !== null,
      };
    }

    const sessionState = {
      sessionId: savedSession.sessionId,
      requestCount: savedSession.requestCount,
      contextTokens: savedSession.contextTokens,
      handoffSummary: savedSession.handoffSummary,
      rotationPending: savedSession.rotationPending,
    };
    validateSessionState(sessionState);
    return sessionState;
  } catch (error) {
    throw new SessionStoreError("Claude会話状態の読み込みに失敗しました", error);
  }
}

/**
 * 役割: Claude会話状態を再起動後も使えるよう保存する。
 * 入力: 保存ファイルのパスまたはURL、検証対象の状態。
 * 出力: なし。保存失敗時はSessionStoreErrorを送出する。
 * 実装メモ: 一時ファイルへ書いてから rename する。書き込みの途中で電源が落ちても、
 *           本体の session.json が中途半端な内容になることはない（原子的な差し替え）。
 */
export function saveSessionState(filePath, sessionState) {
  const targetPath = toFilePath(filePath);
  const temporaryPath = `${targetPath}.tmp`;
  try {
    validateSessionState(sessionState);
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        { version: SESSION_STATE_VERSION, ...sessionState },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    // 前回の一時ファイルが緩い権限で残っていた場合に備えて権限を明示し直す。
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, targetPath);
    chmodSync(targetPath, 0o600);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      /* 後始末の失敗は本来のエラーを隠さない */
    }
    throw new SessionStoreError("Claude会話状態の保存に失敗しました", error);
  }
}

/**
 * 役割: 旧API互換で会話IDだけを読み込む。
 * 入力: 保存ファイルのパスまたはURL。出力: 会話IDまたはnull。
 */
export function loadSessionId(filePath) {
  return loadSessionState(filePath).sessionId;
}

/**
 * 役割: 旧API互換で会話IDだけを初期状態として保存する。
 * 入力: 保存先と会話ID。出力なし。
 */
export function saveSessionId(filePath, sessionId) {
  saveSessionState(filePath, { ...EMPTY_SESSION_STATE, sessionId });
}

/** 入力: 会話ID / 出力なし。形式が不正なら例外にする。 */
function validateSessionId(sessionId) {
  if (sessionId === null) return;
  if (typeof sessionId !== "string" || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("sessionIdの形式が不正です");
  }
}

/** 入力: 会話状態 / 出力なし。永続化できない値なら例外にする。 */
function validateSessionState(sessionState) {
  if (!sessionState || typeof sessionState !== "object") {
    throw new Error("会話状態がオブジェクトではありません");
  }
  validateSessionId(sessionState.sessionId);
  validateNonNegativeInteger(sessionState.requestCount, "requestCount");
  validateNonNegativeInteger(sessionState.contextTokens, "contextTokens");
  if (
    sessionState.handoffSummary !== null &&
    typeof sessionState.handoffSummary !== "string"
  ) {
    throw new Error("handoffSummaryの形式が不正です");
  }
  if (typeof sessionState.rotationPending !== "boolean") {
    throw new Error("rotationPendingの形式が不正です");
  }
}

/** 入力: 数値・項目名 / 出力なし。非負整数でなければ例外にする。 */
function validateNonNegativeInteger(numericValue, label) {
  if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
    throw new Error(`${label}は0以上の整数で指定してください`);
  }
}
