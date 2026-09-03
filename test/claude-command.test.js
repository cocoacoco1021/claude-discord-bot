import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeInvocation } from "../claude-command.js";

const BASE_INPUT = {
  claudeCwd: "/workspace",
  systemPrompt: "安全指示",
  prompt: "前の話を覚えている？",
};

test("保存済みの会話IDがあればresumeへ渡す", () => {
  const invocation = buildClaudeInvocation({
    ...BASE_INPUT,
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
  });

  assert.deepEqual(invocation.args.slice(-3), [
    "--resume",
    "123e4567-e89b-12d3-a456-426614174000",
    BASE_INPUT.prompt,
  ]);
});

test("保存済みの会話IDがなければ新規会話を開始する", () => {
  const invocation = buildClaudeInvocation({ ...BASE_INPUT, sessionId: null });

  assert.equal(invocation.args.includes("--resume"), false);
  assert.equal(invocation.args.at(-1), BASE_INPUT.prompt);
});

test("未使用の標準入力を閉じて入力待ちエラーを防ぐ", () => {
  const invocation = buildClaudeInvocation({ ...BASE_INPUT, sessionId: null });

  assert.deepEqual(invocation.options, {
    cwd: BASE_INPUT.claudeCwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
});

test("添付画像の場所とReadツールへの指示をClaudeへ渡す", () => {
  const imagePaths = [
    "/tmp/discord-images/image-1.png",
    "/tmp/discord-images/image-2.webp",
  ];
  const invocation = buildClaudeInvocation({
    ...BASE_INPUT,
    sessionId: null,
    imagePaths,
  });

  assert.deepEqual(
    invocation.args.slice(
      invocation.args.indexOf("--add-dir"),
      invocation.args.indexOf("--dangerously-skip-permissions"),
    ),
    ["--add-dir", "/tmp/discord-images"],
  );
  assert.match(invocation.args.at(-1), /Readツール/);
  assert.match(invocation.args.at(-1), /image-1\.png/);
  assert.match(invocation.args.at(-1), /image-2\.webp/);
});

test("画像だけの投稿には確認依頼を補ってClaudeへ渡す", () => {
  const invocation = buildClaudeInvocation({
    ...BASE_INPUT,
    prompt: "",
    sessionId: null,
    imagePaths: ["/tmp/discord-images/image-1.png"],
  });

  assert.match(invocation.args.at(-1), /添付画像を確認して/);
});
