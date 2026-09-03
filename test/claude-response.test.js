import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeCliError,
  parseClaudeProcessResult,
  shouldRetryWithoutSession,
} from "../claude-response.js";

test("成功JSONから応答本文と会話IDを取り出す", () => {
  const parsedResult = parseClaudeProcessResult({
    exitCode: 0,
    stdout: JSON.stringify({
      is_error: false,
      result: "確認できました",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 8000,
        cache_read_input_tokens: 12000,
      },
    }),
    stderr: "",
  });

  assert.deepEqual(parsedResult, {
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
    text: "確認できました",
    contextTokens: 20002,
  });
});

test("不正な利用量を無視して文脈量を非負整数で返す", () => {
  const parsedResult = parseClaudeProcessResult({
    exitCode: 0,
    stdout: JSON.stringify({
      result: "完了",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      usage: {
        input_tokens: 1.6,
        cache_creation_input_tokens: -3,
        cache_read_input_tokens: "100",
      },
    }),
    stderr: "",
  });

  assert.equal(parsedResult.contextTokens, 102);
});

test("週間利用上限を日本語で通知し会話再作成の対象にしない", () => {
  assert.throws(
    () =>
      parseClaudeProcessResult({
        exitCode: 1,
        stdout: JSON.stringify({
          is_error: true,
          api_error_status: 429,
          result: "You've hit your weekly limit · resets 1pm (Asia/Tokyo)",
        }),
        stderr: "",
      }),
    (error) => {
      assert.ok(error instanceof ClaudeCliError);
      assert.equal(error.category, "rate_limit");
      assert.match(error.message, /週間利用上限/);
      assert.equal(shouldRetryWithoutSession(error), false);
      return true;
    },
  );
});

test("存在しない会話IDだけ新規会話での再試行対象にする", () => {
  assert.throws(
    () =>
      parseClaudeProcessResult({
        exitCode: 1,
        stdout: "",
        stderr: "No conversation found with session ID: missing",
      }),
    (error) => {
      assert.equal(error.category, "invalid_session");
      assert.equal(shouldRetryWithoutSession(error), true);
      return true;
    },
  );
});

test("JSONではない成功出力はそのまま応答にする", () => {
  assert.deepEqual(
    parseClaudeProcessResult({
      exitCode: 0,
      stdout: "通常のテキスト応答\n",
      stderr: "",
    }),
    { sessionId: null, text: "通常のテキスト応答", contextTokens: 0 },
  );
});
