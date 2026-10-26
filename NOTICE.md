# 来源与变更声明

- 上游项目：Duplicate Tabs Closer。
- 上游作者：Peuj 及贡献者。
- 上游地址：https://github.com/Peuj/duplicate-tabs-closer
- 分支基线：`f25bd76929aefa07ca3d187e708ad6b997696ee6`，上游扩展版本 4.3.6。
- 本分支：trace7-ai/tab-return-lite，“回到已打开”。
- 变更日期：2026-10-27。
- 许可证：继续使用仓库根目录的 GNU GPL v3，保留上游许可证原文和 Git 历史。

本次改动：针对 Chrome 重新编写简化的事件处理、完整 URL 去重、中文弹窗及测试；保留并搬移上游 16/32/128 像素图标；移除其他语言、主题、图标字体、复杂匹配规则及多浏览器兼容代码。无运行时第三方依赖。

上游 package.json 的 license 字段与实际 LICENSE 文件不一致，本分支以保留的 GPL v3 LICENSE 文件为准，并将元数据统一为 GPL-3.0-only。
