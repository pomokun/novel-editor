const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const drive = require('./drive');
const updater = require('./updater');

const HOMEPAGE_URL = 'https://pomokun.github.io/novel-editor/';

// 配布版は productName（日本語名）で userData が作られるため、開発版と同じ %APPDATA%\novel-editor に固定する
app.setPath('userData', path.join(app.getPath('appData'), 'novel-editor'));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: '小説エディタ',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      minimumFontSize: 1,
      defaultFontSize: 16,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const menu = Menu.buildFromTemplate([
    {
      label: 'ファイル',
      submenu: [
        { label: '新規', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new') },
        { label: '開く...', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open') },
        { label: '上書き保存', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { label: '名前を付けて保存...', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:save-as') },
        { type: 'separator' },
        { role: 'quit', label: '終了' },
      ],
    },
    {
      label: 'ドライブ',
      submenu: [
        { label: 'ドライブから開く...', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:drive-open') },
        { label: 'ドライブに保存', click: () => send('menu:drive-save') },
        { label: 'ドライブに名前を付けて保存...', click: () => send('menu:drive-save-as') },
        { type: 'separator' },
        { label: 'ログイン', click: () => driveSignIn() },
        { label: 'ログアウト', click: () => driveSignOut() },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直し' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
        { type: 'separator' },
        { label: '自動字下げ', type: 'checkbox', checked: true, click: (item) => sendWith('menu:auto-indent', item.checked) },
        {
          label: '字下げの空白',
          submenu: [
            { label: '全角空白', type: 'radio', checked: true, click: () => sendWith('menu:indent-char', 'full') },
            { label: '半角空白', type: 'radio',                click: () => sendWith('menu:indent-char', 'half') },
          ],
        },
        { label: '段落を一括字下げ', click: () => send('menu:indent-all') },
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: 'プレビュー切替', accelerator: 'CmdOrCtrl+P', click: () => send('menu:toggle-preview') },
        { label: '空白を表示', type: 'checkbox', checked: true, click: (item) => sendWith('menu:show-spaces', item.checked) },
        {
          label: '用紙サイズ',
          submenu: [
            { label: 'B5 縦 (182 × 257 mm)', type: 'radio', checked: true,  click: () => sendWith('menu:paper-size', 'B5P') },
            { label: 'B5 横 (257 × 182 mm)', type: 'radio',                click: () => sendWith('menu:paper-size', 'B5L') },
            { label: 'A5 縦 (148 × 210 mm)', type: 'radio',                click: () => sendWith('menu:paper-size', 'A5P') },
            { label: 'A5 横 (210 × 148 mm)', type: 'radio',                click: () => sendWith('menu:paper-size', 'A5L') },
            { label: 'A4 縦 (210 × 297 mm)', type: 'radio',                click: () => sendWith('menu:paper-size', 'A4P') },
            { label: 'B6 縦 (128 × 182 mm)', type: 'radio',                click: () => sendWith('menu:paper-size', 'B6P') },
            { label: '四六判 縦 (127 × 188 mm)', type: 'radio',            click: () => sendWith('menu:paper-size', 'SHIROKU') },
          ],
        },
        // 開発者向けの項目はパッケージ版では出さない
        ...(app.isPackaged ? [] : [
          { type: 'separator' },
          { role: 'reload', label: '再読み込み' },
          { role: 'toggleDevTools', label: '開発者ツール' },
        ]),
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: '更新を確認...', click: () => updater.checkNow() },
        { label: 'Webサイト', click: () => shell.openExternal(HOMEPAGE_URL) },
        { type: 'separator' },
        { label: 'バージョン情報', click: () => showAbout() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  // スマホ等での更新をチェックするため、フォーカス復帰を通知
  mainWindow.on('focus', () => send('drive:focus'));

  mainWindow.on('close', async (e) => {
    if (!mainWindow.__forceQuit) {
      e.preventDefault();
      const ok = await mainWindow.webContents.executeJavaScript('window.__confirmClose && window.__confirmClose()');
      if (ok) {
        mainWindow.__forceQuit = true;
        mainWindow.close();
      }
    }
  });
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'バージョン情報',
    message: `小説エディタ ${app.getVersion()}`,
    detail: HOMEPAGE_URL,
  });
}

function send(channel) {
  if (mainWindow) mainWindow.webContents.send(channel);
}
function sendWith(channel, payload) {
  if (mainWindow) mainWindow.webContents.send(channel, payload);
}

ipcMain.handle('dialog:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'テキスト', extensions: ['txt'] }, { name: 'すべて', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  const buf = await fs.readFile(filePath);
  const content = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
  return { path: filePath, content };
});

ipcMain.handle('dialog:save', async (_e, { path: currentPath, content }) => {
  let target = currentPath;
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'テキスト', extensions: ['txt'] }],
      defaultPath: '無題.txt',
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  await fs.writeFile(target, normalized, 'utf8');
  return target;
});

ipcMain.handle('dialog:save-as', async (_e, { content }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'テキスト', extensions: ['txt'] }],
    defaultPath: '無題.txt',
  });
  if (res.canceled || !res.filePath) return null;
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  await fs.writeFile(res.filePath, normalized, 'utf8');
  return res.filePath;
});

