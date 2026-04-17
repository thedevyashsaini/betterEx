const BASE_URL = "http://127.0.0.1:4096";
const SESSION_STORAGE_KEY = "betterEx.opencode.sessionId";
const activeSolveControllers = new Map();
const MODEL_PREFERENCES = [
  { providerID: "openai", modelID: "gpt-5.4" },
  { providerID: "github-copilot", modelID: "gpt-5.3-codex" },
];

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function opencodeFetch(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(`OpenCode ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

function extractModelIds(provider) {
  const out = [];
  const push = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };

  if (provider && typeof provider.models === "object") {
    if (Array.isArray(provider.models)) {
      for (const item of provider.models) {
        if (typeof item === "string") push(item);
        else if (item && typeof item === "object") push(item.id || item.name);
      }
    } else {
      for (const key of Object.keys(provider.models)) push(key);
    }
  }

  if (provider && provider.metadata && typeof provider.metadata.models === "object") {
    for (const key of Object.keys(provider.metadata.models)) push(key);
  }

  return out;
}

function getModelCandidates(connectedProviders, providerById) {
  const connected = new Set(connectedProviders || []);
  const candidates = [];

  for (const choice of MODEL_PREFERENCES) {
    const modelIds = extractModelIds(providerById[choice.providerID]);
    const modelLooksAvailable = modelIds.length === 0 || modelIds.includes(choice.modelID);
    if (!modelLooksAvailable) continue;

    // Prefer connected providers first, but keep disconnected ones as fallback.
    if (connected.has(choice.providerID)) {
      candidates.unshift(choice);
    } else {
      candidates.push(choice);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.providerID}/${candidate.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  if (!deduped.length) {
    throw new Error("Neither openai/gpt-5.4 nor github-copilot/gpt-5.3-codex is available on the OpenCode server.");
  }

  return deduped;
}

async function getModelCandidatesFromServer() {
  const [providerInfo, configProviders] = await Promise.all([
    opencodeFetch("/provider"),
    opencodeFetch("/config/providers"),
  ]);

  const providerById = Object.fromEntries(
    (configProviders.providers || [])
      .filter((provider) => provider && provider.id)
      .map((provider) => [provider.id, provider]),
  );

  return getModelCandidates(providerInfo.connected || [], providerById);
}

async function ensureSession() {
  const stored = await getStorage([SESSION_STORAGE_KEY]);
  const sessionId = stored[SESSION_STORAGE_KEY];

  if (sessionId) {
    try {
      await opencodeFetch(`/session/${encodeURIComponent(sessionId)}`);
      return sessionId;
    } catch (_error) {
      // Create a new one below.
    }
  }

  const created = await opencodeFetch("/session", {
    method: "POST",
    body: JSON.stringify({}),
  });

  await setStorage({ [SESSION_STORAGE_KEY]: created.id });
  return created.id;
}

async function createFreshSession() {
  const created = await opencodeFetch("/session", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return created.id;
}

function guessMimeType(url) {
  const src = String(url || "").toLowerCase();
  if (src.includes(".png")) return "image/png";
  if (src.includes(".webp")) return "image/webp";
  if (src.includes(".gif")) return "image/gif";
  if (src.includes(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function buildPrompt(questions) {
  const lines = questions.map((question) => {
    const imageNote = Array.isArray(question.images) && question.images.length
      ? `\nImages: ${question.images.map((image, index) => `image ${index + 1}${image.alt ? ` alt=\"${image.alt}\"` : ""}`).join(", ")}`
      : "";

    if (question.type === "text") {
      return `Q${question.index} [text]\nQuestion: ${question.question}${imageNote}`;
    }

    const optionLines = (question.options || [])
      .map((option, index) => `${index + 1}. ${option.text}`)
      .join("\n");

    return `Q${question.index} [${question.type}]\nQuestion: ${question.question}${imageNote}\nOptions:\n${optionLines}`;
  });

  return [
    "Solve these Google Form questions.",
    "Return answers only via structured output.",
    "Rules:",
    "- For single-choice, put exactly one option number in optionNumbers.",
    "- For multi-choice, put one or more option numbers in optionNumbers.",
    "- For text, put the final answer in textAnswer.",
    "- Use the exact question numbers provided.",
    "- Use attached images when relevant.",
    "Questions:",
    lines.join("\n\n"),
  ].join("\n");
}

function buildPromptParts(questions) {
  const parts = [
    {
      type: "text",
      text: buildPrompt(questions),
    },
  ];

  for (const question of questions) {
    if (!Array.isArray(question.images)) continue;
    for (let i = 0; i < question.images.length; i += 1) {
      const image = question.images[i];
      if (!image || !image.src) continue;
      parts.push({
        type: "text",
        text: `Attached file for question ${question.index}, image ${i + 1}${image.alt ? `, alt text: ${image.alt}` : ""}.`,
      });
      parts.push({
        type: "file",
        mime: guessMimeType(image.src),
        filename: `question-${question.index}-image-${i + 1}`,
        url: image.src,
      });
    }
  }

  return parts;
}

function guessMimeTypeFromDataUrl(dataUrl, fallback = "image/jpeg") {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,/i);
  if (match && match[1]) return match[1];
  return fallback;
}

