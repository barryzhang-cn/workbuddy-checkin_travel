# workbuddy-checkin

WorkBuddy 每日签到 + 宠物自动探险技能：自动查询签到状态与剩余积分、领取每日签到积分、派出宠物探险并在归来后自动领取积分。纯本地运行、零依赖、无任何推送/通知。

> ⚠️ 非官方项目，个人维护。请遵守 WorkBuddy 平台的使用规则，本项目与 WorkBuddy 官方无关。

## 功能

- 查询 WorkBuddy 签到状态（今日是否已签、连续天数、今日奖励）
- 查询当前剩余积分
- 今日未签则自动领取当日积分；已签则跳过（幂等，重复运行不会重复领取）
- 宠物自动探险：空闲自动派出 → 归来自动领取积分（幂等安全，重复运行无副作用）
- 结果直接输出到控制台，无推送、无通知
- 零依赖（仅用 Node.js 内置模块），自动探测本机环境

## 工作原理

脚本不做界面模拟点击，而是复用 WorkBuddy 桌面版在本机保存的登录态，直接调用其后台接口完成：

1. 读取并解密本机 WorkBuddy 登录态（AES-256-GCM，解密密钥由 WorkBuddy 可执行文件运行时提供）
2. 签到：查询签到状态与剩余积分，今日未签则调用领取接口
3. 宠物探险：查询探险状态（idle / traveling / arrived）→ 空闲且未达每日上限则派出 → 已归来则领取积分

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `scripts/checkin.js` | 每日签到 |
| `scripts/buddy_travel.js` | 宠物自动探险（派出 / 领取） |

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| 操作系统 | Windows |
| WorkBuddy | 桌面版已安装并登录（本机需保存登录态） |
| Node.js | 18+（内置 fetch/crypto） |

## 安装

**方式一：放入技能目录**

将本仓库克隆/下载为文件夹 `workbuddy-checkin`，放入 `C:\Users\<你的用户名>\.workbuddy\skills\` 目录下，重启 WorkBuddy 后即可在技能列表看到。

**方式二：拖拽导入**

将仓库中的 `SKILL.md` 直接拖入 WorkBuddy 对话框导入。

## 使用

在 WorkBuddy 对话中说「WorkBuddy 签到」或「宠物探险」即可触发；也可以手动运行：

```bat
:: 只查询、不领取（签到 / 宠物探险）
node scripts\checkin.js --dry
node scripts\buddy_travel.js --dry

:: 正式签到
node scripts\checkin.js

:: 宠物探险（空闲自动派出，归来自动领取）
node scripts\buddy_travel.js
```

示例输出（数字因账号而异）：

```
## 📅 WorkBuddy 每日签到
> 2026-10-22 09:22:12

- ✅ 今日已签到（无需重复）
- 连续 20 天　｜　今日 100 credits
- 💰 当前剩余积分：7646 credits
```

```
## 🐱 WorkBuddy 宠物自动探险
> 2026-10-22 10:02:21

🐾 已自动派出宠物前往「咖啡馆」，约 4 小时后归来；归来后再次运行本脚本即可自动领取
```

退出码：`0` = 成功（含今日已签/无需动作），`1` = 失败。

## 定时自动化（WorkBuddy「自动化」）

不需要 Windows 计划任务。在 WorkBuddy 左侧边栏打开「自动化」添加任务，频率设为「每天」：

| 任务 | 时间 | 提示词 |
| --- | --- | --- |
| 签到 + 探险 | 每天 08:20 | `运行 workbuddy-checkin 技能：先执行 node scripts/checkin.js 完成每日签到，再执行 node scripts/buddy_travel.js 处理宠物探险，汇报两项结果。` |
| 探险领取/再派出 | 每天 14:00 | `运行 workbuddy-checkin 技能：执行 node scripts/buddy_travel.js 处理宠物探险（归来则领取积分并再次派出），汇报结果。` |

## 配置（config.json）

脚本默认自动探测本机环境，开箱即用，无需配置。

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `requestTimeoutMs` | 接口请求超时（毫秒） | `20000` |
| `workbuddy.enabled` | 是否启用签到 | `true` |
| `workbuddy.appExe` | WorkBuddy.exe 完整路径 | 留空=自动探测（注册表 → %LOCALAPPDATA%） |
| `workbuddy.authFile` | 登录态文件路径 | 留空=`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| `workbuddy.billingBase` | 计费接口域名 | `https://www.codebuddy.cn` |
| `workbuddy.chatBase` | 会话接口域名 | `https://copilot.tencent.com` |
| `travel.autoDepart` | 宠物探险是否自动派出（`false`=仅领取不派出） | `true` |
| `travel.locationId` | 指定探险地点 id（如 `1`=咖啡馆） | 空=取配置第一个 |
| `travel.locationCode` | 或按 code 指定（如 `coffee`） | 空 |

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 找不到 Node.js | 安装 Node.js 18+（https://nodejs.org）后重新运行 |
| 找不到 WorkBuddy.exe | 确认已安装 WorkBuddy 桌面版；特殊安装路径可在 `config.json` 的 `appExe` 填写完整路径 |
| 凭据读取失败 | 确认已在 WorkBuddy 桌面版登录；脚本会自动尝试刷新 token，仍失败请在 App 内重新登录 |
| 余额读不到 | 不影响签到，结果中仅缺余额一行 |
| 探险接口异常 | 多为登录态问题或该账号未开放宠物探险；确认在 WorkBuddy「成长空间」能看到宠物探险入口 |

## 安全说明

- 脚本仅在本机读取登录态并调用官方接口，不上传任何数据、无远程服务器。
- 仓库不包含任何用户级路径或个人信息；运行时生成的 `checkin.log` / `travel.log` 已被 `.gitignore` 忽略，不会进入版本库。

## 许可

[MIT](LICENSE)
