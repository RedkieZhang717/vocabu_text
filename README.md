# 多功能单词本

**在 Zotero 中，把论文阅读、生词积累和复习连起来。**

小图标划词浮窗、下拉批量选词、连续词组收录、可选翻译、原文定位、闪卡背词，以及按文献整理的阅读状态与笔记。

[下载安装包](https://github.com/RedkieZhang717/vocabu_text/releases/latest/download/zotero-vocab-book.xpi) · [完整使用教程](docs/USER_GUIDE.md) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/RedkieZhang717/vocabu_text/issues)

## 能做什么

| 场景 | 功能 |
| --- | --- |
| 阅读时遇到生词 | 收录单词或短语；划选整句后，点选其中多个词分别加入单词本 |
| 想保留上下文 | 保存原句、来源文献与页码；有位置信息时可回到原词并临时高亮 |
| 翻译不准确 | 手动修改释义；人工修改不会被后续机器查询覆盖 |
| 想专心背词 | 按当前文献或全部生词复习，使用熟练度筛选、闪卡和 Anki 导出 |
| 整理阅读进度 | 卡片查看当前文献列表，标记已读／未读，筛选阅读状态 |
| 记录阅读想法 | 按文献保存笔记，默认收起；每篇文献可展开自己的生词卡片 |

阅读管理支持浅色／深色主题，宽窗口双列、窄窗口单列；长选区和较多生词可滚动查看。

## 安装与更新

1. 下载最新的 [zotero-vocab-book.xpi](https://github.com/RedkieZhang717/vocabu_text/releases/latest/download/zotero-vocab-book.xpi)，**不要下载 Source code 压缩包**。
2. 打开 Zotero 的 **工具 → 插件**，点击齿轮 → **从文件安装插件**，选择下载的 XPI。也可以将 XPI 拖入插件管理窗口，参见 [Zotero 官方安装说明](https://www.zotero.org/support/plugins)。
3. 安装后可在插件列表看到 **多功能单词本**。若名称或界面没有刷新，重启 Zotero。
4. 打开一篇 PDF，在右侧栏使用 **多功能单词本**；文献列表上方的书本图标打开 **阅读管理**。

从旧版 **Zotero Vocab Book Pro** 升级可直接覆盖安装，已有生词、阅读记录和设置继续沿用。安装包文件名保持不变。插件已配置 GitHub 自动更新地址，也可以下载最新 XPI 手动升级。

**兼容性：**清单声明支持 Zotero 7–10；目前已在 Windows 的 Zotero 10.0.6 实测，其他系统和版本尚未逐一验证。

## 三步开始使用

1. **选择使用方式。** 在 Zotero 的 **设置 → 多功能单词本** 配置翻译；如果只想收词，关闭“选中文字后自动翻译”，不必填写百度密钥。
2. **收录与复习。** 在 PDF 中划词，展开翻译图标旁的下拉面板，在“单词”模式点选后加入；“词组”模式可连续点选或编辑整组保存。右侧栏默认显示当前文献，点击“闪卡背词”开始复习。
3. **整理文献。** 点击主窗口工具栏的书本图标，在阅读卡片上标记已读、展开生词或点击“写笔记”。

详细步骤与常见问题见 **[完整使用教程](docs/USER_GUIDE.md)**。

## 翻译设置

设置与使用介绍入口：**Zotero 设置 → 多功能单词本**。右侧单词本仅保留学习功能。

| 设置项 | 用途 |
| --- | --- |
| 百度 APP ID、密钥 | 填写自己在 [百度翻译开放平台](https://fanyi-api.baidu.com/) 获取的通用翻译服务凭据，点击“保存并测试连接”验证 |
| 启用 PDF 划词弹窗 | 控制选择文字后是否出现插件浮窗 |
| 选中文字后自动翻译 | 关闭后，划选不会立即查询；点击小翻译图标或收录单词／词组时再主动查询 |
| 使用有道词典补充音标和释义 | 控制查词时是否补充词典信息；发音按钮可单独使用 |

开关立即生效。点击收录会主动获取词义；没有百度配置时可由启用的有道词典补充，查询失败则保存为“待补充释义”，可在单词本点击“补查释义”或手动修改。词组支持先手填释义再收录，跳过该词组查询。百度服务的开通、额度与费用以其平台说明为准。

## 数据与隐私

- 生词、阅读状态、笔记和翻译配置保存在本机 Zotero 配置中，不上传到本项目的 GitHub 仓库。
- 阅读管理中的笔记和已读标记是插件自己的本地记录，目前不通过 Zotero 库同步，也不会写入文献字段或创建 Zotero 原生笔记。
- 主动翻译或开启自动翻译时，查询文字会发送给百度；启用词典查询或点击发音时，对应词语会发送给有道。
- 安装包不包含预设密钥。反馈问题时，请隐藏 APP ID、密钥及不希望公开的文献和笔记内容。
- 未保存的笔记草稿只在当前窗口内保留，关闭窗口前请保存。Anki 导出用于复习，不是完整数据备份。

## 开发与构建

需要 Node.js 24、Python 3 和 Git。在项目目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
python build-xpi.py
```

输出 `zotero-vocab-book.xpi` 和 `update.json`。Windows 也可以运行 `./build-xpi.ps1`。

| 文件 | 用途 |
| --- | --- |
| `bootstrap.js` | 划词、收录、定位、侧栏和闪卡 |
| `reading-dashboard.js` / `reading-dashboard.css` | 阅读管理、笔记和生词卡片 |
| `preferences.xhtml` / `preferences.js` / `preferences.css` | 设置页面 |
| `manifest.json` | 插件名称、版本、兼容性与更新地址 |
| `tests/` | 行为回归测试 |

GitHub Actions 在 `main` 更新时测试并构建；版本尚未发布时自动创建 Release，上传 XPI 与更新清单。发布前同步修改 `manifest.json`、`package.json` 和 `package-lock.json` 的版本。已发布版本不会覆盖。

显示名称已改为“多功能单词本”；为兼容旧版本，插件 ID `vocab-book@custom.zotero.org`、配置键 `extensions.vocabbook.*`、仓库地址和安装包文件名保持稳定。

## 反馈与社区收录

联系邮箱：**ivydeldago@163.com**（插件设置页也可查看）。

遇到问题请 [提交 Issue](https://github.com/RedkieZhang717/vocabu_text/issues)，说明 Zotero 版本、系统、插件版本、复现步骤及预期结果。可附隐藏私人信息后的截图。

社区市场申请与进度入口见 [收录说明](docs/marketplace-submission.md)。
