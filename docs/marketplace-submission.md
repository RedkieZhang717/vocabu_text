# 插件市场收录申请

截至 2026-10-15，Zotero 官方文档仍说明官方插件目录正在规划中，没有官方商店上传入口。

- 官方说明：https://www.zotero.org/support/plugins
- 中文社区插件市场：https://plugins.zotero-chinese.com/
- 当前收录源：https://github.com/syt2/zotero-addons-scraper#contributing

## 可提交的收录变更

目标仓库：`syt2/zotero-addons-scraper`，目标分支：`master`。

新增文件：`addons/RedkieZhang717@vocabu_text`

内容（不带代码围栏）：

```json
{"tags":["reader","notes"]}
```

PR 标题：`Add Zotero Vocab Book Pro`

PR 正文：

> Add Zotero Vocab Book Pro, a Zotero reading and vocabulary plugin.
>
> Repository: https://github.com/RedkieZhang717/vocabu_text
>
> Releases: https://github.com/RedkieZhang717/vocabu_text/releases/latest
>
> Features: vocabulary collection from PDF selections, per-paper vocabulary, source-position navigation, editable definitions, flashcard review, and a reading dashboard with read status and notes. Translation is optional and uses the user's own Baidu credentials.
>
> Tags: reader, notes.

仓库已经公开，Releases 提供 XPI，manifest.json 提供固定插件 ID、主页与自动更新地址。目录维护者合并且抓取更新后，才算正式收录；GitHub Release 发布本身不等于进入插件市场。

已于 2026-10-15 使用 `RedkieZhang717` 账号提交收录申请：[syt2/zotero-addons-scraper#273](https://github.com/syt2/zotero-addons-scraper/pull/273)。

申请当前为公开、非草稿 PR，等待目录维护者审阅。维护者合并并完成目录抓取后才算正式收录。
