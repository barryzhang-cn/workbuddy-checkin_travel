#!/usr/bin/env node
/**
 * WorkBuddy 宠物自动探险（workbuddy-checkin 技能）
 * 状态机：idle → 派出探险；traveling → 显示预计归来；arrived → 领取积分。
 * 幂等安全：重复运行无副作用；无任何推送/通知，结果输出到控制台。
 * 用法：node scripts/buddy_travel.js [--dry]
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
const LOG = path.join(SKILL_DIR, 'travel.log');
const TIMEOUT = cfg.requestTimeoutMs || 20000;
const TRAVEL = cfg.travel || {};
const API_BASE = 'https://copilot.tencent.com';

// ---------- 通用 ----------
function log(line) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const entry = `[${ts}] ${line}\n`;
  try { fs.appendFileSync(LOG, entry, 'utf8'); } catch {}
  console.log(entry.trim());
}

// ============================================================
// WorkBuddy 凭据（与 checkin.js 同一套解密逻辑，逐字沿用）
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

// ============================================================
// HTTP（支持 GET/POST，Bearer + X-User-Id）
// ============================================================
async function http(base, method, pathname, token, extra, body) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: method === 'GET' ? undefined : (body ? JSON.stringify(body) : '{}'),
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
  const data = await http(WB.chatBase, 'POST', '/v2/plugin/auth/token/refresh', '', {
    'X-Refresh-Token': cred.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    ...(cred.domain ? { 'X-Domain': cred.domain } : {}),
  }, {});
  if (!data.accessToken) throw new Error('刷新令牌未返回 accessToken，请在 WorkBuddy App 重新登录');
  return { ...cred, accessToken: data.accessToken, refreshToken: data.refreshToken || cred.refreshToken };
}

// ============================================================
// 宠物探险状态机
// ============================================================
function fmtTime(ts) {
  try {
    const d = new Date(Number(ts) * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return String(ts); }
}
function pickLocation(locations) {
  if (!Array.isArray(locations) || !locations.length) return null;
  const id = TRAVEL.locationId;
  const code = TRAVEL.locationCode;
  if (id != null && id !== '') { const l = locations.find(x => String(x.id) === String(id)); if (l) return l; }
  if (code) { const l = locations.find(x => x.code === code); if (l) return l; }
  return locations[0];
}

async function loadCred() {
  const raw = JSON.parse(fs.readFileSync(WB.authFile || wbDefaultAuth(), 'utf8'));
  const exe = wbLocateExe();
  const key = wbDeriveKey(wbFetchKeyPayload(exe));
  return {
    accessToken: wbOpen(raw.auth.accessToken, key),
    refreshToken: (raw.auth.refreshToken && raw.auth.refreshToken.$wbEncrypted === 1) ? wbOpen(raw.auth.refreshToken, key) : '',
    uid: (raw.account && raw.account.uid) || '',
    domain: raw.auth.domain || '',
    expiresAt: raw.auth.expiresAt || 0,
  };
}
const extraHeaders = cred => ({ ...(cred.uid ? { 'X-User-Id': cred.uid } : {}), ...(cred.domain ? { 'X-Domain': cred.domain } : {}) });

async function runTravel(cred) {
  let extra = extraHeaders(cred);
  const call = async (method, pathname, body) => {
    try { return await http(API_BASE, method, pathname, cred.accessToken, extra, body); }
    catch (e) {
      if (e.httpStatus === 401) {
        cred = await wbRefresh(cred);
        extra = extraHeaders(cred);
        return await http(API_BASE, method, pathname, cred.accessToken, extra, body);
      }
      throw e;
    }
  };

  const status = await call('GET', '/activity/growth/buddy/travel/status');
  const state = status.state;
  const limitReached = status.daily_limit_reached === true;
  const locName = (status.location && status.location.name) || '';
  const serverNow = Number(status.server_now) || Math.floor(Date.now() / 1000);
  const arriveAt = Number(status.arrive_at) || 0;

  if (state === 'arrived') {
    if (DRY) return { ok:true, lines:[`🔎 [dry] 宠物已归来，待领取积分（未执行领取）`] };
    let ck;
    try { ck = await call('POST', '/activity/growth/buddy/travel/claim', {}); }
    catch (e) {
      if (e.code === 400 && /no unclaimed|unclaimed|已领取/i.test(e.message)) {
        return { ok:true, lines:[`宠物已归来，但本次无可领取奖励（可能已领取过）`] };
      }
      throw e;
    }
    const credit = (ck.credit ?? ck.reward_credit ?? status.reward_credit ?? 0);
    return { ok:true, lines:[`🎉 宠物已归来，自动领取积分 +${credit}`] };
  }
  if (state === 'traveling') {
    const remainMin = Math.max(0, Math.floor((arriveAt - serverNow) / 60));
    const eta = arriveAt ? fmtTime(arriveAt) : '未知';
    return { ok:true, lines:[`🚀 宠物正在探险中（${locName || '未知地点'}），预计 ${eta} 归来（约 ${remainMin} 分钟后），本轮不重复派出`] };
  }
  if (state === 'idle') {
    if (limitReached) return { ok:true, lines:[`😴 宠物空闲，但今日派出次数已达上限，明天再派`] };
    if (TRAVEL.autoDepart === false) return { ok:true, lines:[`😴 宠物空闲（autoDepart=false，仅领取模式，未自动派出）`] };
    const cfgData = await call('GET', '/activity/growth/buddy/travel/config');
    const loc = pickLocation(cfgData.locations);
    if (!loc) throw new Error('未获取到可选的探险地点配置');
    if (DRY) return { ok:true, lines:[`🔎 [dry] 宠物空闲，将派出前往「${loc.name}」（约 ${loc.duration_hours_min}–${loc.duration_hours_max} 小时，${loc.reward_credit_min}–${loc.reward_credit_max} 积分）（未执行派出）`] };
    const dp = await call('POST', '/activity/growth/buddy/travel/depart', { location_id: loc.id });
    const dur = loc.duration_hours_max || loc.duration_hours_min || '?';
    return { ok:true, lines:[`🐾 已自动派出宠物前往「${loc.name}」，约 ${dur} 小时后归来；归来后再次运行本脚本即可自动领取`] };
  }
  return { ok:true, lines:[`宠物状态未知: ${state}`] };
}

async function main() {
  let cred;
  try { cred = await loadCred(); }
  catch (e) { log(`❌ 凭据读取失败：${e.message}`); process.exit(1); }
  if (cred.expiresAt && Date.now() > cred.expiresAt - 60000) {
    try { cred = await wbRefresh(cred); log('WB accessToken 已刷新'); } catch (e) { log(`WB 刷新失败: ${e.message}`); }
  }
  const r = await runTravel(cred).catch(e => ({ ok:false, lines:[`❌ 探险异常：${e.message}`] }));
  const out = ['## 🐱 WorkBuddy 宠物自动探险', `> ${new Date().toLocaleString('zh-CN', { hour12:false })}`, '', ...r.lines].join('\n');
  log(out);
  process.exit(r.ok ? 0 : 1);
}

main().catch(e => {
  log(`未捕获异常: ${e.stack || e.message}`);
  process.exit(1);
});