async function fetchAsDataUrl(url, fallbackMime) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || fallbackMime || "image/jpeg";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return `data:${contentType};base64,${b64}`;
}

async function buildProviderSafeParts(model, parts) {
  if (!model || model.providerID !== "github-copilot") {
    return parts;
  }

  const safeParts = [];
  for (const part of parts) {
    if (!part || part.type !== "file") {
      safeParts.push(part);
      continue;
    }

    const url = String(part.url || "").trim();
    if (!url) {
      continue;
    }

    if (url.startsWith("data:")) {
      safeParts.push(part);
      continue;
    }

    try {
      const dataUrl = await fetchAsDataUrl(url, part.mime || guessMimeType(url));
      safeParts.push({
        ...part,
        mime: guessMimeTypeFromDataUrl(dataUrl, part.mime || guessMimeType(url)),
        url: dataUrl,
      });
    } catch (error) {
      console.warn(`[betterEx] Skipping image for Copilot request: ${url} (${error.message || error})`);
    }
  }

  return safeParts;
}

function enforceCopilotImageRules(model, parts) {
  if (!model || model.providerID !== "github-copilot") {
    return parts;
  }

  const out = [];
  for (const part of parts || []) {
    if (!part || part.type !== "file") {
      out.push(part);
      continue;
    }

    const url = String(part.url || "").trim();
    const mime = String(part.mime || "").toLowerCase();
    const isDataUrl = url.startsWith("data:");
    const isImageMime = mime.startsWith("image/");

    // Copilot rejects external image URLs. Keep only inline data URLs.
    if (isDataUrl && isImageMime) {
      out.push(part);
      continue;
    }

    console.warn(`[betterEx] Dropping unsupported Copilot file part: ${url.slice(0, 80)}`);
  }

  return out;
}

function extractFinalText(response) {
  const parts = Array.isArray(response.parts) ? response.parts : [];
  for (const part of parts) {
    if (part && part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return "";
}

function collectJsonCandidates(text) {
  const src = String(text || "").trim();
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(src.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseStructuredAnswers(response) {
  if (response && response.info && response.info.structured && Array.isArray(response.info.structured.answers)) {
    return response.info.structured.answers;
  }

  const text = extractFinalText(response);
  for (const candidate of [text, ...collectJsonCandidates(text)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.answers)) return parsed.answers;
    } catch (_error) {
      // Keep trying.
    }
  }

  throw new Error("OpenCode did not return parseable structured answers.");
}

async function sendSolvePrompt(sessionId, model, questions, signal) {
  const baseParts = buildPromptParts(questions);
  const providerSafeParts = await buildProviderSafeParts(model, baseParts);
  const finalParts = enforceCopilotImageRules(model, providerSafeParts);

  const response = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      model,
      system: "Return structured output only. Do not add explanations outside the structured response.",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            answers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: { type: "integer" },
                  type: {
                    type: "string",
                    enum: ["single-choice", "multi-choice", "text"],
                  },
                  optionNumbers: {
                    type: "array",
                    items: { type: "integer" },
                  },
                  textAnswer: { type: "string" },
                },
                required: ["question", "type"],
                additionalProperties: false,
              },
            },
          },
          required: ["answers"],
          additionalProperties: false,
        },
      },
      parts: finalParts,
    }),
  });

  if (response && response.info && response.info.error) {
    const err = response.info.error;
    const msg = err && err.data && err.data.message ? err.data.message : JSON.stringify(err);
    throw new Error(`OpenCode message error (${model.providerID}/${model.modelID}): ${msg}`);
  }

  return response;
}

async function solveQuestions(questions, requestId) {
  const controller = new AbortController();
  if (requestId) {
    const prior = activeSolveControllers.get(requestId);
    if (prior) prior.abort();
    activeSolveControllers.set(requestId, controller);
  }

  try {
    const modelCandidates = await getModelCandidatesFromServer();

    const errors = [];
    for (const model of modelCandidates) {
      try {
        // Use a fresh session for each solve attempt so old message history
        // cannot carry forward unsupported external image URLs.
        const sessionId = await createFreshSession();
        const response = await sendSolvePrompt(sessionId, model, questions, controller.signal);
        return {
          sessionId,
          model,
          answers: parseStructuredAnswers(response),
        };
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        errors.push(`[${model.providerID}/${model.modelID}] ${error.message || String(error)}`);
      }
    }

    throw new Error(`All model attempts failed. ${errors.join(" | ")}`);
  } finally {
    if (requestId && activeSolveControllers.get(requestId) === controller) {
      activeSolveControllers.delete(requestId);
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return undefined;

  if (message.type === "betterEx.abortSolve") {
    const requestId = message.requestId;
    const controller = requestId ? activeSolveControllers.get(requestId) : null;
    if (controller) {
      controller.abort();
      activeSolveControllers.delete(requestId);
    }
    sendResponse({ ok: true, aborted: !!controller });
    return false;
  }

  if (message.type !== "betterEx.solveQuestions") return undefined;

  solveQuestions(message.questions || [], message.requestId)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      if (error && error.name === "AbortError") {
        sendResponse({ ok: false, aborted: true, error: "Request aborted" });
        return;
      }
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});