ipcMain.handle('dialog:confirm-discard', async () => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['破棄して閉じる', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: '未保存の変更があります。破棄しますか?',
  });
  return res.response === 0;
});

// ---- Googleドライブ ----
async function showError(message) {
  await dialog.showMessageBox(mainWindow, { type: 'error', message });
}

// クライアントIDのJSONが未設定なら取り込んでもらう
async function ensureDriveCredentials() {
  if (await drive.hasCredentials()) return true;
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['JSONファイルを選択...', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    message: 'Googleドライブ連携の初期設定',
    detail: 'この開発版にはクライアントIDが同梱されていません。Google Cloud Console で作成した OAuth クライアントID（デスクトップアプリ）の JSON ファイルを選択してください。手順は README.md を参照してください。',
  });
  if (res.response !== 0) return false;
  const pick = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (pick.canceled || pick.filePaths.length === 0) return false;
  await drive.importCredentials(pick.filePaths[0]);
  return true;
}

// ドライブ操作の共通ラッパー：初期設定確認とエラー表示
async function withDrive(fn) {
  try {
    if (!(await ensureDriveCredentials())) return null;
    return await fn();
  } catch (e) {
    await showError(e.message);
    return null;
  }
}

async function driveSignIn() {
  await withDrive(async () => {
    await drive.signIn();
    await dialog.showMessageBox(mainWindow, { type: 'info', message: 'Googleドライブにログインしました。' });
  });
}

async function driveSignOut() {
  try {
    await drive.signOut();
    await dialog.showMessageBox(mainWindow, { type: 'info', message: 'Googleドライブからログアウトしました。' });
  } catch (e) {
    await showError(e.message);
  }
}

ipcMain.handle('drive:list', () => withDrive(() => drive.listFiles()));

ipcMain.handle('drive:open', (_e, id) => withDrive(() => drive.openFile(id)));

ipcMain.handle('drive:save', (_e, { id, name, content, baseModifiedTime, baseContent }) => withDrive(async () => {
  if (!id) return { status: 'saved', meta: await drive.createFile(name, content) };

  const remote = await drive.checkRemote(id, baseModifiedTime, baseContent);
  if (remote.changed) {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['上書き保存', 'ドライブ版を読み込む', 'キャンセル'],
      defaultId: 2,
      cancelId: 2,
      message: 'ドライブ上のファイルが他の場所で更新されています。',
      detail: '上書き保存すると、他の場所（スマホ等）での変更は失われます。',
    });
    if (res.response === 1) return { status: 'reload', meta: remote.meta, content: remote.content };
    if (res.response === 2) return { status: 'canceled' };
  }
  return { status: 'saved', meta: await drive.updateFile(id, content) };
}));

// フォーカス復帰時のチェック。未ログイン時やエラー時は静かに何もしない
ipcMain.handle('drive:check', async (_e, { id, baseModifiedTime, baseContent }) => {
  try {
    if (!(await drive.hasCredentials()) || !(await drive.isSignedIn())) return null;
    return await drive.checkRemote(id, baseModifiedTime, baseContent);
  } catch {
    return null;
  }
});

ipcMain.handle('drive:confirm-reload', async (_e, { dirty }) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['読み込む', 'あとで'],
    defaultId: dirty ? 1 : 0,
    cancelId: 1,
    message: 'ドライブ上のファイルが他の場所で更新されました。最新版を読み込みますか?',
    detail: dirty ? '読み込むと、編集中の未保存の変更は失われます。' : undefined,
  });
  return res.response === 0;
});

// 多重起動を防ぎ、2つ目の起動時は既存のウィンドウを前面に出す
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    updater.init(() => mainWindow);
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
