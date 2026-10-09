#!/usr/bin/env node
/**
 * 查询各软件的最新版本并生成 data/versions.json
 * 可在本地运行，也可作为 Netlify 构建步骤运行 (npm run build)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOFTWARE_FILE = join(ROOT, 'software.json');
const DATA_DIR = join(ROOT, 'data');
const OUTPUT_FILE = join(DATA_DIR, 'versions.json');

const TIMEOUT_MS = 15000;

// 使用 curl 获取 (绕过部分 CDN 的 TLS 指纹拦截)
// 返回 { text, status } 或 null
function fetchViaCurl(url) {
  try {
    const output = execFileSync('curl', [
      '-sL', '--max-time', '15', '-w', '\n%{http_code}',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      url,
    ], { encoding: 'utf-8' });
    const lastNewline = output.lastIndexOf('\n');
    const status = parseInt(output.slice(lastNewline + 1).trim(), 10);
    const text = output.slice(0, lastNewline);
    if (!status || status >= 400) return null;
    return text;
  } catch {
    return null;
  }
}

// 带超时和重试的 fetch (失败时回退到 curl)
async function fetchText(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  // fetch 全部失败, 尝试 curl
  const curlResult = fetchViaCurl(url);
  if (curlResult !== null) return curlResult;
  throw lastErr;
}

// 从点路径读取 JSON 字段
function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// 从 GitHub 获取最新版本 (优先 releases, 失败回退 tags)
async function getGithubVersion(repo, stripPrefix) {
  let tag = '';
  let date = null;
  try {
    const text = await fetchText(`https://api.github.com/repos/${repo}/releases/latest`);
    const data = JSON.parse(text);
    tag = data.tag_name || '';
    date = data.published_at ? data.published_at.slice(0, 10) : null;
  } catch (err) {
    // releases 不可用, 回退到 tags
    const text = await fetchText(`https://api.github.com/repos/${repo}/tags?per_page=1`);
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) throw new Error('no tags');
    tag = data[0].name || '';
  }
  // 去掉前缀 v
  tag = tag.replace(/^v/i, '').trim();
  // 去掉自定义前缀
  if (stripPrefix) {
    const re = new RegExp(`^${stripPrefix}`);
    tag = tag.replace(re, '').trim();
  }
  return { version: tag, date };
}

// 从 URL + 正则获取版本
async function getUrlVersion({ url, versionRegex }) {
  const text = await fetchText(url);
  const re = new RegExp(versionRegex);
  const m = text.match(re);
  if (!m || !m[1]) throw new Error('version not matched');
  return { version: m[1].trim(), date: null };
}

// 解析单个软件的版本
async function resolveVersion(soft) {
  const src = soft.source || {};
  try {
    let result;
    if (src.type === 'github' && src.repo) {
      result = await getGithubVersion(src.repo, src.stripPrefix);
    } else if (src.type === 'url' && src.url && src.versionRegex) {
      result = await getUrlVersion(src);
    } else if (src.type === 'api' && src.url && src.versionPath) {
      const text = await fetchText(src.url);
      const data = JSON.parse(text);
      const value = getByPath(data, src.versionPath);
      if (!value) throw new Error('api version path empty');
      result = { version: String(value), date: null };
    } else {
      throw new Error(`unknown source type: ${src.type}`);
    }

    if (!result.version) throw new Error('empty version');

    // 应用版本模板
    if (src.versionTemplate) {
      result.version = src.versionTemplate.replace('{version}', result.version);
    }

    // 下载地址: 优先版本模板, 否则静态地址
    let downloadUrl = soft.downloadUrl;
    if (src.downloadUrlTemplate) {
      downloadUrl = src.downloadUrlTemplate.replace('{version}', result.version);
    }

    return {
      version: result.version,
      date: result.date || today(),
      downloadUrl,
      updated: true,
    };
  } catch (err) {
    console.warn(`[${soft.name}] 获取版本失败: ${err.message}, 使用 fallback 版本`);
    return {
      version: src.fallbackVersion || soft.version || '未知',
      date: soft.date || today(),
      downloadUrl: soft.downloadUrl,
      updated: false,
      error: err.message,
    };
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const software = JSON.parse(readFileSync(SOFTWARE_FILE, 'utf-8'));

  console.log(`开始查询 ${software.length} 个软件的最新版本...`);

  // 并发查询，但限制并发数避免触发限流
  const results = [];
  const concurrency = 4;
  for (let i = 0; i < software.length; i += concurrency) {
    const batch = software.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(resolveVersion));
    results.push(...batchResults);
  }

  // 合并数据
  const output = software.map((soft, idx) => {
    const r = results[idx];
    return {
      id: soft.id,
      name: soft.name,
      description: soft.description,
      category: soft.category,
      icon: soft.icon,
      iconColor: soft.iconColor,
      platforms: soft.platforms,
      platformTypes: soft.platformTypes,
      size: soft.size,
      featured: soft.featured,
      version: r.version,
      date: r.date,
      downloadUrl: r.downloadUrl,
    };
  });

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  const updatedCount = results.filter((r) => r.updated).length;
  console.log(`\n完成: 共 ${software.length} 个软件, 成功更新 ${updatedCount} 个, 失败 ${software.length - updatedCount} 个`);
  console.log(`已写入: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('更新失败:', err);
  process.exit(1);
});
