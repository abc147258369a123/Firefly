import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const postsDir = path.join(rootDir, "src", "content", "posts");
const port = Number(process.env.FIREFLY_EDITOR_PORT || process.env.PORT || 8789);
const execFile = promisify(execFileCallback);

const fields = [
	"title",
	"published",
	"updated",
	"description",
	"image",
	"tags",
	"category",
	"draft",
	"lang",
	"pinned",
	"author",
	"sourceLink",
	"licenseName",
	"licenseUrl",
	"comment",
	"password",
	"passwordHint",
];

function today() {
	return new Date().toISOString().slice(0, 10);
}

function sendJson(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
	});
	res.end(body);
}

function sendHtml(res, html) {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"access-control-allow-origin": "*",
	});
	res.end(html);
}

function isMarkdownFile(filePath) {
	return /\.(md|mdx)$/i.test(filePath);
}

function normalizePostPath(rawPath) {
	if (typeof rawPath !== "string" || rawPath.trim() === "") {
		throw new Error("文章路径不能为空。");
	}

	const normalized = rawPath.replaceAll("\\", "/").replace(/^\/+/, "");
	if (normalized.includes("\0")) {
		throw new Error("文章路径不合法。");
	}
	if (!isMarkdownFile(normalized)) {
		throw new Error("文章路径必须以 .md 或 .mdx 结尾。");
	}

	const fullPath = path.resolve(postsDir, normalized);
	const relative = path.relative(postsDir, fullPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("文章路径必须位于 src/content/posts 内。");
	}

	return {
		relative: relative.replaceAll(path.sep, "/"),
		fullPath,
	};
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
		if (Buffer.concat(chunks).length > 10 * 1024 * 1024) {
			throw new Error("请求内容过大。");
		}
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}

async function walkPosts(dir = postsDir, base = "") {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relative = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await walkPosts(fullPath, relative)));
		} else if (entry.isFile() && isMarkdownFile(entry.name)) {
			const raw = await fs.readFile(fullPath, "utf8");
			const { frontmatter, body } = parseMarkdown(raw);
			const stat = await fs.stat(fullPath);
			files.push({
				path: relative,
				title: String(frontmatter.title || relative),
				published: normalizeDate(frontmatter.published || ""),
				updated: normalizeDate(frontmatter.updated || ""),
				category: String(frontmatter.category || ""),
				tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
				draft: Boolean(frontmatter.draft),
				pinned: Boolean(frontmatter.pinned),
				words: body.trim() ? body.trim().split(/\s+/).length : 0,
				modified: stat.mtime.toISOString(),
			});
		}
	}

	return files.sort((a, b) => {
		if (a.draft !== b.draft) return Number(b.draft) - Number(a.draft);
		return (b.published || "").localeCompare(a.published || "");
	});
}

function parseMarkdown(raw) {
	if (!raw.startsWith("---")) {
		return { frontmatter: {}, body: raw };
	}

	const endIndex = raw.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: raw };
	}

	const yaml = raw.slice(3, endIndex).replace(/^\r?\n/, "");
	const body = raw.slice(endIndex).replace(/^\r?\n---\r?\n?/, "");
	return {
		frontmatter: parseFrontmatter(yaml),
		body,
	};
}

function parseFrontmatter(yaml) {
	const data = {};
	let currentKey = "";

	for (const rawLine of yaml.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim() || line.trimStart().startsWith("#")) continue;

		const listItem = line.match(/^\s*-\s+(.*)$/);
		if (listItem && currentKey) {
			if (!Array.isArray(data[currentKey])) data[currentKey] = [];
			data[currentKey].push(parseScalar(listItem[1]));
			continue;
		}

		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;

		const [, key, value] = match;
		currentKey = key;
		data[key] = value === "" ? "" : parseScalar(value);
	}

	return data;
}

function parseScalar(value) {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	if (trimmed === "[]") return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((item) => parseScalar(item.trim()))
			.filter((item) => item !== "");
	}
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("''", "'");
	}
	return trimmed;
}

function normalizeDate(value) {
	if (!value) return "";
	return String(value).slice(0, 10);
}

