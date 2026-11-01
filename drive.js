// Googleドライブ連携（メインプロセス専用）
// OAuth デスクトップフロー（ループバック + PKCE）と Drive REST API v3 を fetch で直接呼ぶ。
const { app, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = '小説エディタ';
// 原稿はテキストファイルのまま置く。Googleドキュメントに変換すると、
// 全角スペースが半角になる・書き出し時に空行が倍になる、などで本文が変わってしまうため。
const TEXT_MIME = 'text/plain';
// 以前の版で作ったGoogleドキュメント。開くことはできるが、保存はテキストファイルに切り替える
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const META_FIELDS = 'id,name,mimeType,modifiedTime';

const credentialsPath = () => path.join(app.getPath('userData'), 'google-credentials.json');
const tokenPath = () => path.join(app.getPath('userData'), 'google-token.bin');

let credentials = null; // { client_id, client_secret }
let refreshToken = null;
let accessToken = null;
let accessTokenExpiry = 0;
let folderId = null;

// 配布版に同梱するクライアントID（リポジトリには含めず、ビルド時に置く）
const bundledCredentialsPath = () => path.join(__dirname, 'oauth-client.json');

// ---- 認証情報 ----
// Google からダウンロードしたクライアントIDのJSONを解釈する
function parseCredentials(raw, fileName) {
  const json = JSON.parse(raw);
  const c = json.installed || json.web || json;
  if (!c.client_id) throw new Error(`${fileName} に client_id がありません。`);
  return { client_id: c.client_id, client_secret: c.client_secret };
}

// userData の google-credentials.json（利用者が自分で設定したもの）を優先し、なければ同梱版を使う
async function loadCredentials() {
  if (credentials) return credentials;
  for (const file of [credentialsPath(), bundledCredentialsPath()]) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    credentials = parseCredentials(raw, path.basename(file));
    return credentials;
  }
  return null;
}

async function hasCredentials() {
  return !!(await loadCredentials());
}

// ダウンロードしたクライアントIDのJSONを userData にコピーする
async function importCredentials(srcPath) {
  const raw = await fs.readFile(srcPath, 'utf8');
  try {
    parseCredentials(raw, path.basename(srcPath));
  } catch {
    throw new Error('OAuth クライアントIDのJSONではないようです（client_id がありません）。');
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(credentialsPath(), raw, 'utf8');
  credentials = null;
  await loadCredentials();
}

// ---- トークン保存（safeStorage で暗号化） ----
async function loadRefreshToken() {
  if (refreshToken) return refreshToken;
  try {
    const buf = await fs.readFile(tokenPath());
    refreshToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8');
  } catch {
    refreshToken = null;
  }
  return refreshToken;
}

async function saveRefreshToken(token) {
  refreshToken = token;
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf8');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(tokenPath(), data);
}

async function clearTokens() {
  refreshToken = null;
  accessToken = null;
  accessTokenExpiry = 0;
  folderId = null;
  await fs.rm(tokenPath(), { force: true });
}

async function isSignedIn() {
  return !!(await loadRefreshToken());
}

// ---- OAuth フロー ----
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(`トークン取得に失敗しました: ${json.error_description || json.error || res.status}`);
    err.code = json.error;
    throw err;
  }
  return json;
}

function setAccessToken(json) {
  accessToken = json.access_token;
  accessTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
}

async function signIn() {
  const cred = await loadCredentials();
  if (!cred) throw new Error('google-credentials.json が設定されていません。');

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const stateParam = base64url(crypto.randomBytes(16));

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    let redirectUri = '';
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('ログインがタイムアウトしました（5分）。'));
    }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get('state') === stateParam && url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok
        ? '<p>ログインしました。このタブを閉じて小説エディタに戻ってください。</p>'
        : '<p>ログインに失敗しました。小説エディタからやり直してください。</p>');
      clearTimeout(timer);
      server.close();
      if (ok) resolve({ code: url.searchParams.get('code'), redirectUri });
      else reject(new Error(`ログインが中断されました: ${url.searchParams.get('error') || '不明なエラー'}`));
    });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const authUrl = `${AUTH_URL}?${new URLSearchParams({
        client_id: cred.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: stateParam,
      })}`;
      shell.openExternal(authUrl);
    });
  });

  const params = {
    code,
    client_id: cred.client_id,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  };
  if (cred.client_secret) params.client_secret = cred.client_secret;
  const json = await postToken(params);
  if (!json.refresh_token) throw new Error('リフレッシュトークンを取得できませんでした。');
  await saveRefreshToken(json.refresh_token);
  setAccessToken(json);
}

