import { normalizeOpenCodeEndpoint } from "./opencode.mjs";

const CHATGPT_LUNA = Object.freeze({
  id: "chatgpt_luna",
  display_name: "ChatGPT Luna via Codex",
  codex_profile: "openai",
  default_model: "gpt-5.6-luna",
  models: Object.freeze(["gpt-5.6-luna"]),
  selection_hint: "Codex worker uses the local OpenAI/ChatGPT profile and Luna model.",
});

const DEEPSEEK_API = Object.freeze({
  id: "deepseek_api",
  display_name: "DeepSeek API via Codex",
  default_model: "deepseek-v4-pro",
  models: Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"]),
  codex_profiles: Object.freeze({
    "deepseek-v4-pro": "deepseek-pro",
    "deepseek-v4-flash": "deepseek-flash",
  }),
  selection_hint: "Codex worker uses the local DeepSeek profile; choose Pro for maximum reasoning or Flash for lower cost and latency.",
});

const CURRENT_CODEX = Object.freeze({
  id: "codex_current",
  display_name: "Current Codex configuration",
  default_model: null,
  models: Object.freeze(["gpt-5.6-luna", "deepseek-v4-pro", "deepseek-v4-flash"]),
  inherit_config: true,
  selection_hint: "Launches Codex without a forced profile, inheriting the user's local Codex provider, model, and authentication configuration.",
});

const OPENCODE = Object.freeze({
  id: "opencode",
  display_name: "OpenCode via local server",
  default_model: null,
  models: Object.freeze([]),
  inherit_config: true,
  allow_custom_model: true,
  kind: "opencode",
  selection_hint: "Drives a user-started local OpenCode server through its documented HTTP API. The Bridge Goal stays local to this route; OpenCode native sessions do not expose Codex's Goal API.",
});

const EXECUTOR_PROVIDERS = Object.freeze({
  chatgpt_luna: CHATGPT_LUNA,
  deepseek_api: DEEPSEEK_API,
  codex_current: CURRENT_CODEX,
  opencode: OPENCODE,
});

// OpenCode can set this in the MCP server environment so its users can say
// "connect" without learning an internal executor selector. Codex keeps the
// historical ChatGPT Luna default when the variable is absent.
export const DEFAULT_EXECUTOR_PROVIDER = process.env.CODEX_BRIDGE_EXECUTOR_PROVIDER === "opencode"
  ? "opencode"
  : "chatgpt_luna";

export function normalizeExecutorProvider(value = DEFAULT_EXECUTOR_PROVIDER) {
  const id = String(value || DEFAULT_EXECUTOR_PROVIDER).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(id)) {
    const error = new Error("executor_provider must contain only lowercase letters, numbers, or underscores");
    error.code = "EXECUTOR_PROVIDER_INVALID";
    throw error;
  }
  if (!EXECUTOR_PROVIDERS[id]) {
    const error = new Error(`unsupported executor_provider: ${id}`);
    error.code = "EXECUTOR_PROVIDER_UNSUPPORTED";
    throw error;
  }
  return id;
}

export function normalizeCodexProfile(value = "") {
  const profile = String(value || "").trim();
  if (!profile) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    const error = new Error("executor_profile must start with a letter or number and contain only letters, numbers, dot, underscore, or hyphen");
    error.code = "EXECUTOR_PROFILE_INVALID";
    throw error;
  }
  return profile;
}

export function normalizeExecutorAgent(value = "") {
  const agent = String(value || "").trim();
  if (!agent) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(agent)) {
    const error = new Error("executor_agent must start with a letter or number and contain only letters, numbers, dot, underscore, colon, or hyphen");
    error.code = "EXECUTOR_AGENT_INVALID";
    throw error;
  }
  return agent;
}

export function executorEndpointOf(providerOrId = DEFAULT_EXECUTOR_PROVIDER, requestedEndpoint = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  if (provider.kind !== "opencode") return "";
  return normalizeOpenCodeEndpoint(requestedEndpoint || process.env.OPENCODE_SERVER_URL || undefined);
}

export function getExecutorProvider(value = DEFAULT_EXECUTOR_PROVIDER) {
  return EXECUTOR_PROVIDERS[normalizeExecutorProvider(value)];
}

export function listExecutorProviders() {
  return Object.values(EXECUTOR_PROVIDERS).map(provider => ({
    id: provider.id,
    display_name: provider.display_name,
    default_model: provider.default_model,
    models: [...provider.models],
    codex_profiles: provider.codex_profiles ? { ...provider.codex_profiles } : undefined,
    inherit_config: Boolean(provider.inherit_config),
    allow_custom_model: Boolean(provider.allow_custom_model),
    kind: provider.kind || "codex",
    selection_hint: provider.selection_hint,
  }));
}

export function executorProfileOf(providerOrId = DEFAULT_EXECUTOR_PROVIDER, requestedProfile = "", requestedModel = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  const explicit = normalizeCodexProfile(requestedProfile);
  if (explicit) return explicit;
  const model = executorModelOf(provider, requestedModel);
  return normalizeCodexProfile(provider.codex_profile || provider.codex_profiles?.[model]);
}

export function executorModelOf(providerOrId = DEFAULT_EXECUTOR_PROVIDER, requestedModel = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  const requested = String(requestedModel || "").trim();
  const model = requested || provider.default_model;
  if (!model && provider.inherit_config) return null;
  if (provider.allow_custom_model) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
      const error = new Error(`unsupported executor_model for ${provider.id}: ${model}`);
      error.code = "EXECUTOR_MODEL_UNSUPPORTED";
      throw error;
    }
    return model;
  }
  if (!provider.models.includes(model)) {
    const error = new Error(`unsupported executor_model for ${provider.id}: ${model}`);
    error.code = "EXECUTOR_MODEL_UNSUPPORTED";
    throw error;
  }
  return model;
}

export function codexLaunchArgs(providerOrId = DEFAULT_EXECUTOR_PROVIDER, requestedModel = "", requestedProfile = "") {
  const provider = typeof providerOrId === "string" ? getExecutorProvider(providerOrId) : providerOrId;
  if (provider.kind === "opencode") {
    const error = new Error("OpenCode uses its HTTP server adapter, not Codex app-server launch arguments");
    error.code = "EXECUTOR_LAUNCH_NOT_APPLICABLE";
    throw error;
  }
  const model = executorModelOf(provider, requestedModel);
  const profile = executorProfileOf(provider, requestedProfile, model);
  const args = ["app-server", "--listen", "stdio://"];
  return profile ? ["-p", profile, ...args] : args;
}
