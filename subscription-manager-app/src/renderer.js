const fields = {
  repoOwner: document.getElementById("repoOwner"),
  repoName: document.getElementById("repoName"),
  branch: document.getElementById("branch"),
  workflowFile: document.getElementById("workflowFile"),
  githubToken: document.getElementById("githubToken"),
  subscriptionUrls: document.getElementById("subscriptionUrls"),
  gistRawUrl: document.getElementById("gistRawUrl")
};

const views = {
  convert: document.getElementById("convertView"),
  token: document.getElementById("tokenView"),
  settings: document.getElementById("settingsView")
};

const convertStates = {
  input: document.getElementById("convertInputState"),
  result: document.getElementById("convertResultState")
};

const tokenStatusShell = document.getElementById("tokenStatusShell");
const statusBanner = document.getElementById("statusBanner");
const statusIcon = document.getElementById("statusIcon");
const statusTitle = document.getElementById("statusTitle");
const statusMessage = document.getElementById("statusMessage");
const tokenSavedHint = document.getElementById("tokenSavedHint");
const toastContainer = document.getElementById("toastContainer");
const resultBadge = document.getElementById("resultBadge");
const resultTitle = document.getElementById("resultTitle");
const resultDescription = document.getElementById("resultDescription");

const buttons = {
  save: document.getElementById("saveBtn"),
  syncAndRun: document.getElementById("syncAndRunBtn"),
  saveToken: document.getElementById("saveTokenBtn"),
  loadToken: document.getElementById("loadTokenBtn"),
  openSecretPage: document.getElementById("openSecretPageBtn"),
  openWorkflowPage: document.getElementById("openWorkflowPageBtn"),
  openRawUrl: document.getElementById("openRawUrlBtn"),
  copyRawUrl: document.getElementById("copyRawUrlBtn"),
  toggleToken: document.getElementById("toggleTokenBtn"),
  backToEdit: document.getElementById("backToEditBtn"),
  minimizeWindow: document.getElementById("minimizeWindowBtn"),
  maximizeWindow: document.getElementById("maximizeWindowBtn"),
  closeWindow: document.getElementById("closeWindowBtn"),
  checkUpdate: document.getElementById("checkUpdateBtn")
};

const navItems = Array.from(document.querySelectorAll(".nav-item"));

let currentState = null;
let currentView = "convert";
let tokenVisible = false;
let statusTimeoutId = null;

function getStatusIcon(type) {
  if (type === "success") return "✓";
  if (type === "warning") return "!";
  if (type === "error") return "×";
  if (type === "loading") return "…";
  return "i";
}

function setStatus(type, title, message) {
  statusBanner.className = `status-banner ${type}`;
  statusIcon.textContent = getStatusIcon(type);
  statusTitle.textContent = title;
  statusMessage.textContent = message;

  if (currentView === "token") {
    tokenStatusShell.style.display = "block";
    if (statusTimeoutId) {
      clearTimeout(statusTimeoutId);
    }
    statusTimeoutId = setTimeout(() => {
      tokenStatusShell.style.display = "none";
    }, 5000);
  }
}

function showToast(type, title, message) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${getStatusIcon(type)}</div>
    <div>
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;

  toastContainer.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function setBusy(isBusy) {
  [buttons.save, buttons.syncAndRun, buttons.saveToken].forEach((button) => {
    if (button) {
      button.disabled = isBusy;
    }
  });
}

function collectState() {
  return {
    repoOwner: fields.repoOwner.value.trim(),
    repoName: fields.repoName.value.trim(),
    branch: fields.branch.value.trim(),
    workflowFile: fields.workflowFile.value.trim(),
    githubToken: fields.githubToken.value.trim(),
    subscriptionUrls: fields.subscriptionUrls.value,
    gistRawUrl: fields.gistRawUrl.value.trim(),
    secretName: "SUBSCRIPTION_URLS",
    tokenSaved: currentState?.tokenSaved || false
  };
}

