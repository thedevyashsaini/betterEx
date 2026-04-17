const PROGRESS_STORAGE_KEY = "betterEx.googleForm.progress.v1";
const QUESTIONS_PER_RUN = 12;
const MAX_IMAGES_PER_QUESTION = 2;
const MAX_MOODLE_IMAGES_PER_QUESTION = 4;
const STATUS_DOT_ID = "betterex-status-dot";
let activeRequestId = null;
let requestCounter = 0;

function isGoogleFormPage() {
  return location.hostname.includes("docs.google.com") && location.pathname.startsWith("/forms/");
}

function isMoodlePage() {
  if (location.hostname.includes("betamoodle.iiitvadodara.ac.in")) return true;
  if (location.hostname.includes("sandbox.moodledemo.net")) return true;
  return location.pathname.includes("/mod/quiz/") || location.pathname.includes("/question/");
}

function isEditableElement(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function ensureStatusDot() {
  let dot = document.getElementById(STATUS_DOT_ID);
  if (dot) return dot;

  dot = document.createElement("div");
  dot.id = STATUS_DOT_ID;
  dot.style.position = "fixed";
  dot.style.top = "12px";
  dot.style.right = "12px";
  dot.style.width = "7px";
  dot.style.height = "7px";
  dot.style.borderRadius = "999px";
  dot.style.zIndex = "2147483647";
  dot.style.background = "#98a2b3";
  dot.style.opacity = "0";
  dot.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.45)";
  dot.style.pointerEvents = "none";
  dot.style.transition = "opacity 120ms ease";
  document.documentElement.appendChild(dot);
  return dot;
}

function setStatusDotVisible(visible) {
  const dot = ensureStatusDot();
  dot.style.opacity = visible ? "0.82" : "0";
}

function getExtensionRuntime() {
  const runtime = globalThis.chrome && globalThis.chrome.runtime;
  if (!runtime || typeof runtime.sendMessage !== "function") {
    return null;
  }
  return runtime;
}

function createRequestId() {
  requestCounter += 1;
  return `req-${Date.now()}-${requestCounter}`;
}

function extractQuestionImages(block) {
  const images = Array.from(block.querySelectorAll("img"));
  const seen = new Set();
  const out = [];

  for (const img of images) {
    const src = String(img.currentSrc || img.src || "").trim();
    if (!src || src.startsWith("data:") || seen.has(src)) continue;
    seen.add(src);
    out.push({
      src,
      alt: normalizeText(img.getAttribute("alt") || ""),
    });
  }

  return out.slice(0, MAX_IMAGES_PER_QUESTION);
}

function extractMoodleQuestionImages(container) {
  const images = Array.from((container || document).querySelectorAll("img"));
  const seen = new Set();
  const out = [];

  for (const img of images) {
    const src = String(img.currentSrc || img.src || "").trim();
    if (!src || src.startsWith("data:") || seen.has(src)) continue;
    seen.add(src);
    out.push({
      src,
      alt: normalizeText(img.getAttribute("alt") || ""),
    });
  }

  return out.slice(0, MAX_MOODLE_IMAGES_PER_QUESTION);
}

function extractGoogleFormQuestions() {
  const blocks = document.querySelectorAll(".Qr7Oae");
  const questions = [];

  blocks.forEach((block, index) => {
    const titleEl = block.querySelector(".M7eMe") || block.querySelector('[role="heading"]');
    const descriptionEl = block.querySelector(".gubaDc");
    const images = extractQuestionImages(block);
    const radioOptions = Array.from(block.querySelectorAll('[role="radio"]'));
    const checkboxOptions = Array.from(block.querySelectorAll('[role="checkbox"]'));
    const textInput = block.querySelector('textarea, input[type="text"]');
    const hasAnswerUi = radioOptions.length > 0 || checkboxOptions.length > 0 || !!textInput;

    if (!hasAnswerUi) return;

    const title = normalizeText(titleEl ? titleEl.innerText : "");
    const description = normalizeText(descriptionEl ? descriptionEl.innerText : "");
    const questionText = [title, description].filter(Boolean).join("\n") || (images.length ? "Image-based question" : "Question text unavailable");

    if (radioOptions.length > 0) {
      const options = radioOptions
        .map((element) => ({
          text: normalizeText(element.getAttribute("aria-label") || element.innerText),
          element,
        }))
        .filter((option) => option.text);

      if (options.length) {
        questions.push({
          index: index + 1,
          question: questionText,
          type: "single-choice",
          options,
          images,
        });
      }
      return;
    }

    if (checkboxOptions.length > 0) {
      const options = checkboxOptions
        .map((element) => ({
          text: normalizeText(element.getAttribute("aria-label") || element.innerText),
          element,
        }))
        .filter((option) => option.text);

      if (options.length) {
        questions.push({
          index: index + 1,
          question: questionText,
          type: "multi-choice",
          options,
          images,
        });
      }
      return;
    }

    if (textInput) {
      questions.push({
        index: index + 1,
        question: questionText,
        type: "text",
        input: textInput,
        images,
      });
    }
  });

  return questions;
}

