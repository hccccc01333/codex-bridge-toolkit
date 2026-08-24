import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXECUTOR_PROVIDER,
  codexLaunchArgs,
  executorModelOf,
  executorProfileOf,
  getExecutorProvider,
  listExecutorProviders,
  normalizeCodexProfile,
  executorEndpointOf,
  normalizeExecutorAgent,
  normalizeExecutorProvider,
} from "../src/adapters/executor.mjs";

test("executor registry exposes ChatGPT Luna and DeepSeek Pro/Flash", () => {
  const providers = listExecutorProviders();
  assert.deepEqual(providers.map(provider => provider.id), ["chatgpt_luna", "deepseek_api", "codex_current", "opencode"]);
  assert.equal(DEFAULT_EXECUTOR_PROVIDER, "chatgpt_luna");
  assert.deepEqual(providers[0].models, ["gpt-5.6-luna"]);
  assert.deepEqual(providers[1].models, ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(providers[1].codex_profiles["deepseek-v4-pro"], "deepseek-pro");
  assert.equal(providers[1].codex_profiles["deepseek-v4-flash"], "deepseek-flash");
  assert.equal(providers[2].inherit_config, true);
  assert.equal(providers[2].default_model, null);
  assert.equal(providers[3].kind, "opencode");
  assert.equal(providers[3].allow_custom_model, true);
});

test("executor selection maps each model to the intended Codex profile", () => {
  assert.equal(normalizeExecutorProvider("DEEPSEEK_API"), "deepseek_api");
  assert.equal(executorModelOf("deepseek_api", "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(executorModelOf("deepseek_api", "deepseek-v4-flash"), "deepseek-v4-flash");
  assert.deepEqual(codexLaunchArgs("chatgpt_luna"), ["-p", "openai", "app-server", "--listen", "stdio://"]);
  assert.deepEqual(codexLaunchArgs("deepseek_api", "deepseek-v4-pro"), ["-p", "deepseek-pro", "app-server", "--listen", "stdio://"]);
  assert.deepEqual(codexLaunchArgs("deepseek_api", "deepseek-v4-flash"), ["-p", "deepseek-flash", "app-server", "--listen", "stdio://"]);
  assert.deepEqual(codexLaunchArgs("codex_current"), ["app-server", "--listen", "stdio://"]);
  assert.deepEqual(codexLaunchArgs("codex_current", "deepseek-v4-flash"), ["app-server", "--listen", "stdio://"]);
  assert.deepEqual(codexLaunchArgs("deepseek_api", "deepseek-v4-flash", "my-deepseek"), ["-p", "my-deepseek", "app-server", "--listen", "stdio://"]);
  assert.equal(executorProfileOf("codex_current", "", "deepseek-v4-flash"), "");
  assert.equal(executorModelOf("opencode", "openai/gpt-5"), "openai/gpt-5");
  assert.equal(executorEndpointOf("opencode", "http://127.0.0.1:4096"), "http://127.0.0.1:4096");
  assert.equal(normalizeExecutorAgent("build"), "build");
  assert.equal(normalizeCodexProfile("my.deepseek_profile"), "my.deepseek_profile");
  assert.throws(
    () => executorModelOf(getExecutorProvider("deepseek_api"), "gpt-5.6-luna"),
    error => error?.code === "EXECUTOR_MODEL_UNSUPPORTED",
  );
});
