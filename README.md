# Zotero Vocab Book Pro

在 Zotero 阅读论文时收录生词、保存原句与页码，并使用熟练度分级和闪卡复习。

## 安装

从本仓库 Releases 下载 `zotero-vocab-book.xpi`。在 Zotero 的“工具 → 插件”中，点击齿轮，选择“从文件安装插件”。更新后建议重启 Zotero，以刷新语言资源。

当前已在 Windows 的 Zotero 10.0.6 上调试；清单声明支持 Zotero 7–10，其他版本尚未逐一实测。

## 使用

- 在 PDF 中划选单词或短语，点击“加入生词本”。
- 划选句子后点选多个词，分别收录，保留同一原句、译文和 PDF 页码。连字符词和缩写不会拆散；失败的词保留选中，可重试。
- 在右侧生词本中搜索、筛选当前文献、切换熟练度和排序。
- 点击“闪卡背词”回忆释义，翻面后评分；点击页码返回原文。
- “导出 Anki”将两列 TSV 复制到剪贴板。导入 Anki 时允许 HTML。

## 翻译与数据

在 Zotero“设置 → 生词本”填写百度 APP ID 和密钥，点击“保存并测试连接”。侧栏齿轮也可打开设置。旧版 `APPID#密钥` 会自动沿用；可在此关闭划词弹窗或词典查询。词典释义与发音使用有道服务。查询内容会发送给对应服务；生词列表和翻译密钥保存在本机 Zotero 配置中，不上传至本仓库。公开源码和安装包不含预设密钥。

保留原插件 ID `vocab-book@custom.zotero.org` 及 `extensions.vocabbook.*` 配置键，升级不会主动清空已有生词。

## 开发与发布

```sh
npm ci
npm test
python build-xpi.py
```

Windows 也可以运行 `./build-xpi.ps1`。构建只打包明确列出的运行文件，不包含测试、调试记录和本机数据。

GitHub Actions 在 main 分支推送时运行测试并构建 XPI；版本尚未发布时自动创建对应 tag 和 Release，上传 XPI 与 update.json。已发布的版本不被覆盖。也可手动运行工作流。发布新版本前同步修改 manifest.json、package.json 和 package-lock.json 的版本。

本地旧版使用的更新地址为占位地址，需要手动安装一次本仓库的版本，之后才会使用新的更新地址。