function extractMoodleQuestions() {
  const blocks = Array.from(document.querySelectorAll(".formulation.clearfix"));
  const questions = [];

  blocks.forEach((block, index) => {
    const questionTextElement = block.querySelector(".qtext");
    const questionText = normalizeText(questionTextElement ? questionTextElement.textContent : "") || "Question text unavailable";
    const questionImages = extractMoodleQuestionImages(questionTextElement || block);

    const textInput = block.querySelector('input[type="text"], textarea');
    if (textInput) {
      questions.push({
        index: index + 1,
        question: questionText,
        type: "text",
        input: textInput,
        images: questionImages,
      });
      return;
    }

    const answerOptions = [];
    const seenInputs = new WeakSet();
    const seenKeys = new Set();
    const optionRows = block.querySelectorAll(".ablock .answer .d-flex, .ablock .answer div[class^='r']");

    optionRows.forEach((optionEl) => {
      const inputEl = optionEl.querySelector('input[type="radio"], input[type="checkbox"]')
        || optionEl.parentElement?.querySelector('input[type="radio"], input[type="checkbox"]');
      const optionTextElement = optionEl.querySelector(".flex-fill, .ms-1") || optionEl;

      if (!inputEl || !optionTextElement) return;
      if (seenInputs.has(inputEl)) return;

      const text = normalizeText(optionTextElement.textContent);
      if (!text) return;

      const optionKey = `${inputEl.type || ""}|${inputEl.name || ""}|${inputEl.value || ""}|${text}`;
      if (seenKeys.has(optionKey)) return;

      seenInputs.add(inputEl);
      seenKeys.add(optionKey);
      answerOptions.push({ text, element: inputEl });
    });

    if (!answerOptions.length) return;

    const selectionType = answerOptions.some((option) => option.element && option.element.type === "checkbox")
      ? "multi-choice"
      : "single-choice";

    questions.push({
      index: index + 1,
      question: questionText,
      type: selectionType,
      options: answerOptions,
      images: questionImages,
    });
  });

  return questions;
}

function buildQuestionsSignature(questions) {
  return questions.map((q) => `${q.index}|${q.type}|${q.question}`).join("||");
}

function getCurrentFormKey() {
  return `${location.origin}${location.pathname}`;
}

function readAllFormProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) || "{}") || {};
  } catch (_error) {
    return {};
  }
}

function writeAllFormProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function readFormProgress(formKey) {
  const all = readAllFormProgress();
  const entry = all[formKey];
  if (!entry || typeof entry !== "object") return null;
  return {
    signature: typeof entry.signature === "string" ? entry.signature : "",
    nextChunk: Number.isInteger(entry.nextChunk) ? Math.max(0, entry.nextChunk) : 0,
    completedChunks: Array.isArray(entry.completedChunks)
      ? [...new Set(entry.completedChunks.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))]
      : [],
    lastFailedChunk: Number.isInteger(entry.lastFailedChunk) ? Math.max(0, entry.lastFailedChunk) : null,
    solvedAnswers: entry.solvedAnswers && typeof entry.solvedAnswers === "object" ? entry.solvedAnswers : {},
  };
}

function writeFormProgress(formKey, state) {
  const all = readAllFormProgress();
  all[formKey] = {
    signature: state.signature || "",
    nextChunk: state.nextChunk || 0,
    completedChunks: state.completedChunks || [],
    lastFailedChunk: Number.isInteger(state.lastFailedChunk) ? state.lastFailedChunk : null,
    solvedAnswers: state.solvedAnswers || {},
    updatedAt: Date.now(),
  };
  writeAllFormProgress(all);
}

