// Netlify Scheduled Function: 每周触发构建以更新软件版本
//
// 部署步骤 (Netlify 后台操作):
//   1. Site settings -> Build & deploy -> Build hooks -> Add build hook
//      名称可填 "weekly-version-update"，分支选 main，保存后复制 URL
//   2. Site settings -> Environment variables -> 添加变量:
//      键: BUILD_HOOK_URL  值: 上一步复制的 Build Hook URL
//   3. 重新部署 (触发一次即可)，定时任务会自动注册
//
// 调度声明通过下方 config.schedule 完成 (标准 5 字段 cron, UTC 时区)
//   "0 2 * * 1" = 每周一 02:00 UTC
//
// 除定时触发外，也可手动访问函数 URL 立即触发一次更新。

export const config = {
  schedule: "0 2 * * 1",
};

export default async (req, context) => {
  const hookUrl = Netlify.env.get('BUILD_HOOK_URL');

  if (!hookUrl) {
    const msg = '未配置 BUILD_HOOK_URL 环境变量，请在 Netlify 后台添加';
    console.warn(msg);
    return new Response(JSON.stringify({ triggered: false, error: msg }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const res = await fetch(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Build hook 返回 HTTP ${res.status}`);
    }

    const now = new Date().toISOString();
    console.log(`[${now}] 成功触发版本更新构建`);
    return new Response(
      JSON.stringify({ triggered: true, at: now }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('触发构建失败:', err.message);
    return new Response(
      JSON.stringify({ triggered: false, error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
