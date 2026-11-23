// The adapter-registry validator shipped in usegrunt 0.9.7 (src/registry.ts at 04fdc23),
// compiled to JavaScript. Old clients run exactly this check on every synced registry.
// 0.9.7's bundled registry was published at this time; a synced list must be newer.
export const BUNDLED_PUBLISHED = '2026-11-20T15:55:00Z';
function validCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value;
  return Object.keys(c).every((key) => ["service", "label", "api_hosts", "auth_shape"].includes(key)) && typeof c.service === "string" && c.service.length >= 1 && c.service.length <= 120 && (c.label === void 0 || typeof c.label === "string" && c.label.length >= 1 && c.label.length <= 60) && (c.api_hosts === void 0 || Array.isArray(c.api_hosts) && c.api_hosts.length <= 10 && c.api_hosts.every((host) => typeof host === "string" && host.length >= 1 && host.length <= 253)) && (c.auth_shape === void 0 || typeof c.auth_shape === "string" && c.auth_shape.length <= 120 && /^(bearer|header:.+|query:.+)$/.test(c.auth_shape));
}
const installers = { freebuff: "npm:freebuff", opencode: "npm:opencode-ai", kilo: "builtin:kilo", nvidia: "builtin:nvidia", zro: "builtin:zro", tokenharbor: "builtin:tokenharbor", runcrate: "builtin:runcrate", apinex: "builtin:apinex", "mistral-vibe": "builtin:mistral-vibe", livekit: "builtin:livekit", pollinations: "builtin:pollinations", beatapi: "builtin:beatapi", clixad: "builtin:clixad", perch: "builtin:perch", nous: "builtin:nous", kenari: "builtin:kenari", numes: "builtin:numes", goedel: "builtin:goedel", crowllm: "builtin:crowllm", fikra: "builtin:fikra", openference: "builtin:openference", darus: "builtin:darus", "aperture-ai": "builtin:aperture-ai", "reflection-beam": "builtin:reflection-beam", "antseed-vikey": "builtin:antseed-vikey", millionseek: "builtin:millionseek", freepi: "builtin:freepi" };
const knownAdapters = new Set(Object.keys(installers));
const localOptInAdapters = [
  { id: "crowllm", kind: "model", tier: "experimental", weight: 0.01, modalities: ["text"], install: "builtin:crowllm", model: "glm-5.3-flash:free" },
  { id: "antseed-vikey", kind: "model", tier: "experimental", weight: 0.01, modalities: ["text"], install: "builtin:antseed-vikey" }
];
const localOptInAdapterIds = new Set(localOptInAdapters.map((adapter) => adapter.id));
const disabledAdapters = /* @__PURE__ */ new Set(["freebuff", "apinex"]);
function validateRegistry(value) {
  const fail = () => {
    throw new Error("Invalid adapter registry");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const registry = value;
  if (registry.version !== 1 || typeof registry.published !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(registry.published) || !Number.isFinite(Date.parse(registry.published)) || !Array.isArray(registry.adapters) || !registry.adapters.length || registry.adapters.length > 100) return fail();
  const ids = /* @__PURE__ */ new Set();
  const weights = { stable: 0, experimental: 0 };
  for (const item of registry.adapters) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail();
    const a = item;
    if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(a.id) || ids.has(a.id) || !["agent", "model"].includes(String(a.kind)) || !["stable", "experimental"].includes(String(a.tier)) || typeof a.weight !== "number" || !Number.isFinite(a.weight) || a.weight <= 0 || a.weight > 1 || !Array.isArray(a.modalities) || !a.modalities.length || a.modalities.some((m) => !["text", "image"].includes(m)) || new Set(a.modalities).size !== a.modalities.length || typeof a.install !== "string" || !(/^npm:[a-z0-9@/._-]+$/.test(a.install) || knownAdapters.has(String(a.id)) && a.install === installers[a.id]) || a.model !== void 0 && (typeof a.model !== "string" || !a.model.trim()) || a.models !== void 0 && (a.id !== "opencode" || a.model !== void 0 || !Array.isArray(a.models) || !a.models.length || a.models.length > 20 || a.models.some((model) => typeof model !== "string" || !model.trim()) || new Set(a.models).size !== a.models.length)) return fail();
    if (a.fit !== void 0 && (typeof a.fit !== "string" || !["great", "possible", "poor"].includes(a.fit)) || a.status !== void 0 && (typeof a.status !== "string" || !["active", "expiring", "inactive"].includes(a.status)) || a.hints !== void 0 && (typeof a.hints !== "string" || !a.hints.trim() || a.hints.length > 2e3) || a.capture !== void 0 && !validCapture(a.capture) || a.expires !== void 0 && (typeof a.expires !== "string" || !/^\d{4}-\d\d-\d\d$/.test(a.expires) || !Number.isFinite(Date.parse(a.expires)))) return fail();
    if (a.signup !== void 0) {
      if (typeof a.signup !== "string") return fail();
      let url;
      try {
        url = new URL(a.signup);
      } catch {
        return fail();
      }
      if (url.protocol !== "https:" || url.username || url.password) return fail();
    }
    if (knownAdapters.has(a.id) && (a.kind !== (["kilo", "nvidia", "zro", "tokenharbor", "runcrate", "apinex", "livekit", "pollinations", "beatapi", "nous", "kenari", "numes", "goedel", "crowllm", "fikra", "openference", "darus", "aperture-ai", "reflection-beam", "antseed-vikey", "millionseek", "freepi"].includes(a.id) ? "model" : "agent") || a.install !== installers[a.id] || a.modalities.some((m) => m !== "text"))) return fail();
    if (a.id === "aperture-ai" && a.model !== "baidu/ernie-5.5-flash-preview:free") return fail();
    if (a.id === "darus" && a.model !== "darus/deepseek-v4.1-flash-1017-FREE") return fail();
    if (a.id === "fikra" && a.model !== "deepseek-v4-1-flash-economy-free") return fail();
    if (a.id === "openference" && a.model !== "DeepSeek-V4.1-Flash-1017-Free") return fail();
    if (a.id === "crowllm" && a.model !== "glm-5.3-flash:free") return fail();
    if (a.id === "reflection-beam" && a.model !== "reflection/beam-free") return fail();
    if (a.id === "millionseek" && a.model !== "deepseek-v4.1-flash-free") return fail();
    if (a.id === "freepi" && a.model !== "deepseek-v4.1-flash") return fail();
    if (a.id === "antseed-vikey" && a.model !== "deepseek/deepseek-v4.1-flash-free") return fail();
    if (a.id === "goedel" && a.model !== "deepseek/deepseek-v4.1-flash") return fail();
    if (a.id === "nous" && a.model !== "qwen/qwen4-max:free") return fail();
    ids.add(a.id);
    weights[a.tier] += a.weight;
  }
  if (weights.stable && weights.experimental && (Math.abs(weights.stable - 0.8) > 1e-9 || Math.abs(weights.experimental - 0.2) > 1e-9)) return fail();
  return structuredClone(value);
}
export {
  disabledAdapters,
  knownAdapters,
  localOptInAdapterIds,
  localOptInAdapters,
  validateRegistry
};