function applyState(state) {
  currentState = state;
  tokenVisible = false;
  fields.repoOwner.value = state.repoOwner || "";
  fields.repoName.value = state.repoName || "";
  fields.branch.value = state.branch || "";
  fields.workflowFile.value = state.workflowFile || "";
  fields.githubToken.type = "password";
  fields.githubToken.value = "";
  fields.subscriptionUrls.value = state.subscriptionUrls || "";
  fields.gistRawUrl.value = state.gistRawUrl || "";
  buttons.toggleToken.textContent = "👁";
  tokenSavedHint.textContent = state.tokenSaved
    ? "当前已保存 Token，可直接查看或覆盖。"
    : "当前未保存 Token。";
}

function setConvertViewState(mode, options = {}) {
  const isResult = mode === "result";
  convertStates.input.classList.toggle("active", !isResult);
  convertStates.result.classList.toggle("active", isResult);

  if (isResult) {
    resultBadge.textContent = options.badge || "已完成";
    resultTitle.textContent = options.title || "最终订阅地址";
    resultDescription.textContent =
      options.description || "转换成功后，这里会展示最终地址，便于复制和查看。";
  }
}

function switchView(nextView) {
  currentView = nextView;
  Object.entries(views).forEach(([name, element]) => {
    const isActive = name === nextView;
    element.hidden = !isActive;
    element.classList.toggle("active", isActive);
  });

  navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.view === nextView);
  });
}

function updateMaximizeButton(state) {
  buttons.maximizeWindow.textContent = state?.isMaximized ? "❐" : "□";
}

function getSecretPageUrl() {
  const state = collectState();
  return `https://github.com/${state.repoOwner}/${state.repoName}/settings/secrets/actions`;
}

function getWorkflowPageUrl() {
  const state = collectState();
  return `https://github.com/${state.repoOwner}/${state.repoName}/actions/workflows/${state.workflowFile}`;
}

async function withAction(title, message, work) {
  try {
    setBusy(true);
    setStatus("loading", title, message);
    const result = await work();
    setBusy(false);
    return result;
  } catch (error) {
    setBusy(false);
    const errorMessage = error.message || "发生了未知错误";
    setStatus("error", "执行失败", errorMessage);
    showToast("error", "执行失败", errorMessage);
    throw error;
  }
}

async function copyText(text, successMessage) {
  if (!text) {
    setStatus("warning", "暂无可复制内容", "请先生成或填写有效内容。");
    showToast("warning", "暂无可复制内容", "请先生成或填写有效内容。");
    return;
  }

  await navigator.clipboard.writeText(text);
  showToast("success", "已复制", successMessage);
}

async function init() {
  setStatus("loading", "初始化中", "正在读取本地配置和订阅内容...");
  const [state, windowState] = await Promise.all([
    window.subscriptionApp.loadState(),
    window.subscriptionApp.getWindowState()
  ]);

  applyState(state);
  switchView("convert");
  setConvertViewState("input");
  updateMaximizeButton(windowState);

  window.subscriptionApp.onWindowStateChange((nextState) => {
    updateMaximizeButton(nextState);
  });

  setStatus("idle", "准备就绪", "请选择左侧功能并开始操作。");
}

buttons.save.addEventListener("click", async () => {
  const saved = await withAction("正在保存", "正在同步本地参考文件和程序配置...", () =>
    window.subscriptionApp.saveState(collectState())
  );
  applyState(saved);
  setStatus("success", "保存成功", "本地配置和 .secrets.local 已更新。");
  showToast("success", "保存成功", "本地配置和 .secrets.local 已更新。");
});

buttons.syncAndRun.addEventListener("click", async () => {
  setConvertViewState("result", {
    badge: "转换中",
    title: "正在处理订阅",
    description: "正在更新 GitHub Secret，并触发 publish-config 工作流..."
  });

  const result = await withAction(
    "正在同步并转换",
    "正在更新 GitHub Secret，并触发 publish-config 工作流...",
    () => window.subscriptionApp.syncAndRun(collectState())
  );

  applyState(result.state);
  switchView("convert");
  setConvertViewState("result", {
    badge: "已完成",
    title: "最终订阅地址",
    description: result.message
  });
  setStatus("success", "转换已触发", result.message);
  showToast("success", "转换已触发", result.message);
});

