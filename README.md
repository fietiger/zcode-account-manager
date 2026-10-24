# ZCode 账号管理器

本地 ZCode 多账号管理器。纯本地运行：无代理、无中继、不上传任何数据。

管理多个 ZCode 账号（Z.ai / BigModel 的 Coding Plan、Start Plan、API Key），一键把选定账号切换给客户端使用。参考 [agy-credential-manager](https://github.com/fietiger/agy-credential-manager) 的思路实现：账号集中保管 + 切换时写入客户端真实配置 + 写入后回读校验。

## 功能

- **多账号管理**：添加、编辑、删除账号，列表展示备注名、账号标识、套餐槽位、状态与掩码后的 Key
- **一键导入本机账号**：读取 `~/.zcode/v2/config.json` 里各 provider 槽位当前配置的 Key，一键收进管理器统一管理；按 Key 指纹去重，重复的只跳过不报错，每个槽位的处理结果（已导入 / 已存在 / 未登录）都会显示
- **批量导入**：粘贴 JSON 数组或选择 `.json` 文件。支持 `[{ "email": "...", "apiKey": "..." }]`、只含 Key 的字符串数组，以及本应用自己的导出格式；自动跳过无效条目与重复账号并报告数量
- **一键切换账号**：把账号的 Key 写入 `~/.zcode/v2/config.json` 中对应的 provider 槽位，只保留该槽位 `enabled: true`（其余内置槽位自动关闭），同时把 `setting.json` 的 `providerFamilyDomain` 切到对应阵营（`zai` / `bigmodel`）；写入后**立即回读校验**，Key 指纹不一致就报错而不是假装成功
- **Key 形态自动识别**：粘贴 Key 时自动判断它是 BigModel 的 `id.secret`、套餐 JWT Token 还是 Z.ai 的 opaque Key，并推荐对应的 provider 槽位；JWT 会解出 `user_id` 作为账号标识
- **过期提示**：Key 是 JWT 且带 `exp` 时展示「有效 / 待刷新 / 已过期」，长期 Token 显示「长期有效」
- **客户端运行检测**：ZCode 运行时切换会先拦住（客户端退出时会把内存里的旧配置写回磁盘，覆盖这次切换），可选择强制写入
- **安全网**：每次写入客户端配置前，先把当时的 `config.json` 备份到数据目录的 `backups/`；写入采用临时文件 + 替换，中途失败不会留下截断的配置
- **导出备份**：一键导出全部账号（含完整 Key）为 JSON，便于备份与迁移
- **文件日志**：结构化日志写入数据目录，界面内可直接查看

## 它改的是什么

ZCode 把凭证分两处存放：

| 位置 | 内容 | 本应用 |
| --- | --- | --- |
| `~/.zcode/v2/config.json` → `provider.*.options.apiKey` | 各 provider 槽位实际使用的 Key（明文） | **读写**，切换账号就是换这里 |
| `~/.zcode/v2/setting.json` | 当前 provider 阵营（`zai` / `bigmodel`）与连接方式 | **读写**这两项 |
| `~/.zcode/v2/credentials.json` | OAuth 登录态，值形如 `enc:v1:...`，由 Electron 用 DPAPI 加密 | **只读不写**，也解不开 |

也就是说，本工具管理的是「**哪个账号的额度被消耗**」这一层——决定请求计费的 provider apiKey。OAuth 登录态（`credentials.json`）不属于本工具的处理范围，也不会被破坏。

## 使用

### 直接下载可执行文件

从 [Releases](../../releases) 下载对应平台的文件，双击运行，浏览器会自动打开 `http://127.0.0.1:7777/`。

- Windows：`zcode-account-manager-win-x64.exe`
- macOS：`zcode-account-manager-macos-arm64`（首次运行如被拦截：`xattr -d com.apple.quarantine <文件>`）
- Linux：`zcode-account-manager-linux-x64`（`chmod +x` 后运行）

服务只监听 `127.0.0.1`，不对外暴露。

### 从源码运行

```bash
npm start          # 需要 Node.js >= 18
```

或 Windows 双击 `start.bat`。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `ZCAM_PORT` | 监听端口，默认 `7777`（被占用时自动 +1 重试） |
| `ZCAM_NO_OPEN` | 设为 `1` 时不自动打开浏览器 |
| `ZCODE_HOME` | ZCode 数据目录，默认 `~/.zcode` |
| `ZCAM_HOME` | 本应用数据目录，默认见下表 |
| `ZCAM_LOG_DEBUG` | 设为 `1` 输出 debug 级日志 |

## 数据存储

本应用的数据只存在本机应用数据目录下的 `zcode-account-manager/`：

| 内容 | 文件 |
| --- | --- |
| 账号索引（不含明文 Key） | `accounts.json` |
| 单个账号凭证 | `accounts/<id>.json` |
| 客户端配置备份 | `backups/config-<时间戳>.json` |
| 日志 | `logs/app.log` |

各平台应用数据目录：

- Windows：`%APPDATA%\zcode-account-manager\`
- macOS：`~/Library/Application Support/zcode-account-manager/`
- Linux：`~/.local/share/zcode-account-manager/`

> ⚠️ 账号 Key 以明文 JSON 保存在本地，请注意本机账户与磁盘安全；导出的备份包含完整 Key，不要分享给他人。

## 构建

```bash
npm install
npm run build        # 为当前平台产出 dist/zcode-account-manager-<平台>-<架构>
npm run build -- --all   # 产出全部目标（win-x64 / macos-x64 / macos-arm64 / linux-x64）
```

打包使用 [@yao-pkg/pkg](https://github.com/yao-pkg/pkg)，把 Node 运行时、后端与 `ui/` 静态资源一起塞进单个可执行文件。

GitHub Actions（`.github/workflows/build.yml`）会在 push 时跑单元测试并构建三平台产物；打 `v*` tag 时自动发布 Release。每个平台构建完都会启动产物做一次冒烟测试（检查 `/api/status` 与首页能否正常返回），确保打包进去的 UI 资源没有丢。

## 开发

```bash
npm test             # 单元测试（跑在临时 ZCODE_HOME 里，不碰真实配置）
npm start            # 本地起服务
```

测试覆盖 Key 形态识别、指纹去重、账号增删改、批量导入报告、切换写入（含互斥关闭其它槽位）、槽位缺失时从同阵营兄弟槽位克隆、回读校验、原子写入。

## 项目结构

```
ui/index.html          单页前端（无构建步骤，原生 JS）
server/
  index.js             HTTP 服务与路由
  api.js               REST 接口（账号、切换、导入、导出、日志）
  store.js             账号存储（索引 + 单账号文件）
  zcode.js             客户端配置读写、切换与回读校验
  presets.js           内置 provider 槽位定义
  token.js             Key 形态识别 / JWT 解析 / 掩码 / 指纹
  paths.js             跨平台路径解析
  logger.js            文件日志
scripts/build.js       打包脚本
test/run.test.js       单元测试
```

## 许可证

MIT
