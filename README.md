<div align="center">
  <img src="./logo.png" alt="CF AI Chat Hub Logo" width="160">
  <h1>⚡ CF-AIChat</h1>
  <p>基于 Cloudflare Workers 的高性能、零成本多模型 AI 聊天终端</p>

  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/CF-Works/CF-AIChat">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
  </a>

  <br />
  <br />

  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare_Workers-orange.svg)](https://workers.cloudflare.com/)
  [![GitHub Stars](https://img.shields.io/github/stars/CF-Works/CF-AIChat?style=flat-square)](https://github.com/CF-Works/CF-AIChat/stargazers)
</div>

---

## ✨ 项目特色

-   **🚀 一键部署**：点击上方按钮，30 秒内完成全球边缘节点部署。
-   **🤖 全模型支持**：完美适配 Llama 3.3, DeepSeek R1, Qwen 2.5 等 60+ 官方模型。
-   **🎨 极致体验**：支持流式输出 (SSE)、多模态图片理解、以及专用的翻译面板。
-   **🔐 安全保障**：集成自定义密码登录与 Token 鉴权机制。
-   **📊 额度监控**：直接在 UI 界面查看 Neurons 消耗统计。

## 🛠️ 部署指南

### 方案 A：一键部署（推荐）
只需点击页面上方的 **[Deploy to Cloudflare Workers]** 按钮，按照提示授权 GitHub 和 Cloudflare 即可自动完成。

### 方案 B：手动部署
1. 克隆仓库：`git clone https://github.com/CF-Works/CF-AIChat.git`
2. 安装依赖并登录：`npm install && npx wrangler login`
3. 部署：`npx wrangler deploy`

> **重要提示**：部署完成后，请在 Cloudflare 控制台的 **Workers & Pages -> Settings -> Variables** 中添加 `ADMIN_PASSWORD` (登录密码) 环境变量。

## ⚙️ 配置参数

| 变量名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | **必填** | 登录聊天界面的唯一密码 |
| `CF_ACCOUNT_ID` | 可选 | 用于查询额度消耗的账户 ID |
| `CF_API_TOKEN` | 可选 | 需具备 `Workers AI: Read` 权限的 API 令牌 |

## 🤝 贡献
欢迎提交 Issue 或 Pull Request 来完善这个项目！

## 📄 开源协议
基于 [MIT License](LICENSE) 开源。