function normalizeFrontmatter(input = {}) {
	return {
		title: String(input.title || "未命名文章").trim(),
		published: normalizeDate(input.published || today()),
		updated: normalizeDate(input.updated || ""),
		description: String(input.description || ""),
		image: String(input.image || ""),
		tags: normalizeTags(input.tags),
		category: String(input.category || ""),
		draft: Boolean(input.draft),
		lang: String(input.lang || ""),
		pinned: Boolean(input.pinned),
		author: String(input.author || ""),
		sourceLink: String(input.sourceLink || ""),
		licenseName: String(input.licenseName || ""),
		licenseUrl: String(input.licenseUrl || ""),
		comment: input.comment === undefined ? true : Boolean(input.comment),
		password: String(input.password || ""),
		passwordHint: String(input.passwordHint || ""),
	};
}

function normalizeTags(tags) {
	if (Array.isArray(tags)) {
		return tags.map((tag) => String(tag).trim()).filter(Boolean);
	}
	return String(tags || "")
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function formatMarkdown(frontmatterInput, bodyInput) {
	const data = normalizeFrontmatter(frontmatterInput);
	const yaml = fields
		.map((field) => {
			const value = data[field];
			if (Array.isArray(value)) return `${field}: [${value.map(quoteYaml).join(", ")}]`;
			if (typeof value === "boolean") return `${field}: ${value}`;
			if (!value && !["title", "published"].includes(field)) return "";
			return `${field}: ${quoteYaml(value)}`;
		})
		.filter(Boolean)
		.join("\n");

	const body = String(bodyInput || "").replace(/^\s+/, "");
	return `---\n${yaml}\n---\n\n${body}`;
}

function quoteYaml(value) {
	const text = String(value);
	if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return text;
	if (text === "") return "''";
	if (/^[A-Za-z0-9_./:-]+$/.test(text) && !["true", "false", "null"].includes(text)) return text;
	return JSON.stringify(text);
}

async function runGit(args) {
	try {
		const { stdout, stderr } = await execFile("git", args, {
			cwd: rootDir,
			windowsHide: true,
		});
		return { stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error) {
		const message = error.stderr?.trim() || error.stdout?.trim() || error.message || "Git 命令执行失败。";
		throw new Error(message);
	}
}

function buildCommitMessage(postPath, title) {
	const fallback = path.basename(postPath, path.extname(postPath));
	const subject = String(title || fallback).trim().replace(/\s+/g, " ").slice(0, 60) || fallback;
	return `publish: ${subject}`;
}

async function getAheadCount(branch) {
	try {
		await runGit(["fetch", "origin", branch]);
		const counts = await runGit(["rev-list", "--left-right", "--count", `origin/${branch}...${branch}`]);
		const parts = counts.stdout.split(/\s+/).map((item) => Number(item));
		return Number.isFinite(parts[1]) ? parts[1] : 0;
	} catch {
		return 0;
	}
}

async function publishPost(postPath, title) {
	const target = normalizePostPath(postPath);
	const repoRelativePath = path.relative(rootDir, target.fullPath).replaceAll(path.sep, "/");
	if (!fsSync.existsSync(target.fullPath)) {
		throw new Error("当前文章文件不存在，先保存后再上传。");
	}

	const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "main";
	await runGit(["add", "--", repoRelativePath]);

	const staged = await runGit(["diff", "--cached", "--name-only", "--", repoRelativePath]);
	let commitMessage = "";
	if (staged.stdout) {
		commitMessage = buildCommitMessage(target.relative, title);
		await runGit(["commit", "-m", commitMessage, "--", repoRelativePath]);
	}

	const aheadCount = await getAheadCount(branch);
	if (aheadCount <= 0) {
		throw new Error("当前文章没有新的已保存修改可上传。");
	}

	await runGit(["push", "origin", branch]);
	const remainingAheadCount = await getAheadCount(branch);
	if (remainingAheadCount > 0) {
		throw new Error(`GitHub 还差 ${remainingAheadCount} 个本地提交没有收到，请重试上传。`);
	}

	return {
		path: target.relative,
		branch,
		commitMessage,
		pushedCommits: aheadCount,
	};
}

async function handleApi(req, res, url) {
	try {
		if (req.method === "GET" && url.pathname === "/api/posts") {
			return sendJson(res, 200, { posts: await walkPosts() });
		}

		if (req.method === "GET" && url.pathname === "/api/post") {
			const postPath = url.searchParams.get("path") || "";
			const target = normalizePostPath(postPath);
			const raw = await fs.readFile(target.fullPath, "utf8");
			const { frontmatter, body } = parseMarkdown(raw);
			return sendJson(res, 200, {
				path: target.relative,
				frontmatter: normalizeFrontmatter(frontmatter),
				body,
			});
		}

		if (req.method === "POST" && url.pathname === "/api/post") {
			const payload = await readBody(req);
			const target = normalizePostPath(payload.path);
			const oldPath = payload.oldPath ? normalizePostPath(payload.oldPath) : null;
			const content = formatMarkdown(payload.frontmatter, payload.body);

			await fs.mkdir(path.dirname(target.fullPath), { recursive: true });
			if (oldPath && oldPath.relative !== target.relative && fsSync.existsSync(oldPath.fullPath)) {
				if (fsSync.existsSync(target.fullPath)) {
					throw new Error("目标路径已存在，不能覆盖另一个文件。");
				}
				await fs.rename(oldPath.fullPath, target.fullPath);
			}
			await fs.writeFile(target.fullPath, content, "utf8");

			return sendJson(res, 200, { ok: true, path: target.relative });
		}

		if (req.method === "POST" && url.pathname === "/api/delete") {
			const payload = await readBody(req);
			const target = normalizePostPath(payload.path);
			await fs.unlink(target.fullPath);
			return sendJson(res, 200, { ok: true });
		}

		if (req.method === "POST" && url.pathname === "/api/publish") {
			const payload = await readBody(req);
			const result = await publishPost(payload.path, payload.title);
			return sendJson(res, 200, { ok: true, ...result });
		}

		return sendJson(res, 404, { error: "接口不存在。" });
	} catch (error) {
		return sendJson(res, 400, { error: error.message || "请求失败。" });
	}
}

const appHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Firefly 博客编辑器</title>
	<style>
		:root {
			color-scheme: light;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			--bg: #f7f8fa;
			--sidebar: #fbfcfd;
			--panel: #ffffff;
			--panel-2: #fbfffd;
			--text: #262626;
			--muted: #8a8f99;
			--subtle: #f2f4f7;
			--line: #e6e8eb;
			--accent: #00b96b;
			--accent-hover: #00a861;
			--accent-soft: #e8f8f0;
			--danger: #d14343;
			--ok: #178f57;
			--shadow: 0 10px 28px rgba(31, 35, 41, 0.06);
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100vh;
			background: var(--bg);
			color: var(--text);
		}
		button, input, textarea, select {
			font: inherit;
		}
		button {
			border: 1px solid var(--line);
			background: #fff;
			color: var(--text);
			border-radius: 8px;
			min-height: 34px;
			padding: 0 14px;
			cursor: pointer;
			transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
		}
		button:hover {
			background: var(--subtle);
		}
		button.primary {
			background: var(--accent);
			border-color: var(--accent);
			color: #fff;
		}
		button.primary:hover {
			background: var(--accent-hover);
			border-color: var(--accent-hover);
		}
		button.danger {
			color: var(--danger);
		}
		button.icon {
			width: 34px;
			padding: 0;
		}
		input, textarea {
			width: 100%;
			border: 1px solid var(--line);
			border-radius: 8px;
			background: #fff;
			color: var(--text);
			padding: 8px 10px;
			outline: none;
		}
		input:focus, textarea:focus {
			border-color: var(--accent);
			box-shadow: 0 0 0 3px rgba(0, 185, 107, 0.12);
		}
		label {
			display: grid;
			gap: 6px;
			font-size: 12px;
			color: var(--muted);
		}
		.shell {
			display: grid;
			grid-template-columns: minmax(280px, 328px) minmax(0, 1fr);
			min-height: 100vh;
		}
		.sidebar {
			border-right: 1px solid var(--line);
			background: var(--sidebar);
			display: grid;
			grid-template-rows: auto auto minmax(0, 1fr);
		}
		.brand {
			padding: 18px 20px 16px;
			border-bottom: 1px solid var(--line);
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
		}
		.brand h1 {
			font-size: 17px;
			line-height: 1.2;
			margin: 0;
			font-weight: 700;
		}
		.brand p {
			margin: 4px 0 0;
			color: var(--muted);
			font-size: 12px;
		}
		.search {
			padding: 14px 16px;
			border-bottom: 1px solid var(--line);
		}
		.search input {
			background: var(--subtle);
			border-color: transparent;
		}
		.post-list {
			overflow: auto;
			padding: 10px 8px;
		}
		.post-item {
			width: 100%;
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 6px 10px;
			text-align: left;
			border: 1px solid transparent;
			background: transparent;
			border-radius: 8px;
			padding: 11px 12px;
			min-height: 66px;
			position: relative;
		}
		.post-item:hover {
			background: var(--subtle);
		}
		.post-item.active {
			background: #fff;
			border-color: #d8f1e5;
			box-shadow: var(--shadow);
		}
		.post-item.active::before {
			content: "";
			position: absolute;
			left: 0;
			top: 12px;
			bottom: 12px;
			width: 3px;
			border-radius: 3px;
			background: var(--accent);
		}
		.post-title {
			font-weight: 700;
			font-size: 14px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.post-meta {
			grid-column: 1 / -1;
			color: var(--muted);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.badge {
			align-self: start;
			font-size: 11px;
			color: var(--danger);
			background: #fff0f0;
			border-radius: 4px;
			padding: 1px 6px;
		}
		.editor {
			min-width: 0;
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
		}
		.toolbar {
			position: sticky;
			top: 0;
			z-index: 1;
			background: rgba(255, 255, 255, 0.92);
			backdrop-filter: blur(16px);
			border-bottom: 1px solid var(--line);
			padding: 13px 24px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
		}
		.status {
			font-size: 13px;
			color: var(--muted);
		}
		.status.ok {
			color: var(--ok);
		}
		.actions {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: wrap;
			justify-content: flex-end;
		}
		.form {
			overflow: auto;
			padding: 22px 24px 28px;
		}
		.form-grid {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 13px 14px;
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 10px;
			box-shadow: 0 1px 2px rgba(31, 35, 41, 0.03);
			padding: 16px;
		}
		.span-2 { grid-column: span 2; }
		.span-4 { grid-column: span 4; }
		.toggles {
			display: flex;
			gap: 14px;
			align-items: center;
			flex-wrap: wrap;
			padding-top: 22px;
		}
		.check {
			display: inline-flex;
			grid-auto-flow: column;
			gap: 7px;
			align-items: center;
			color: var(--text);
			font-size: 14px;
		}
		.check input {
			width: 16px;
			height: 16px;
		}
		.writer {
			margin-top: 16px;
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 16px;
			min-height: 560px;
		}
		.body-wrap, .preview-wrap {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 10px;
			box-shadow: 0 1px 2px rgba(31, 35, 41, 0.03);
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			min-width: 0;
		}
		.panel-title {
			padding: 12px 16px;
			border-bottom: 1px solid var(--line);
			font-weight: 700;
			font-size: 13px;
			color: var(--muted);
		}
		#body {
			border: 0;
			border-radius: 0 0 10px 10px;
			resize: none;
			min-height: 520px;
			line-height: 1.76;
			font-family: "JetBrains Mono", Consolas, monospace;
			font-size: 14px;
			padding: 18px;
		}
		.preview {
			overflow: auto;
			padding: 22px 26px;
			line-height: 1.72;
			background: var(--panel-2);
			border-radius: 0 0 10px 10px;
		}
		.preview h1, .preview h2, .preview h3 {
			line-height: 1.3;
			color: #1f2329;
		}
		.preview code {
			background: rgba(0,0,0,0.07);
			padding: 2px 5px;
			border-radius: 4px;
		}
		.preview pre {
			overflow: auto;
			background: #202428;
			color: #f8f8f2;
			padding: 12px;
			border-radius: 6px;
		}
		.preview blockquote {
			border-left: 4px solid var(--accent);
			margin-left: 0;
			padding-left: 12px;
			color: var(--muted);
		}
		.empty {
			display: grid;
			place-items: center;
			color: var(--muted);
			min-height: 100%;
			padding: 24px;
			text-align: center;
		}
		@media (max-width: 980px) {
			.shell { grid-template-columns: 1fr; }
			.sidebar {
				max-height: 42vh;
				border-right: 0;
				border-bottom: 1px solid var(--line);
			}
			.form-grid { grid-template-columns: 1fr 1fr; }
			.span-4 { grid-column: span 2; }
			.writer { grid-template-columns: 1fr; }
		}
		@media (max-width: 620px) {
			.toolbar {
				align-items: stretch;
				flex-direction: column;
			}
			.actions {
				justify-content: stretch;
			}
			.actions button {
				flex: 1;
			}
			.form-grid { grid-template-columns: 1fr; }
			.span-2, .span-4 { grid-column: span 1; }
		}
	</style>
</head>
<body>
	<div class="shell">
		<aside class="sidebar">
			<header class="brand">
				<div>
					<h1>知识库</h1>
					<p>Firefly 本地文章</p>
				</div>
				<button class="icon" id="refreshBtn" title="刷新列表" aria-label="刷新列表">⟳</button>
			</header>
			<div class="search">
				<input id="search" placeholder="搜索文档" />
			</div>
			<div class="post-list" id="postList"></div>
		</aside>
		<main class="editor">
			<header class="toolbar">
				<div class="status" id="status">准备就绪</div>
				<div class="actions">
					<button id="newBtn">新建文档</button>
					<button id="deleteBtn" class="danger">删除</button>
					<button id="saveBtn" class="primary">保存</button>
				</div>
			</header>
			<section class="form" id="editorForm">
				<div class="form-grid">
					<label class="span-2">文档路径
						<input id="path" placeholder="my-post.md 或 guide/index.md" />
					</label>
					<label class="span-2">标题
						<input id="title" placeholder="请输入标题" />
					</label>
					<label>发布日期
						<input id="published" type="date" />
					</label>
					<label>更新日期
						<input id="updated" type="date" />
					</label>
					<label>分类
						<input id="category" placeholder="例如：随笔" />
					</label>
					<label>语言
						<input id="lang" placeholder="zh-CN" />
					</label>
					<label class="span-2">标签
						<input id="tags" placeholder="用逗号分隔，例如 Markdown, 日常" />
					</label>
					<label class="span-2">封面图
						<input id="image" placeholder="./cover.avif 或 /assets/..." />
					</label>
					<label class="span-4">摘要
						<input id="description" placeholder="这句话会显示在博客首页和文章列表里" />
					</label>
					<label>作者
						<input id="author" />
					</label>
					<label>来源链接
						<input id="sourceLink" />
					</label>
					<label>许可证名称
						<input id="licenseName" />
					</label>
					<label>许可证链接
						<input id="licenseUrl" />
					</label>
					<label>访问密码
						<input id="password" />
					</label>
					<label>密码提示
						<input id="passwordHint" />
					</label>
					<div class="toggles span-2">
						<label class="check"><input id="draft" type="checkbox" />草稿</label>
						<label class="check"><input id="pinned" type="checkbox" />置顶</label>
						<label class="check"><input id="comment" type="checkbox" />评论</label>
					</div>
				</div>
				<div class="writer">
					<div class="body-wrap">
						<div class="panel-title">正文</div>
						<textarea id="body" spellcheck="false" placeholder="从这里开始写正文..."></textarea>
					</div>
					<div class="preview-wrap">
						<div class="panel-title">预览</div>
						<div class="preview" id="preview"></div>
					</div>
				</div>
			</section>
		</main>
	</div>
	<script>
		const state = {
			posts: [],
			currentPath: "",
			dirty: false,
		};
		const el = (id) => document.getElementById(id);
		const controls = [
			"path", "title", "published", "updated", "description", "image", "tags", "category",
			"draft", "lang", "pinned", "author", "sourceLink", "licenseName", "licenseUrl",
			"comment", "password", "passwordHint", "body"
		];

		function setStatus(message, ok = false) {
			el("status").textContent = message;
			el("status").classList.toggle("ok", ok);
		}

		function today() {
			return new Date().toISOString().slice(0, 10);
		}

		function slugify(text) {
			return String(text || "new-post")
				.trim()
				.toLowerCase()
				.replace(/['"]/g, "")
				.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
				.replace(/^-+|-+$/g, "") || "new-post";
		}

		async function api(path, options) {
			const response = await fetch(path, {
				headers: { "content-type": "application/json" },
				...options,
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || "请求失败");
			return data;
		}

		async function loadPosts() {
			const data = await api("/api/posts");
			state.posts = data.posts;
			renderPosts();
		}

		function renderPosts() {
			const query = el("search").value.trim().toLowerCase();
			const list = el("postList");
			const posts = state.posts.filter((post) => {
				const text = [post.title, post.path, post.category, post.tags.join(",")].join(" ").toLowerCase();
				return text.includes(query);
			});
			list.innerHTML = posts.length ? "" : '<div class="empty">没有找到文章</div>';
			for (const post of posts) {
				const button = document.createElement("button");
				button.className = "post-item" + (post.path === state.currentPath ? " active" : "");
				button.innerHTML = '<span class="post-title"></span><span></span><span class="post-meta"></span>';
				button.children[0].textContent = post.title;
				if (post.draft) {
					button.children[1].className = "badge";
					button.children[1].textContent = "草稿";
				}
				button.children[2].textContent = [post.published, post.category, post.path].filter(Boolean).join(" · ");
				button.addEventListener("click", () => loadPost(post.path));
				list.appendChild(button);
			}
		}

		async function loadPost(postPath) {
			if (state.dirty && !confirm("当前文章还没保存，要切换吗？")) return;
			const data = await api("/api/post?path=" + encodeURIComponent(postPath));
			state.currentPath = data.path;
			fillForm(data.path, data.frontmatter, data.body);
			state.dirty = false;
			setStatus("已载入 " + data.path, true);
			renderPosts();
		}

		function fillForm(postPath, frontmatter, body) {
			el("path").value = postPath || "";
			for (const [key, value] of Object.entries(frontmatter || {})) {
				if (!el(key)) continue;
				if (el(key).type === "checkbox") el(key).checked = Boolean(value);
				else if (key === "tags") el(key).value = Array.isArray(value) ? value.join(", ") : value || "";
				else el(key).value = value || "";
			}
			el("body").value = body || "";
			renderPreview();
		}

		function readForm() {
			return {
				path: el("path").value.trim(),
				oldPath: state.currentPath,
				frontmatter: {
					title: el("title").value.trim(),
					published: el("published").value,
					updated: el("updated").value,
					description: el("description").value,
					image: el("image").value,
					tags: el("tags").value,
					category: el("category").value,
					draft: el("draft").checked,
					lang: el("lang").value,
					pinned: el("pinned").checked,
					author: el("author").value,
					sourceLink: el("sourceLink").value,
					licenseName: el("licenseName").value,
					licenseUrl: el("licenseUrl").value,
					comment: el("comment").checked,
					password: el("password").value,
					passwordHint: el("passwordHint").value,
				},
				body: el("body").value,
			};
		}

		async function savePost() {
			const payload = readForm();
			if (!payload.path) {
				payload.path = slugify(payload.frontmatter.title) + ".md";
				el("path").value = payload.path;
			}
			if (!payload.frontmatter.title) {
				alert("标题不能为空。");
				return;
			}
			const data = await api("/api/post", { method: "POST", body: JSON.stringify(payload) });
			state.currentPath = data.path;
			state.dirty = false;
			setStatus("已保存 " + data.path, true);
			await loadPosts();
		}

		function newPost() {
			if (state.dirty && !confirm("当前文章还没保存，要新建吗？")) return;
			state.currentPath = "";
			fillForm("", {
				title: "",
				published: today(),
				updated: "",
				description: "",
				image: "",
				tags: [],
				category: "",
				draft: true,
				lang: "",
				pinned: false,
				comment: true,
			}, "# 新文章\n\n");
			state.dirty = false;
			setStatus("正在创建新文章");
			renderPosts();
			el("title").focus();
		}

		async function deletePost() {
			if (!state.currentPath) return alert("还没有选择文章。");
			if (!confirm("确定删除 " + state.currentPath + " 吗？")) return;
			await api("/api/delete", { method: "POST", body: JSON.stringify({ path: state.currentPath }) });
			state.currentPath = "";
			state.dirty = false;
			fillForm("", {}, "");
			setStatus("已删除文章", true);
			await loadPosts();
		}

		function renderPreview() {
			const source = el("body").value;
			el("preview").innerHTML = markdownToHtml(source);
		}

		function escapeHtml(value) {
			return String(value)
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")
				.replaceAll('"', "&quot;");
		}

		function inlineMarkdown(value) {
			return escapeHtml(value)
				.replace(/\`([^\`]+)\`/g, "<code>$1</code>")
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				.replace(/\*([^*]+)\*/g, "<em>$1</em>")
				.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
		}

		function markdownToHtml(markdown) {
			const lines = markdown.split(/\r?\n/);
			const html = [];
			let inCode = false;
			let paragraph = [];
			let list = false;

			const flushParagraph = () => {
				if (paragraph.length) {
					html.push("<p>" + inlineMarkdown(paragraph.join(" ")) + "</p>");
					paragraph = [];
				}
			};
			const closeList = () => {
				if (list) {
					html.push("</ul>");
					list = false;
				}
			};

			for (const line of lines) {
				if (line.startsWith("\x60\x60\x60")) {
					if (inCode) {
						html.push("</code></pre>");
						inCode = false;
					} else {
						flushParagraph();
						closeList();
						html.push("<pre><code>");
						inCode = true;
					}
					continue;
				}
				if (inCode) {
					html.push(escapeHtml(line) + "\n");
					continue;
				}
				if (!line.trim()) {
					flushParagraph();
					closeList();
					continue;
				}
				const heading = line.match(/^(#{1,4})\s+(.+)$/);
				if (heading) {
					flushParagraph();
					closeList();
					const level = heading[1].length;
					html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
					continue;
				}
				const item = line.match(/^[-*]\s+(.+)$/);
				if (item) {
					flushParagraph();
					if (!list) {
						html.push("<ul>");
						list = true;
					}
					html.push("<li>" + inlineMarkdown(item[1]) + "</li>");
					continue;
				}
				if (line.startsWith("> ")) {
					flushParagraph();
					closeList();
					html.push("<blockquote>" + inlineMarkdown(line.slice(2)) + "</blockquote>");
					continue;
				}
				paragraph.push(line);
			}
			flushParagraph();
			closeList();
			if (inCode) html.push("</code></pre>");
			return html.join("\n") || '<div class="empty">预览会显示在这里</div>';
		}

		for (const id of controls) {
			el(id)?.addEventListener("input", () => {
				state.dirty = true;
				setStatus("有未保存修改");
				if (id === "body") renderPreview();
			});
		}
		el("search").addEventListener("input", renderPosts);
		el("refreshBtn").addEventListener("click", loadPosts);
		el("saveBtn").addEventListener("click", () => savePost().catch((error) => alert(error.message)));
		el("newBtn").addEventListener("click", newPost);
		el("deleteBtn").addEventListener("click", () => deletePost().catch((error) => alert(error.message)));

		window.addEventListener("beforeunload", (event) => {
			if (!state.dirty) return;
			event.preventDefault();
			event.returnValue = "";
		});

		loadPosts().then(() => {
			if (state.posts[0]) loadPost(state.posts[0].path);
			else newPost();
		}).catch((error) => setStatus(error.message));
	</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
	const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-headers": "content-type",
		});
		res.end();
		return;
	}

	if (url.pathname.startsWith("/api/")) {
		void handleApi(req, res, url);
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		sendHtml(res, appHtml);
		return;
	}

	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
	console.log(`Firefly editor is running at http://127.0.0.1:${port}`);
	console.log(`Posts directory: ${postsDir}`);
});
