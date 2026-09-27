// 自動更新（メインプロセス専用）
// GitHub Releases に公開された新しい版を electron-updater で取得する。パッケージ版でのみ動作する。
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

let getWindow = () => null;
let manualCheck = false; // メニューから確認したときだけ「最新です」等を表示する
let downloaded = false;

function init(windowGetter) {
  getWindow = windowGetter;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // 「あとで」を選んだ場合は終了時に適用

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) showInfo('お使いのバージョンは最新です。', `バージョン ${app.getVersion()}`);
    manualCheck = false;
  });

  autoUpdater.on('update-available', (info) => {
    if (manualCheck) showInfo(`新しいバージョン ${info.version} があります。`, 'バックグラウンドでダウンロードします。完了したらお知らせします。');
    manualCheck = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    promptRestart(info.version);
  });

  // オフライン時などにダイアログを出さないよう、自動確認のエラーはログのみ
  autoUpdater.on('error', (e) => {
    console.error('[updater]', e);
    if (manualCheck) showError('更新の確認に失敗しました。', e.message);
    manualCheck = false;
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
}

async function checkNow() {
  if (!app.isPackaged) {
    await showInfo('開発版では更新を確認できません。');
    return;
  }
  if (downloaded) {
    await promptRestart();
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

async function promptRestart(version) {
  const win = getWindow();
  if (!win) return;
  const res = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['再起動して更新', 'あとで'],
    defaultId: 0,
    cancelId: 1,
    message: version ? `新しいバージョン ${version} の準備ができました。` : '新しいバージョンの準備ができました。',
    detail: '「あとで」を選んだ場合は、次回終了時に更新されます。',
  });
  if (res.response !== 0) return;

  // 未保存の変更があれば通常の終了時と同じ確認を出す
  const ok = await win.webContents.executeJavaScript('window.__confirmClose && window.__confirmClose()');
  if (!ok) return;
  win.__forceQuit = true;
  autoUpdater.quitAndInstall();
}

function showInfo(message, detail) {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, { type: 'info', message, detail }) : null;
}

function showError(message, detail) {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, { type: 'error', message, detail }) : null;
}

module.exports = { init, checkNow };
