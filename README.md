## 📦安装方法
  1、在 Releases 下载最新的 .mcpb 安装包。
  
  2、打开 Claude Desktop → 设置 → 扩展 → 浏览插件 → 高级设置 → 安装扩展。
  
  3、选择下载的 .mcpb 文件，确认安装。
  
  4、安装完成后，添加Codex数据和缓存配置。然后确认 CCMemories for Claude 已启用。
  
  5、新建一个普通聊天，即可让 Claude 搜索和读取 Codex 会话。

💬例如，直接发送：
> 搜索最近的 Codex 工作会话。

> 读取“CCMemories”工作会话。

> 继续读取这条会话更早的消息。

> <img width="953" height="233" alt="image" src="https://github.com/user-attachments/assets/16fc97bb-26c9-4375-9e6f-1caff30a6880" />

## ⚡️主要功能
| MCP 工具 | 功能说明 |
|---|---|
| `list_work_threads` | 列出本机或远程服务器最近的 Codex 工作会话 |
| `search_work_threads` | 根据标题或关键词搜索本机或远程服务器的工作会话 |
| `search_work_messages` | 搜索本机或远程服务器历史会话中的消息正文 |
| `read_work_thread` | 读取本机或远程服务器的指定会话，支持长消息、分页与历史续读 |
| `list_local_files` | 列出本机或远程服务器允许目录中的文件和文件夹 |
| `search_local_files` | 在本机或远程服务器的允许目录内搜索文件名，可选搜索文本内容 |
| `read_local_file` | 读取本机或远程服务器允许目录内的文本、图片、支持的文档、压缩包及 SQLite 文件，支持分页续读 |
