---
name: workbuddy-checkin
description: WorkBuddy 每日签到 + 宠物自动探险领积分：查询签到状态与剩余积分、领取当日签到积分、派出宠物探险并在归来后自动领取积分。当用户要求 WorkBuddy 签到、领取每日积分、查询签到状态/连续天数/今日奖励/当前剩余积分、宠物探险/派宠物/领取探险奖励，或需要自动完成 WorkBuddy 签到与宠物探险任务时使用。
description_zh: WorkBuddy 每日签到与宠物自动探险领积分
description_en: "WorkBuddy daily check-in & pet auto-travel: query status/credits, claim daily reward, send pet on travel and auto-claim"
version: 1.0.2
---

# WorkBuddy 每日签到 + 宠物自动探险

仅支持 Windows（WorkBuddy 桌面版）。脚本零依赖、无推送/通知，结果输出到控制台。

## 使用流程

1. **环境自检**
   - 检查 Node.js：运行 `node --version`。若命令不存在或版本低于 18，引导用户安装 Node.js 18+（LTS）：访问 https://nodejs.org 下载安装，完成后重新执行自检。
   - 检查 WorkBuddy：确认本机已安装并登录 WorkBuddy 桌面版。
2. **只查询、不领取**：`node scripts/checkin.js --dry`；宠物探险只读：`node scripts/buddy_travel.js --dry`
3. **正式签到**：`node scripts/checkin.js`
4. **宠物探险（派出/领取）**：`node scripts/buddy_travel.js`

输出：签到状态、连续天数、今日奖励、当前剩余积分；宠物探险状态与动作结果。退出码 0=成功（含今日已签/无需动作），1=失败。

## 宠物自动探险（buddy_travel.js）

状态机：**idle → 自动派出**；**traveling → 显示预计归来时间**；**arrived → 自动领取积分**。幂等安全，重复运行无副作用（空闲时领取 / 已领取过均优雅跳过）。

| 配置（config.json 的 `travel`） | 说明 | 默认 |
|---|---|---|
| `travel.autoDepart` | 是否自动派出（`false`=仅领取不派出） | `true` |
| `travel.locationId` | 指定探险地点 id（如 `1`=咖啡馆）；留空取配置第一个 | 空 |
| `travel.locationCode` | 或按 code 指定（如 `coffee`） | 空 |

## 定时自动化（WorkBuddy「自动化」）

在 WorkBuddy 左侧边栏打开「自动化」添加任务（不需要 Windows 计划任务），频率设为「每天」：

- **任务一 · 每天 08:20**：提示词 = `运行 workbuddy-checkin 技能：先执行 node scripts/checkin.js 完成每日签到，再执行 node scripts/buddy_travel.js 处理宠物探险，汇报两项结果。`
- **任务二 · 每天 14:00**：提示词 = `运行 workbuddy-checkin 技能：执行 node scripts/buddy_travel.js 处理宠物探险（归来则领取积分并再次派出），汇报结果。`

## 环境探测与配置（config.json）

脚本自动探测本机环境，无需手动配置即可运行：

- **WorkBuddy.exe**：按「config.json 的 `appExe` → 注册表卸载项 DisplayIcon → %LOCALAPPDATA% 候选」顺序自动探测。
- **登录态文件**：默认 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`。

| 字段 | 说明 |
|---|---|
| `workbuddy.appExe` | WorkBuddy.exe 完整路径；留空=自动探测 |
| `workbuddy.authFile` | 登录态文件路径；留空=默认路径 |
| `workbuddy.billingBase` / `chatBase` | 接口域名，一般无需改动 |
| `travel.*` | 见上方「宠物自动探险」表 |

## 故障处理

- **找不到 Node.js**：引导用户安装 Node.js 18+（https://nodejs.org）。
- **找不到 WorkBuddy.exe / 凭据读取失败**：本机未安装或未登录 WorkBuddy，引导安装并登录；特殊安装路径可在 `config.json` 的 `appExe` 填写完整路径。
- **401 / token 过期**：脚本自动用 refreshToken 刷新一次；仍失败请在 WorkBuddy App 重新登录后再跑。
- **余额读不到**：best-effort，不影响签到，结果中仅缺余额一行。
- **探险接口异常**：多为登录态问题或功能未开放；确认在 WorkBuddy「成长空间」能看到宠物探险入口。
