// Cloudflare Worker Cron Trigger: 每周触发 Cloudflare Pages 部署以更新软件版本
//
// 部署步骤 (前提: 本仓库已部署为 Cloudflare Pages 项目):
//   1. Cloudflare Dashboard -> Workers & Pages -> Pages 项目 -> Settings -> Builds & deployments
//      -> Deploy hooks -> Add deploy hook, 名称可填 "weekly-version-update", 分支选 main, 复制 URL
//   2. 配置密钥 (在本目录执行):
//        npx wrangler secret put DEPLOY_HOOK_URL
//      粘贴上一步复制的 Deploy Hook URL
//   3. 部署 Worker (在本目录执行): npx wrangler deploy
//
// 调度声明见 wrangler.toml 的 [triggers] crons ("0 2 * * 1" = 每周一 02:00 UTC)
// 除定时触发外，也可手动访问 Worker URL 立即触发一次更新 (无鉴权，注意不要泄露地址)

export default {
  // 定时触发
  async scheduled(event, env, ctx) {
    await triggerDeploy(env);
  },

  // 手动触发入口: 访问 Worker URL 即触发一次更新
  async fetch(req, env) {
    const result = await triggerDeploy(env);
    return new Response(JSON.stringify(result), {
      status: result.triggered ? 200 : 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};

async function triggerDeploy(env) {
  const hookUrl = env.DEPLOY_HOOK_URL;

  if (!hookUrl) {
    const error = '未配置 DEPLOY_HOOK_URL，请先运行: npx wrangler secret put DEPLOY_HOOK_URL';
    console.warn(error);
    return { triggered: false, error };
  }

  try {
    const res = await fetch(hookUrl, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Deploy hook 返回 HTTP ${res.status}`);
    }
    const now = new Date().toISOString();
    console.log(`[${now}] 成功触发版本更新部署`);
    return { triggered: true, at: now };
  } catch (err) {
    console.error('触发部署失败:', err.message);
    return { triggered: false, error: err.message };
  }
}
