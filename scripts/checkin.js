#!/usr/bin/env node
/**
 * WorkBuddy 每日签到（workbuddy-checkin 技能）
 * 读取本机 WorkBuddy 登录态，查询签到状态与剩余积分；未签到则领取当日积分。
 * 结果直接输出到控制台，无任何推送/通知。零依赖，仅用 Node 内置模块。
 * 用法：node scripts/checkin.js [--dry]
 */
'use strict';

if (!global.fetch || typeof global.fetch !== 'function') {
  console.error('[ERROR] 需要 Node.js 18+（内置 fetch）。请升级 Node.js：https://nodejs.org');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'));
const DRY = process.argv.includes('--dry');
const LOG = path.join(SKILL_DIR, 'checkin.log');
const TIMEOUT = cfg.requestTimeoutMs || 20000;

// ---------- 通用 ----------
function log(line) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const entry = `[${ts}] ${line}\n`;
  try { fs.appendFileSync(LOG, entry, 'utf8'); } catch {}
  console.log(entry.trim());
}

// ============================================================
// WorkBuddy（codebuddy.cn，Bearer，AES-256-GCM 本地解密）
// ============================================================
const WB = cfg.workbuddy || {};

function wbDefaultAuth() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(base, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
}
function regQuery(args) {
  try { return execFileSync('reg', ['query', ...args], { windowsHide:true, encoding:'utf8', maxBuffer: 1024*1024 }).toString(); }
  catch { return ''; }
}
function wbLocateExe() {
  if (WB.appExe && fs.existsSync(WB.appExe)) return WB.appExe;
  const roots = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    const out = regQuery([root, '/s', '/f', 'WorkBuddy', '/t', 'REG_SZ']);
    const m = out.match(/DisplayIcon\s+REG_SZ\s+([^,\r\n]+)/i);
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  }
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到 WorkBuddy.exe，请在 config.json 的 workbuddy.appExe 填完整路径');
}
function wbFetchKeyPayload(exe) {
  const source =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
    "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";
  const out = execFileSync(exe, ['-e', source], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 10000, windowsHide: true, maxBuffer: 1024*1024,
  });
  const payload = out.toString('utf8').trim();
  if (!payload) throw new Error('WorkBuddy 未返回 at-rest 密钥载荷');
  return payload;
}
function wbDeriveKey(payloadJson) {
  const secret = JSON.parse(payloadJson).atRestSecretKey;
  if (typeof secret !== 'string' || !secret) throw new Error('密钥载荷缺少 atRestSecretKey');
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}
const wbU32 = n => { const b=Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const wbLp = s => { const b=Buffer.from(s,'utf8'); return Buffer.concat([wbU32(b.length), b]); };
function wbAad(keyId, suite) {
  return Buffer.concat([
    Buffer.from('WB-AAD\0','ascii'), Buffer.from([1]),
    wbLp('WBEV1'), wbLp('sym-v1'), wbU32(suite), wbLp(keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ]);
}
function wbOpen(wrapper, key) {
  const env = JSON.parse(Buffer.from(wrapper.envelope,'base64').toString('utf8'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce,'base64'), { authTagLength:16 });
  d.setAAD(wbAad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag,'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext,'base64')), d.final()]).toString('utf8');
}

async function wbApi(base, pathname, token, extra, body) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
  const res = await fetch(base + pathname, {
    method:'POST', headers, body: body ? JSON.stringify(body) : '{}',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  let env; try { env = JSON.parse(text); } catch { throw new Error(`非 JSON(http ${res.status}): ${text.slice(0,120)}`); }
  if (!res.ok || (env.code !== 0 && env.code !== undefined)) {
    const err = new Error(`上游错误: ${env.msg||env.message||`http ${res.status} code ${env.code}`}`);
    err.httpStatus = res.status; err.code = env.code; throw err;
  }
  return env.data || {};
}
async function wbRefresh(cred) {
  const data = await wbApi(WB.chatBase, '/v2/plugin/auth/token/refresh', '', {
    'X-Refresh-Token': cred.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    ...(cred.domain ? { 'X-Domain': cred.domain } : {}),
  }, {});
  if (!data.accessToken) throw new Error('刷新令牌未返回 accessToken，请在 WorkBuddy App 重新登录');
  return { ...cred, accessToken: data.accessToken, refreshToken: data.refreshToken || cred.refreshToken };
}

const fmtNum = n => {
  const v = Math.round(n * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

// 读取当前剩余积分总额（best-effort，失败不影响签到）
async function wbFetchBalance(cred, extra) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  const body = {
    PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
  };
  const data = await wbApi(WB.billingBase, '/v2/billing/meter/get-user-resource', cred.accessToken, extra, body);
  const accounts = data?.Response?.Data?.Accounts;
  if (!Array.isArray(accounts)) return null;
  let total = 0;
  for (const a of accounts) {
    const pt = k => {
      const v = a[`${k}Precise`];
      if (typeof v === 'string' && v !== '') { const n = parseFloat(v); if (Number.isFinite(n)) return n; }
      return typeof a[k] === 'number' ? a[k] : 0;
    };
    const monthly = a.CapacityType === 4;
    const remain = monthly ? pt('CycleCapacityRemain') : pt('CapacityRemain');
    const r = remain < 0 ? 0 : remain;
    if (!monthly && r <= 0) continue;
    total += r;
  }
  return total;
}

async function runWorkBuddy() {
  const r = { name:'WorkBuddy', ok:false, summary:'', detail:[], balance:'' };
  if (WB.enabled === false) { r.summary='⏭️ 已在配置中禁用'; return r; }

  let cred;
  try {
    const raw = JSON.parse(fs.readFileSync(WB.authFile || wbDefaultAuth(), 'utf8'));
    const exe = wbLocateExe();
    const key = wbDeriveKey(wbFetchKeyPayload(exe));
    cred = {
      accessToken: wbOpen(raw.auth.accessToken, key),
      refreshToken: (raw.auth.refreshToken && raw.auth.refreshToken.$wbEncrypted === 1) ? wbOpen(raw.auth.refreshToken, key) : '',
      uid: (raw.account && raw.account.uid) || '',
      domain: raw.auth.domain || '',
      expiresAt: raw.auth.expiresAt || 0,
    };
  } catch (e) { r.summary=`❌ 凭据读取失败：${e.message}`; return r; }

  // 临近过期先刷新
  if (cred.expiresAt && Date.now() > cred.expiresAt - 60000) {
    try { cred = await wbRefresh(cred); log('WB accessToken 已刷新'); } catch (e) { log(`WB 刷新失败: ${e.message}`); }
  }
  const extra = { ...(cred.uid?{'X-User-Id':cred.uid}:{}), ...(cred.domain?{'X-Domain':cred.domain}:{}) };

  // best-effort 读取当前剩余积分，失败不阻断签到
  try { const bal = await wbFetchBalance(cred, extra); if (bal != null) r.balance = `${fmtNum(bal)} credits`; }
  catch (e) { log(`WB 余额读取失败: ${e.message}`); }

  let st;
  try {
    st = await wbApi(WB.billingBase, '/v2/billing/meter/checkin-activity-status', cred.accessToken, extra, {});
  } catch (e) {
    if (e.httpStatus === 401 || /token|未授权|登录|expire/i.test(e.message)) {
      try { cred = await wbRefresh(cred); st = await wbApi(WB.billingBase, '/v2/billing/meter/checkin-activity-status', cred.accessToken, extra, {}); }
      catch (e2) { r.summary=`❌ 状态查询失败：${e2.message}`; return r; }
    } else { r.summary=`❌ 状态查询失败：${e.message}`; return r; }
  }

  const active = st.active === true;
  const todayIn = st.today_checked_in === true;
  const streak = Number(st.streak_days)||0;
  const dailyCredit = Number(st.daily_credit)||0;
  const todayCredit = Number(st.today_credit)||0;
  const nextStreak = Number(st.next_streak_day)||0;
  const isStreak = st.is_streak_day === true;
  log(`WB: active=${active} today=${todayIn} streak=${streak} todayCredit=${todayCredit}`);

  if (!active) { r.ok=true; r.summary='⚪ 活动未开始或已结束'; r.detail.push(`连续 ${streak} 天`); return r; }
  if (todayIn) {
    r.ok=true; r.summary='✅ 今日已签到（无需重复）';
    r.detail.push(`连续 ${streak} 天`); if(todayCredit) r.detail.push(`今日 ${todayCredit} credits`);
    return r;
  }
  if (DRY) { r.ok=true; r.summary='🔎 [dry] 未领取'; r.detail.push(`连续 ${streak} 天`); return r; }

  try {
    const claim = await wbApi(WB.billingBase, '/v2/billing/meter/daily-checkin', cred.accessToken, extra, {});
    r.ok=true; r.summary='✅ 签到成功';
    r.detail.push(`本次 +${Number(claim.credit)||0} credits`);
    r.detail.push(`连续 ${Number(claim.streak_days)||streak} 天`);
    if (claim.is_streak_day === true) r.detail.push('🎁 连签奖励日');
  } catch (e) { r.summary=`❌ 领取失败：${e.message}`; }
  return r;
}

async function main() {
  const r = await runWorkBuddy().catch(e => ({ name:'WorkBuddy', ok:false, summary:`❌ 异常：${e.message}`, detail:[], balance:'' }));
  log(`${r.name}: ${r.summary} ${r.detail.join(' ')}`);
  const lines = [
    '## 📅 WorkBuddy 每日签到',
    `> ${new Date().toLocaleString('zh-CN', { hour12:false })}`,
    '',
    `- ${r.summary}`,
  ];
  if (r.detail.length) lines.push(`- ${r.detail.join('　｜　')}`);
  if (r.balance) lines.push(`- 💰 当前剩余积分：${r.balance}`);
  console.log(lines.join('\n'));
  process.exit(r.ok ? 0 : 1);
}

main().catch(e => {
  log(`未捕获异常: ${e.stack||e.message}`);
  process.exit(1);
});
