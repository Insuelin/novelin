# novelin

本地 AI 小说写作终端。参考现代hardness，采取给模型暴露工具阅读长文本内容和生成摘要进行下一章写作的方式来大量节约token并提升指令遵循能力。 Node.js + Express，正文编辑用 CodeMirror 6，数据全部保存在本地。

## 功能

- 按章写作、续写、改写和情节审查
- AI 差异审阅，逐段接受或拒绝
- 章节摘要、前情上下文和用词规则
- 按书资料库和触发词
- KaTeX 数学公式实时预览

## 运行

需要 Node.js 20+。

```bash
npm install
npm start
```

默认地址：http://127.0.0.1:4173

可选环境变量：`HOST`、`PORT`、`DATA_DIR`。

## 模型接入

目前通过 magpie 提供的 OpenAI 兼容接口连接模型：

```bash
MAGPIE_BASE_URL=http://127.0.0.1:3425/v1
MAGPIE_API_KEY=...
```

自建网关还在开发中，完成后会替换这一层。仓库不包含任何模型服务的密钥。

## 数据

书稿、摘要、资料和日志都保存在本地 `data/` 目录

## 状态

早期开发中，接口和数据格式可能变化。