const runState = {
  formKey: "",
  signature: "",
  nextChunk: 0,
  completedChunks: [],
  lastFailedChunk: null,
  solvedAnswers: {},
};

function setRunState(formKey, signature, nextChunk, completedChunks = [], lastFailedChunk = null, solvedAnswers = runState.solvedAnswers) {
  runState.formKey = formKey;
  runState.signature = signature;
  runState.nextChunk = Math.max(0, Number(nextChunk) || 0);
  runState.completedChunks = [...new Set((completedChunks || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))];
  runState.lastFailedChunk = Number.isInteger(lastFailedChunk) ? Math.max(0, lastFailedChunk) : null;
  runState.solvedAnswers = solvedAnswers && typeof solvedAnswers === "object" ? solvedAnswers : {};
  writeFormProgress(formKey, runState);
}

function getNextPendingChunk(totalChunks, completedChunks) {
  const completed = new Set(completedChunks || []);
  for (let i = 0; i < totalChunks; i += 1) {
    if (!completed.has(i)) return i;
  }
  return totalChunks;
}

function pickQuestionChunk(questions) {
  const formKey = getCurrentFormKey();
  const signature = buildQuestionsSignature(questions);

  if (runState.formKey !== formKey || runState.signature !== signature) {
    const saved = readFormProgress(formKey);
    if (saved && saved.signature === signature) {
      setRunState(formKey, signature, saved.nextChunk, saved.completedChunks, saved.lastFailedChunk, saved.solvedAnswers);
    } else {
      setRunState(formKey, signature, 0, [], null, {});
    }
  }

  const totalChunks = Math.ceil(questions.length / QUESTIONS_PER_RUN);
  const pendingChunk = getNextPendingChunk(totalChunks, runState.completedChunks);
  const chunkIndex = Math.max(runState.nextChunk, pendingChunk);
  const start = chunkIndex * QUESTIONS_PER_RUN;
  const end = start + QUESTIONS_PER_RUN;

  if (chunkIndex >= totalChunks) {
    return { chunkIndex: -1, selected: [], totalChunks, start, end };
  }

  return {
    chunkIndex,
    selected: questions.slice(start, end),
    totalChunks,
    start,
    end,
  };
}

function isQuestionAnswered(question) {
  if (question.type === "text") {
    return !!(question.input && normalizeText(question.input.value));
  }
  return Array.isArray(question.options)
    && question.options.some((option) => option.element && option.element.getAttribute("aria-checked") === "true");
}

function getQuestionAnswerSnapshot(question) {
  if (!question) return null;

  if (question.type === "text") {
    const value = normalizeText(question.input && question.input.value);
    return value ? { type: "text", textAnswer: value } : null;
  }

  const selected = (question.options || [])
    .map((option, index) => ({ option, index: index + 1 }))
    .filter(({ option }) => option.element && option.element.getAttribute("aria-checked") === "true")
    .map(({ index }) => index);

  if (!selected.length) return null;
  return { type: question.type, optionNumbers: selected };
}

function snapshotsMatch(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type) return false;

  if (left.type === "text") {
    return normalizeText(left.textAnswer) === normalizeText(right.textAnswer);
  }

  const leftOptions = Array.isArray(left.optionNumbers) ? left.optionNumbers : [];
  const rightOptions = Array.isArray(right.optionNumbers) ? right.optionNumbers : [];
  if (leftOptions.length !== rightOptions.length) return false;
  return leftOptions.every((value, index) => Number(value) === Number(rightOptions[index]));
}

function shouldRetryQuestion(question) {
  const saved = runState.solvedAnswers[String(question.index)] || null;
  const current = getQuestionAnswerSnapshot(question);
  if (!saved) return !current;
  return !snapshotsMatch(saved, current);
}

function maybeResetProgressIfFormCleared(questions) {
  const formKey = getCurrentFormKey();
  const signature = buildQuestionsSignature(questions);
  const saved = readFormProgress(formKey);
  if (!saved || saved.signature !== signature) return;
  const hasProgress = saved.nextChunk > 0 || (saved.completedChunks || []).length > 0;
  if (!hasProgress) return;
  const hasAnyAnswer = questions.some((question) => isQuestionAnswered(question));
  if (hasAnyAnswer) return;
  setRunState(formKey, signature, 0, [], null, {});
}