buttons.backToEdit.addEventListener("click", () => {
  setConvertViewState("input");
});

buttons.saveToken.addEventListener("click", async () => {
  const saved = await withAction("正在保存 Token", "正在写入本地加密存储...", () =>
    window.subscriptionApp.saveToken({ githubToken: fields.githubToken.value.trim() })
  );

  applyState(saved);
  switchView("token");
  setStatus("success", "Token 已保存", "后续可以直接进行订阅转换。");
  showToast("success", "Token 已保存", "后续可以直接进行订阅转换。");
});

buttons.loadToken.addEventListener("click", async () => {
  try {
    const savedToken = await window.subscriptionApp.getSavedToken();
    if (!savedToken) {
      setStatus("warning", "未找到 Token", "当前还没有保存过 Token。");
      showToast("warning", "未找到 Token", "当前还没有保存过 Token。");
      return;
    }

    fields.githubToken.value = savedToken;
    fields.githubToken.type = "text";
    tokenVisible = true;
    buttons.toggleToken.textContent = "🙈";
    setStatus("success", "Token 已显示", "你现在可以查看或覆盖已保存的 Token。");
  } catch {
    setStatus("error", "读取失败", "无法读取本地已保存的 Token。");
  }
});

buttons.toggleToken.addEventListener("click", async () => {
  if (!tokenVisible && !fields.githubToken.value.trim() && currentState?.tokenSaved) {
    try {
      const savedToken = await window.subscriptionApp.getSavedToken();
      if (savedToken) {
        fields.githubToken.value = savedToken;
      }
    } catch {
      setStatus("error", "读取失败", "无法读取本地已保存的 Token。");
      showToast("error", "读取失败", "无法读取本地已保存的 Token。");
      return;
    }
  }

  tokenVisible = !tokenVisible;
  fields.githubToken.type = tokenVisible ? "text" : "password";
  buttons.toggleToken.textContent = tokenVisible ? "🙈" : "👁";
});

buttons.openSecretPage.addEventListener("click", () => {
  window.subscriptionApp.openExternal(getSecretPageUrl());
});

buttons.openWorkflowPage.addEventListener("click", () => {
  window.subscriptionApp.openExternal(getWorkflowPageUrl());
});

buttons.openRawUrl.addEventListener("click", () => {
  const url = fields.gistRawUrl.value.trim();
  if (!url) {
    setStatus("warning", "缺少地址", "请先保留或生成最终的 Gist Raw URL。");
    showToast("warning", "缺少地址", "请先保留或生成最终的 Gist Raw URL。");
    return;
  }

  window.subscriptionApp.openExternal(url);
});

buttons.copyRawUrl.addEventListener("click", async () => {
  try {
    await copyText(fields.gistRawUrl.value.trim(), "最终订阅地址已复制到剪贴板。");
  } catch {
    setStatus("error", "复制失败", "当前环境不支持自动写入剪贴板。");
  }
});

buttons.minimizeWindow.addEventListener("click", () => {
  window.subscriptionApp.minimizeWindow();
});

buttons.maximizeWindow.addEventListener("click", async () => {
  const state = await window.subscriptionApp.toggleMaximizeWindow();
  updateMaximizeButton(state);
});

buttons.closeWindow.addEventListener("click", () => {
  window.subscriptionApp.closeWindow();
});

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    switchView(item.dataset.view);
  });
});

if (buttons.checkUpdate) {
  buttons.checkUpdate.addEventListener("click", () => {
    window.subscriptionApp.checkUpdate();
  });
}

init().catch((error) => {
  const message = error.message || "无法读取程序配置。";
  setStatus("error", "初始化失败", message);
  showToast("error", "初始化失败", message);
});