async function signOut() {
  const token = await loadRefreshToken();
  if (token) {
    // 失効はベストエフォート（オフラインでもローカルのトークンは消す）
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    } catch {}
  }
  await clearTokens();
}

// 並行リクエストでトークン更新・ログインが重複しないよう、進行中の処理を共有する
let pendingToken = null;
function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry) return Promise.resolve(accessToken);
  if (!pendingToken) pendingToken = fetchAccessToken().finally(() => { pendingToken = null; });
  return pendingToken;
}

async function fetchAccessToken() {
  const token = await loadRefreshToken();
  if (!token) {
    await signIn();
    return accessToken;
  }
  const cred = await loadCredentials();
  if (!cred) throw new Error('google-credentials.json が設定されていません。');
  const params = { refresh_token: token, client_id: cred.client_id, grant_type: 'refresh_token' };
  if (cred.client_secret) params.client_secret = cred.client_secret;
  try {
    setAccessToken(await postToken(params));
  } catch (e) {
    if (e.code === 'invalid_grant') {
      // トークン失効・取り消し済み → 再ログイン
      await clearTokens();
      await signIn();
    } else {
      throw e;
    }
  }
  return accessToken;
}

// ---- Drive API ----
async function request(url, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const json = await res.json();
      detail = json.error && json.error.message;
    } catch {}
    throw new Error(`ドライブAPIエラー (${res.status}): ${detail || res.statusText}`);
  }
  return res;
}

function normalizeText(text) {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function escapeQuery(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function ensureFolder() {
  if (folderId) return folderId;
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeQuery(FOLDER_NAME)}' and trashed=false`;
  const res = await request(`${API}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
  const { files } = await res.json();
  if (files.length > 0) {
    folderId = files[0].id;
    return folderId;
  }
  const created = await request(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  folderId = (await created.json()).id;
  return folderId;
}

async function listFiles() {
  const parent = await ensureFolder();
  const q = `'${parent}' in parents and (mimeType='${TEXT_MIME}' or mimeType='${DOC_MIME}') and trashed=false`;
  const res = await request(`${API}/files?${new URLSearchParams({
    q,
    fields: `files(${META_FIELDS})`,
    orderBy: 'modifiedTime desc',
    pageSize: '200',
  })}`);
  return (await res.json()).files;
}

async function getMeta(id) {
  const res = await request(`${API}/files/${encodeURIComponent(id)}?fields=${META_FIELDS}`);
  return res.json();
}

function isDoc(meta) {
  return meta.mimeType === DOC_MIME;
}

async function readText(meta) {
  const id = encodeURIComponent(meta.id);
  const url = isDoc(meta)
    ? `${API}/files/${id}/export?mimeType=text/plain`
    : `${API}/files/${id}?alt=media`;
  // 文字コードを推測させず、必ず UTF-8 として読む
  const buf = Buffer.from(await (await request(url)).arrayBuffer());
  return normalizeText(buf.toString('utf8'));
}

async function openFile(id) {
  const meta = await getMeta(id);
  return { meta, content: await readText(meta) };
}

function withTxtExt(name) {
  return /\.txt$/i.test(name) ? name : `${name}.txt`;
}

// テキストファイルとして新規作成（Googleドキュメントには変換しない）
async function createFile(name, content) {
  const parent = await ensureFolder();
  const boundary = `novel-editor-${crypto.randomBytes(8).toString('hex')}`;
  const metadata = { name: withTxtExt(name), mimeType: TEXT_MIME, parents: [parent] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await request(`${UPLOAD_API}/files?uploadType=multipart&fields=${META_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: Buffer.from(body, 'utf8'),
  });
  return res.json();
}

// 既存テキストファイルの本文を置き換える（ファイルIDは維持）
async function updateFile(id, content) {
  const res = await request(`${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=${META_FIELDS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: Buffer.from(content, 'utf8'),
  });
  return res.json();
}

// リモートが baseModifiedTime 以降に（内容として）変わったか調べる。
// 時刻だけ動いて中身が同じこともあるため、時刻が違えば本文も比較する。
async function checkRemote(id, baseModifiedTime, baseContent) {
  const meta = await getMeta(id);
  if (meta.modifiedTime === baseModifiedTime) return { changed: false, meta };
  const content = await readText(meta);
  return { changed: content !== normalizeText(baseContent), meta, content };
}

module.exports = {
  hasCredentials,
  importCredentials,
  isSignedIn,
  signIn,
  signOut,
  listFiles,
  getMeta,
  isDoc,
  openFile,
  createFile,
  updateFile,
  checkRemote,
};
