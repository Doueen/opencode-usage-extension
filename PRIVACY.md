# 隐私政策 (Privacy Policy)

**OpenCode Usage Monitor**（下称"本扩展"）由 doueen 开发并维护。

本政策最后更新日期：2026-08-05

## 1. 数据收集

本扩展**不收集、不上传任何个人数据**。所有数据均在您的浏览器本地处理。

| 数据类型 | 是否收集 | 存储位置 | 用途 |
|---|---|---|---|
| OpenCode 工作区 ID | 是（您手动填写） | 本机浏览器 `chrome.storage.local` | 构造官网配额查询地址 |
| DeepSeek API Key（可选） | 是（您自愿填写） | 本机浏览器 `chrome.storage.local` | 调用 DeepSeek 官方余额接口 |
| OpenCode 配额数据 | 是 | 本机浏览器 `chrome.storage.local` | 在扩展界面展示 |
| DeepSeek 余额数据 | 是 | 本机浏览器 `chrome.storage.local` | 在扩展界面展示 |
| 界面偏好（主题/频率/角标） | 是 | 本机浏览器 `chrome.storage.local` | 记住您的设置 |
| 浏览历史 / Cookie（第三方） | **否** | — | — |
| 个人身份信息（姓名/邮箱等） | **否** | — | — |
| 位置信息 | **否** | — | — |

## 2. 数据使用

- **OpenCode 配额**：扩展在您已登录 opencode.ai 的浏览器环境中，访问您的 workspace 页面以读取 SSR 数据。这等同于您自己在浏览器打开该页面，**不涉及任何第三方服务器中转**。
- **DeepSeek 余额**：扩展使用您填写的 API Key 直接调用 DeepSeek 官方接口 `api.deepseek.com/user/balance`。请求由您的浏览器直接发出，**不经任何中间服务器**。

## 3. 数据共享

本扩展**不与任何第三方共享数据**，包括但不限于：广告商、数据分析商、母公司/关联公司。

## 4. 数据存储与安全

- 所有数据仅存在于您的浏览器 `chrome.storage.local`（本机存储）。
- 卸载扩展时，浏览器会自动清除扩展数据。
- 建议妥善保管您的 DeepSeek API Key；本扩展无法阻止他人物理访问您电脑时读取本地存储。

## 5. 权限说明

本扩展申请的最小权限及其用途：

| 权限 | 用途 |
|---|---|
| `storage` | 保存您的设置与缓存数据（仅本地） |
| `alarms` | 定时刷新配额/余额数据 |
| `host_permissions: opencode.ai` | 读取您的 OpenCode 配额页面 |
| `host_permissions: api.deepseek.com` | 查询 DeepSeek 余额 |

## 6. 儿童隐私

本扩展不面向 13 岁以下儿童，也不收集儿童个人信息。

## 7. 政策变更

如本政策发生变更，将在本页面更新并标注日期。

## 8. 联系我们

如有隐私相关问题，请通过 GitHub Issues 联系我们：
https://github.com/Doueen/opencode-usage-extension/issues