function serializeQuestions(questions) {
  return questions.map((question) => ({
    index: question.index,
    question: question.question,
    type: question.type,
    options: Array.isArray(question.options)
      ? question.options.map((option) => ({ text: option.text }))
      : [],
    images: Array.isArray(question.images) ? question.images : [],
  }));
}

function clickChoiceElement(element) {
  if (!element) return;
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
}

function normalizeAnswers(rawAnswers, questions) {
  const qMap = new Map(questions.map((question) => [question.index, question]));
  const out = [];

  for (const raw of rawAnswers || []) {
    if (!raw || typeof raw !== "object") continue;
    const questionNumber = Number(raw.question);
    const question = qMap.get(questionNumber);
    if (!question) continue;

    if (question.type === "text") {
      const value = normalizeText(raw.textAnswer || "");
      if (!value) continue;
      out.push({ question: questionNumber, type: "text", textAnswer: value });
      continue;
    }

    const optionNumbers = [...new Set((raw.optionNumbers || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0 && value <= question.options.length))];

    if (!optionNumbers.length) continue;
    out.push({ question: questionNumber, type: question.type, optionNumbers });
  }

  return out.sort((a, b) => a.question - b.question);
}

function mergeSolvedAnswers(existing, answers) {
  const merged = { ...(existing || {}) };
  for (const answer of answers) {
    if (!answer || !Number.isInteger(answer.question)) continue;
    if (answer.type === "text") {
      merged[String(answer.question)] = {
        type: "text",
        textAnswer: answer.textAnswer,
      };
      continue;
    }
    merged[String(answer.question)] = {
      type: answer.type,
      optionNumbers: [...(answer.optionNumbers || [])].map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
    };
  }
  return merged;
}

function fillAnswers(questions, answers) {
  const qMap = new Map(questions.map((question) => [question.index, question]));

  for (const answer of answers) {
    const question = qMap.get(answer.question);
    if (!question) continue;

    if (question.type === "text") {
      if (!question.input || !answer.textAnswer) continue;
      question.input.focus();
      question.input.value = answer.textAnswer;
      question.input.dispatchEvent(new Event("input", { bubbles: true }));
      question.input.dispatchEvent(new Event("change", { bubbles: true }));
      continue;
    }

    if (!Array.isArray(answer.optionNumbers) || !answer.optionNumbers.length) continue;

    if (question.type === "single-choice") {
      const target = question.options[answer.optionNumbers[0] - 1];
      if (target) clickChoiceElement(target.element);
      continue;
    }

    if (question.type === "multi-choice") {
      const targetSet = new Set(answer.optionNumbers);
      question.options.forEach((option, index) => {
        const optionNumber = index + 1;
        const isChecked = option.element.getAttribute("aria-checked") === "true";
        const shouldBeChecked = targetSet.has(optionNumber);

        if (shouldBeChecked && !isChecked) clickChoiceElement(option.element);
        if (!shouldBeChecked && isChecked) clickChoiceElement(option.element);
      });
    }
  }
}

