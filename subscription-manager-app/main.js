const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const sodium = require("libsodium-wrappers");
const { autoUpdater } = require("electron-updater");

// 如果是私有仓库，需要读取环境变量或 Token 才能下载更新
// autoUpdater.requestHeaders = { "Authorization": `token ${process.env.GH_TOKEN}` };

const APP_DIR = __dirname;
const WORKSPACE_DIR = path.resolve(APP_DIR, "..");
const REPO_DIR = path.join(WORKSPACE_DIR, "ClashCustomRule");
const LOCAL_SECRETS_PATH = path.join(REPO_DIR, ".secrets.local");
const RUNTIME_DATA_DIR = path.join(APP_DIR, ".runtime");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");

// 绕过沙箱：将 AppData 目录重定向到当前目录下的 .runtime
// 注意：如果打包成了 exe 安装到 C 盘，这里可能没有写入权限。
// 对于独立安装包，建议去掉这行，让 Electron 使用系统默认的 AppData 路径。
// app.setPath("userData", path.join(RUNTIME_DATA_DIR, "userData"));
// app.setPath("sessionData", path.join(RUNTIME_DATA_DIR, "sessionData"));
// app.setPath("logs", path.join(RUNTIME_DATA_DIR, "logs"));

function getConfigPath() {
  return path.join(app.getPath("userData"), "subscription-manager.config.json");
}

function getDefaultState() {
  return {
    repoOwner: "Ljw858",
    repoName: "ClashCustomRule",
    branch: "master",
    workflowFile: "publish-config.yml",
    secretName: "SUBSCRIPTION_URLS",
    subscriptionUrls: "",
    githubToken: "",
    tokenSaved: false,
    secretPageUrl: "https://github.com/Ljw858/ClashCustomRule/settings/secrets/actions",
    workflowPageUrl: "https://github.com/Ljw858/ClashCustomRule/actions/workflows/publish-config.yml",
    gistRawUrl:
      "https://gist.githubusercontent.com/Ljw858/eeed8417ebb3014e4ddec9c895ec3d03/raw/clash-meta.yaml"
  };
}

async function readJsonSafe(filePath, fallbackValue) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function encryptToken(token) {
  if (!token) {
    return {
      githubTokenEncrypted: "",
      githubTokenPlain: ""
    };
  }

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token).toString("base64");
    return {
      githubTokenEncrypted: encrypted,
      githubTokenPlain: ""
    };
  }

  return {
    githubTokenEncrypted: "",
    githubTokenPlain: token
  };
}

function decryptToken(savedConfig) {
  if (savedConfig.githubTokenEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(savedConfig.githubTokenEncrypted, "base64"));
    } catch {
      return "";
    }
  }

  return savedConfig.githubTokenPlain || "";
}

function buildStateForRenderer(savedConfig, overrides = {}) {
  const merged = {
    ...getDefaultState(),
    ...savedConfig,
    ...overrides
  };

  const tokenSaved = Boolean(decryptToken(savedConfig));
  return {
    repoOwner: merged.repoOwner,
    repoName: merged.repoName,
    branch: merged.branch,
    workflowFile: merged.workflowFile,
    secretName: merged.secretName,
    subscriptionUrls: merged.subscriptionUrls,
    githubToken: "",
    tokenSaved,
    secretPageUrl: `https://github.com/${merged.repoOwner}/${merged.repoName}/settings/secrets/actions`,
    workflowPageUrl: `https://github.com/${merged.repoOwner}/${merged.repoName}/actions/workflows/${merged.workflowFile}`,
    gistRawUrl: merged.gistRawUrl
  };
}

