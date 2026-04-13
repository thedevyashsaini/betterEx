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

function chooseModel(connectedProviders, providerById) {
  const connected = new Set(connectedProviders || []);

  for (const choice of MODEL_PREFERENCES) {
    if (!connected.has(choice.providerID)) continue;
    const modelIds = extractModelIds(providerById[choice.providerID]);
    if (modelIds.length === 0 || modelIds.includes(choice.modelID)) {
      return choice;
    }
  }

  throw new Error("Neither openai/gpt-5.4 nor github-copilot/gpt-5.3-codex is available on the OpenCode server.");
}

async function getSelectedModel() {
  const [providerInfo, configProviders] = await Promise.all([
    opencodeFetch("/provider"),
    opencodeFetch("/config/providers"),
  ]);

  const providerById = Object.fromEntries(
    (configProviders.providers || [])
      .filter((provider) => provider && provider.id)
      .map((provider) => [provider.id, provider]),
  );

  return chooseModel(providerInfo.connected || [], providerById);
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

async function solveQuestions(questions, requestId) {
  const controller = new AbortController();
  if (requestId) {
    const prior = activeSolveControllers.get(requestId);
    if (prior) prior.abort();
    activeSolveControllers.set(requestId, controller);
  }

  try {
  const [sessionId, model] = await Promise.all([ensureSession(), getSelectedModel()]);

  const response = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    signal: controller.signal,
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
      parts: buildPromptParts(questions),
    }),
  });

  return {
    sessionId,
    model,
    answers: parseStructuredAnswers(response),
  };
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