function requestAnswersFromBackground(questions, requestId) {
  return new Promise((resolve, reject) => {
    const runtime = getExtensionRuntime();
    if (!runtime) {
      reject(new Error("Extension runtime unavailable. Reload the page after reloading the extension."));
      return;
    }

    runtime.sendMessage(
      {
        type: "betterEx.solveQuestions",
        requestId,
        questions: serializeQuestions(questions),
      },
      (response) => {
        if (runtime.lastError) {
          reject(new Error(runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          if (response && response.aborted) {
            reject(new Error("Solve aborted"));
            return;
          }
          reject(new Error((response && response.error) || "Unknown background error"));
          return;
        }
        resolve(response.result);
      },
    );
  });
}

function abortActiveSolve() {
  const requestId = activeRequestId;
  activeRequestId = null;
  setStatusDotVisible(false);
  if (!requestId) return;

  const runtime = getExtensionRuntime();
  if (!runtime) return;

  runtime.sendMessage(
    {
      type: "betterEx.abortSolve",
      requestId,
    },
    () => {
      if (runtime.lastError) {
        console.warn("[betterEx] Abort request warning:", runtime.lastError.message);
      }
    },
  );
}

async function handleGoogleFormWithAI() {
  if (!isGoogleFormPage()) return;
  setStatusDotVisible(false);
  if (activeRequestId) return;
  const questions = extractGoogleFormQuestions();
  if (!questions.length) {
    setStatusDotVisible(false);
    return;
  }

  maybeResetProgressIfFormCleared(questions);

  const { chunkIndex, selected, totalChunks, start } = pickQuestionChunk(questions);
  const backlogSource = chunkIndex === -1 ? questions : questions.slice(0, start);
  const retryBacklog = backlogSource.filter((question) => shouldRetryQuestion(question));
  if (chunkIndex === -1 && !retryBacklog.length) {
    setStatusDotVisible(false);
    return;
  }

  const runQuestions = [
    ...(selected || []),
    ...retryBacklog.filter((question) => !(selected || []).some((selectedQuestion) => selectedQuestion.index === question.index)),
  ];

  if (!runQuestions.length) {
    setStatusDotVisible(false);
    return;
  }

  setStatusDotVisible(true);
  const requestId = createRequestId();
  activeRequestId = requestId;

  try {
    const result = await requestAnswersFromBackground(runQuestions, requestId);
    if (activeRequestId !== requestId) return;
    const answers = normalizeAnswers(result.answers, runQuestions);

    if (!answers.length) {
      throw new Error("No usable answers returned from OpenCode.");
    }

    fillAnswers(runQuestions, answers);

    const completedChunks = chunkIndex === -1
      ? [...(runState.completedChunks || [])]
      : [...new Set([...(runState.completedChunks || []), chunkIndex])];
    const nextPendingChunk = getNextPendingChunk(totalChunks, completedChunks);
    const solvedAnswers = mergeSolvedAnswers(runState.solvedAnswers, answers);
    setRunState(
      runState.formKey || getCurrentFormKey(),
      runState.signature || buildQuestionsSignature(questions),
      nextPendingChunk,
      completedChunks,
      null,
      solvedAnswers,
    );

    activeRequestId = null;
    setStatusDotVisible(false);
  } catch (error) {
    if (activeRequestId !== requestId) return;
    activeRequestId = null;
    if (error && error.message === "Solve aborted") {
      setStatusDotVisible(false);
      return;
    }
    setRunState(
      runState.formKey || getCurrentFormKey(),
      runState.signature || buildQuestionsSignature(questions),
      chunkIndex === -1 ? getNextPendingChunk(totalChunks, runState.completedChunks || []) : chunkIndex,
      runState.completedChunks || [],
      chunkIndex === -1 ? runState.lastFailedChunk : chunkIndex,
      runState.solvedAnswers,
    );
    setStatusDotVisible(false);
    console.error("[betterEx] Failed to solve form chunk:", error);
  }
}

async function handleMoodleWithAI() {
  if (!isMoodlePage()) return;
  setStatusDotVisible(false);
  if (activeRequestId) return;

  const questions = extractMoodleQuestions();
  if (!questions.length) {
    setStatusDotVisible(false);
    return;
  }

  const runQuestions = questions;
  setStatusDotVisible(true);
  const requestId = createRequestId();
  activeRequestId = requestId;

  try {
    const result = await requestAnswersFromBackground(runQuestions, requestId);
    if (activeRequestId !== requestId) return;

    const answers = normalizeAnswers(result.answers, runQuestions);
    if (!answers.length) {
      throw new Error("No usable answers returned from OpenCode.");
    }

    fillAnswers(runQuestions, answers);
    activeRequestId = null;
    setStatusDotVisible(false);
  } catch (error) {
    if (activeRequestId !== requestId) return;
    activeRequestId = null;
    if (error && error.message === "Solve aborted") {
      setStatusDotVisible(false);
      return;
    }
    setStatusDotVisible(false);
    console.error("[betterEx] Failed to solve Moodle page:", error);
  }
}

document.addEventListener("keydown", (event) => {
  if (String(event.key || "").toLowerCase() !== "g") return;
  if (isEditableElement(document.activeElement)) return;

  if (event.altKey && event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    abortActiveSolve();
    return;
  }

  if (!event.altKey || event.ctrlKey || event.metaKey) return;

  event.preventDefault();
  if (isGoogleFormPage()) {
    console.log("[betterEx] Alt+G pressed. Processing Google Form...");
    handleGoogleFormWithAI();
    return;
  }

  if (isMoodlePage()) {
    console.log("[betterEx] Alt+G pressed. Processing Moodle question page...");
    handleMoodleWithAI();
  }
});

ensureStatusDot();
setStatusDotVisible(false);
console.log("[betterEx] Loaded. Press Alt+G on a Google Form to solve the next chunk.");