function normalizeSubscriptionUrls(rawText) {
  return (rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

async function readLocalSubscriptionUrls() {
  try {
    const content = await fs.readFile(LOCAL_SECRETS_PATH, "utf8");
    const match = content.match(/^SUBSCRIPTION_URLS=(.*?)(?=^[A-Z0-9_]+=|\Z)/ms);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

async function updateLocalSecretsFile(subscriptionUrls) {
  try {
    const content = await fs.readFile(LOCAL_SECRETS_PATH, "utf8");
    const nextBlock = `SUBSCRIPTION_URLS=${subscriptionUrls}\r\n`;
    const updated = content.replace(
      /^SUBSCRIPTION_URLS=.*?(?=^[A-Z0-9_]+=|\Z)/ms,
      nextBlock
    );

    if (updated !== content) {
      await fs.writeFile(LOCAL_SECRETS_PATH, updated, "utf8");
    }
  } catch (error) {
    // 忽略文件不存在等错误，独立打包安装后不需要这个文件
    console.log("跳过更新 .secrets.local:", error.message);
  }
}

async function loadState() {
  const configPath = getConfigPath();
  const saved = await readJsonSafe(configPath, {});
  const localSubscriptionUrls = await readLocalSubscriptionUrls();
  return buildStateForRenderer(saved, {
    subscriptionUrls: localSubscriptionUrls || saved.subscriptionUrls || ""
  });
}

async function getSavedToken() {
  const configPath = getConfigPath();
  const saved = await readJsonSafe(configPath, {});
  return decryptToken(saved);
}

async function persistAndResolveState(input) {
  const configPath = getConfigPath();
  const savedConfig = await readJsonSafe(configPath, {});
  const subscriptionUrls = normalizeSubscriptionUrls(input.subscriptionUrls);
  if (!subscriptionUrls) {
    throw new Error("请至少填写一条订阅链接");
  }

  const existingToken = decryptToken(savedConfig);
  const resolvedToken = input.githubToken && input.githubToken.trim()
    ? input.githubToken.trim()
    : existingToken;

  const tokenStorage =
    input.githubToken && input.githubToken.trim()
      ? encryptToken(input.githubToken.trim())
      : {
          githubTokenEncrypted: savedConfig.githubTokenEncrypted || "",
          githubTokenPlain: savedConfig.githubTokenPlain || ""
        };

  const nextSavedConfig = {
    ...getDefaultState(),
    ...savedConfig,
    ...input,
    ...tokenStorage,
    githubToken: undefined,
    tokenSaved: undefined,
    subscriptionUrls
  };

  await updateLocalSecretsFile(subscriptionUrls);
  await writeJson(configPath, nextSavedConfig);

  return {
    resolvedState: {
      ...nextSavedConfig,
      githubToken: resolvedToken
    },
    rendererState: buildStateForRenderer(nextSavedConfig, {
      subscriptionUrls
    })
  };
}

async function saveTokenOnly(input) {
  const configPath = getConfigPath();
  const savedConfig = await readJsonSafe(configPath, {});
  const token = (input.githubToken || "").trim();
  if (!token) {
    throw new Error("请先输入 GitHub Token");
  }

  const tokenStorage = encryptToken(token);
  const nextSavedConfig = {
    ...getDefaultState(),
    ...savedConfig,
    ...tokenStorage
  };

  await writeJson(configPath, nextSavedConfig);
  return buildStateForRenderer(nextSavedConfig);
}

function getGithubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "subscription-manager-app"
  };
}

async function githubRequest(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && data.message
        ? data.message
        : `GitHub API 请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }

  return data;
}

async function syncSecretToGithub(state) {
  if (!state.githubToken || !state.githubToken.trim()) {
    throw new Error("请先填写 GitHub Token");
  }

  const owner = state.repoOwner.trim();
  const repo = state.repoName.trim();
  const secretName = state.secretName.trim();
  const token = state.githubToken.trim();
  const subscriptionUrls = normalizeSubscriptionUrls(state.subscriptionUrls);

  const keyInfo = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    {
      method: "GET",
      headers: getGithubHeaders(token)
    }
  );

  await sodium.ready;
  const encryptedBytes = sodium.crypto_box_seal(
    sodium.from_string(subscriptionUrls),
    sodium.from_base64(keyInfo.key, sodium.base64_variants.ORIGINAL)
  );
  const encryptedValue = sodium.to_base64(
    encryptedBytes,
    sodium.base64_variants.ORIGINAL
  );

  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
    {
      method: "PUT",
      headers: {
        ...getGithubHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyInfo.key_id
      })
    }
  );

  return {
    ok: true,
    message: "GitHub Secret 已更新"
  };
}

async function triggerWorkflow(state) {
  if (!state.githubToken || !state.githubToken.trim()) {
    throw new Error("请先填写 GitHub Token");
  }

  const owner = state.repoOwner.trim();
  const repo = state.repoName.trim();
  const token = state.githubToken.trim();

  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${state.workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        ...getGithubHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: state.branch
      })
    }
  );

  return {
    ok: true,
    message: "已触发 publish-config 工作流"
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 800,
    minHeight: 500,
    title: "订阅同步助手",
    backgroundColor: "#f3f4f6",
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(APP_DIR, "src", "index.html"));

  const sendWindowState = () => {
    win.webContents.send("window:state-changed", {
      isMaximized: win.isMaximized()
    });
  };

  win.on("maximize", sendWindowState);
  win.on("unmaximize", sendWindowState);
  win.on("enter-full-screen", sendWindowState);
  win.on("leave-full-screen", sendWindowState);
}

app.whenReady().then(() => {
  ipcMain.handle("state:load", async () => loadState());
  ipcMain.handle("token:get", async () => getSavedToken());
  ipcMain.handle("state:save", async (_event, state) => {
    const result = await persistAndResolveState(state);
    return result.rendererState;
  });
  ipcMain.handle("token:save", async (_event, payload) => saveTokenOnly(payload));
  ipcMain.handle("github:sync", async (_event, state) => {
    const result = await persistAndResolveState(state);
    await syncSecretToGithub(result.resolvedState);
    return {
      ok: true,
      message: "GitHub Secret 已更新",
      state: result.rendererState
    };
  });
  ipcMain.handle("github:run-workflow", async (_event, state) => {
    const result = await persistAndResolveState(state);
    await triggerWorkflow(result.resolvedState);
    return {
      ok: true,
      message: "已触发 publish-config 工作流",
      state: result.rendererState
    };
  });
  ipcMain.handle("github:sync-and-run", async (_event, state) => {
    const result = await persistAndResolveState(state);
    await syncSecretToGithub(result.resolvedState);
    await triggerWorkflow(result.resolvedState);
    return {
      ok: true,
      message: "订阅已同步到 GitHub，并已触发转换工作流",
      state: result.rendererState
    };
  });
  ipcMain.handle("shell:open", async (_event, targetUrl) => shell.openExternal(targetUrl));
  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.minimize();
    }
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return { isMaximized: false };
    }

    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }

    return { isMaximized: win.isMaximized() };
  });
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
    }
  });
  ipcMain.handle("window:get-state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return {
      isMaximized: Boolean(win && win.isMaximized())
    };
  });

  createWindow();

  // 自动更新逻辑
  let isManualCheck = false;
  autoUpdater.autoDownload = false;

  function sendUpdaterEvent(event, data) {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send("updater:event", event, data);
    });
  }

  autoUpdater.on("checking-for-update", () => {});

  autoUpdater.on("update-available", (info) => {
    sendUpdaterEvent("available", { version: info.version });
  });

  autoUpdater.on("update-not-available", (info) => {
    if (isManualCheck) {
      sendUpdaterEvent("not-available", null);
      isManualCheck = false;
    }
  });

  autoUpdater.on("error", (err) => {
    if (isManualCheck) {
      sendUpdaterEvent("error", { message: err.message || err.toString() });
      isManualCheck = false;
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendUpdaterEvent("downloaded", { version: info.version });
  });

  ipcMain.handle("app:check-update", async () => {
    isManualCheck = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      sendUpdaterEvent("error", { message: err.message || err.toString() });
      isManualCheck = false;
    }
  });

  ipcMain.handle("app:download-update", () => {
    autoUpdater.downloadUpdate();
  });

  ipcMain.handle("app:install-update", () => {
    autoUpdater.quitAndInstall();
  });

  // 启动时静默检查更新
  autoUpdater.checkForUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
