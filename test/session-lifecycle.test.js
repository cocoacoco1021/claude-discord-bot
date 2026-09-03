import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionLifecycle,
  SessionLifecycleError,
} from "../session-lifecycle.js";

const OLD_SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const NEW_SESSION_ID = "223e4567-e89b-12d3-a456-426614174000";
const POLICY = {
  maxRequests: 20,
  maxContextTokens: 80_000,
  maxHandoffChars: 3_000,
};
const BASE_STATE = {
  sessionId: OLD_SESSION_ID,
  requestCount: 3,
  contextTokens: 10_000,
  handoffSummary: null,
  rotationPending: false,
};

/**
 * 役割: 呼出履歴と保存履歴を観測できるセッション管理を作る。
 * 入力: 初期状態とClaude代替関数。出力: 管理・呼出・保存履歴。
 */
function createLifecycle(initialState, invokeClaude) {
  const invocations = [];
  const persistedStates = [];
  const lifecycle = new SessionLifecycle({
    initialState,
    policy: POLICY,
    persistState: (sessionState) => persistedStates.push({ ...sessionState }),
    invokeClaude: async (invocation) => {
      invocations.push(invocation);
      return invokeClaude(invocation, invocations.length);
    },
    shouldRetryWithoutSession: () => false,
  });
  return { lifecycle, invocations, persistedStates };
}

test("通常依頼は同じ会話を継続し会話数と文脈量を保存する", async () => {
  const { lifecycle, invocations, persistedStates } = createLifecycle(
    BASE_STATE,
    async () => ({
      sessionId: OLD_SESSION_ID,
      text: "回答",
      contextTokens: 12_345,
    }),
  );

  const response = await lifecycle.runOwnerPrompt("続けて", []);

  assert.deepEqual(response, { text: "回答", rotated: false });
  assert.equal(invocations[0].sessionId, OLD_SESSION_ID);
  assert.deepEqual(persistedStates.at(-1), {
    ...BASE_STATE,
    requestCount: 4,
    contextTokens: 12_345,
  });
});

test("会話数到達時は旧会話を要約し新会話へ要約だけを渡す", async () => {
  const { lifecycle, invocations } = createLifecycle(
    { ...BASE_STATE, requestCount: 20 },
    async (_invocation, callNumber) =>
      callNumber === 1
        ? {
            sessionId: OLD_SESSION_ID,
            text: "決定事項だけの引き継ぎ",
            contextTokens: 79_000,
          }
        : {
            sessionId: NEW_SESSION_ID,
            text: "新しい会話の回答",
            contextTokens: 2_000,
          },
  );

  const response = await lifecycle.runOwnerPrompt("次の仕事", []);

  assert.equal(response.rotated, true);
  assert.equal(invocations[0].sessionId, OLD_SESSION_ID);
  assert.match(invocations[0].prompt, /新しいClaudeセッションへ引き継ぐ/);
  assert.equal(invocations[1].sessionId, null);
  assert.match(invocations[1].prompt, /決定事項だけの引き継ぎ/);
  assert.match(invocations[1].prompt, /次の仕事/);
  assert.deepEqual(lifecycle.getState(), {
    sessionId: NEW_SESSION_ID,
    requestCount: 1,
    contextTokens: 2_000,
    handoffSummary: null,
    rotationPending: false,
  });
});

test("手動更新は要約を保存し次の依頼まで新会話IDを持たない", async () => {
  const { lifecycle } = createLifecycle(BASE_STATE, async () => ({
    sessionId: OLD_SESSION_ID,
    text: "  引き継ぎ要約  ",
    contextTokens: 20_000,
  }));

  assert.equal(await lifecycle.rotateWithHandoff(), true);
  assert.deepEqual(lifecycle.getState(), {
    sessionId: null,
    requestCount: 0,
    contextTokens: 0,
    handoffSummary: "引き継ぎ要約",
    rotationPending: false,
  });
});

test("要約に失敗した場合は旧会話を維持する", async () => {
  const { lifecycle, persistedStates } = createLifecycle(
    BASE_STATE,
    async () => {
      throw new Error("利用上限");
    },
  );

  await assert.rejects(
    lifecycle.rotateWithHandoff(),
    SessionLifecycleError,
  );
  assert.deepEqual(lifecycle.getState(), BASE_STATE);
  assert.equal(persistedStates.length, 0);
});

test("fresh更新は要約せず統計と会話IDを外す", () => {
  const { lifecycle } = createLifecycle(BASE_STATE, async () => {
    throw new Error("呼ばれない");
  });

  lifecycle.rotateFresh();

  assert.deepEqual(lifecycle.getState(), {
    sessionId: null,
    requestCount: 0,
    contextTokens: 0,
    handoffSummary: null,
    rotationPending: false,
  });
});

test("不正な旧会話IDだけを外して同じ依頼を一度再試行する", async () => {
  const invalidSessionError = new Error("invalid session");
  const invocations = [];
  const persistedStates = [];
  let invocationCount = 0;
  const lifecycle = new SessionLifecycle({
    initialState: BASE_STATE,
    policy: POLICY,
    persistState: (sessionState) => persistedStates.push({ ...sessionState }),
    invokeClaude: async (invocation) => {
      invocations.push(invocation);
      invocationCount += 1;
      if (invocationCount === 1) throw invalidSessionError;
      return {
        sessionId: NEW_SESSION_ID,
        text: "再試行成功",
        contextTokens: 1_000,
      };
    },
    shouldRetryWithoutSession: (error) => error === invalidSessionError,
  });

  const response = await lifecycle.runOwnerPrompt("同じ依頼", []);

  assert.equal(response.text, "再試行成功");
  assert.equal(invocations[0].sessionId, OLD_SESSION_ID);
  assert.equal(invocations[1].sessionId, null);
  assert.equal(persistedStates.at(-1).sessionId, NEW_SESSION_ID);
});
