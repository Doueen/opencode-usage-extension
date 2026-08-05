# Edge 商店提交文案（复制到 Partner Center）

## 短描述（≤ 132 字符）
在工具栏实时查看 OpenCode 订阅配额与 DeepSeek 余额。5 种风格、自定义刷新频率、配额倒计时与角标提醒。

## 长描述（Markdown）
OpenCode Usage Monitor 是一款轻量的浏览器扩展，在工具栏一键查看你的 OpenCode（Zen/Go）订阅配额与 DeepSeek 账户余额。

### 功能
- **Go 订阅配额**：滚动 / 周 / 月三周期使用百分比、进度条与重置倒计时（天/时/分，前端逐秒递减）
- **DeepSeek 余额**：可选启用，显示账户余额（Key 仅保存在本机浏览器）
- **工具栏角标**：图标直接显示所选数值百分比，颜色分级提醒（<50% 绿 / >50% 橙 / >80% 红）
- **5 种界面风格**：终端矩阵 / 玻璃拟态 / 极简记账 / 复古像素 / 赛博朋克
- **自定义刷新频率**：支持任意秒数（≥1s）
- **官网入口**：一键跳转 OpenCode 完整用量明细页

### 使用
1. 点击扩展图标 → ⚙ 设置 → WORKSPACE 填入你的 OpenCode 工作区 ID（在官网 URL 中获取）
2. （可选）设置 → DEEPSEEK 填入 API Key 启用余额显示
3. 完成后主界面实时显示配额与余额

### 隐私
- 数据全部在浏览器本地处理，不上传任何服务器
- 仅申请最小权限（storage / alarms + 两个数据源域名）
- 详见仓库 PRIVACY.md

## 分类
开发工具 (Developer Tools)

## 关键词（Keywords）
opencode, opencode zen, opencode go, quota, usage, token, deepseek, balance, 配额, 用量, 余额

## 权限说明（Permissions justification）
- storage：保存用户设置与缓存数据（仅本地）
- alarms：定时刷新配额与余额数据
- opencode.ai：读取用户自己的配额页面（需已登录）
- api.deepseek.com：查询 DeepSeek 余额（用户自愿配置 Key）
