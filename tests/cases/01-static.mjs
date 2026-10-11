// 用例 01：静态与版本一致性（无需改动即可长期回归）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MANIFEST, ROOT, startServer } from '../harness.mjs';

const syntaxCheck = file => new Promise(resolve => {
  const child = spawn(process.execPath, ['--check', file], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolve({ code, stderr: stderr.trim() }));
});

export default {
  id: '01',
  title: '语法、版本一致性、静态资源与路由前缀',
  covers: [
    'node --check 两个前端/后端 JS',
    'manifest / package.json / VERSION 三处版本同步',
    '首页与静态资源 Content-Type',
    '路径穿越拦截',
    '未知 API 404',
    '/app/vdl 前缀与 308 重定向',
  ],
  async run(ctx) {
    for (const file of ['ui/server.js', 'ui/main.js']) {
      const result = await syntaxCheck(file);
      await ctx.check(`${file} 语法检查通过`, result.code === 0, result.stderr.slice(0, 160));
    }

    const manifest = fs.readFileSync(MANIFEST, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const serverSrc = fs.readFileSync(path.join(ROOT, 'ui', 'server.js'), 'utf8');
    const manifestVersion = /^version\s*=\s*(\S+)/m.exec(manifest)?.[1] || '';
    const serverVersion = /const VERSION = '([^']+)'/.exec(serverSrc)?.[1] || '';
    await ctx.check(
      'manifest / package.json / VERSION 三处一致',
      manifestVersion === pkg.version && pkg.version === serverVersion,
      `manifest=${manifestVersion} package=${pkg.version} server=${serverVersion}`,
    );

    const server = await startServer(ctx, { dataDir: ctx.temp('static') });

    const home = await fetch(`${server.base}/`);
    const html = await home.text();
    await ctx.check('首页返回 index.html', home.status === 200 && html.includes('id="taskList"') && html.includes('id="playerDialog"'));

    const css = await fetch(`${server.base}/styles.css`);
    await ctx.check('CSS 静态资源', css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'));

    const mainSrc = fs.readFileSync(path.join(ROOT, 'ui', 'main.js'), 'utf8');
    await ctx.check(
      '新增任务对话框含「部分」集数输入框',
      html.includes('value="partial"') && html.includes('id="episodeSelect"') && html.includes('id="episodeSelectRow"'),
    );
    await ctx.check(
      '前端按下载范围切换集数输入框',
      mainSrc.includes("$('#episodeSelectRow').hidden = mode !== 'partial'") && mainSrc.includes('body.episodeSelect ='),
    );

    const icon = await fetch(`${server.base}/images/icon_64.png`);
    await ctx.check('图片静态资源', icon.status === 200 && (icon.headers.get('content-type') || '').includes('image/png'));

    const traversal = await fetch(`${server.base}/..%2f..%2fpackage.json`);
    await ctx.check('路径穿越被拒绝', [403, 404].includes(traversal.status), `status=${traversal.status}`);

    const unknown = await fetch(`${server.base}/api/does-not-exist`);
    await ctx.check('未知 API 返回 404', unknown.status === 404);

    const redirect = await fetch(`${server.base}/app/vdl`, { redirect: 'manual' });
    await ctx.check(
      '/app/vdl 无斜杠时 308 重定向',
      redirect.status === 308 && redirect.headers.get('location') === '/app/vdl/',
      `status=${redirect.status} location=${redirect.headers.get('location')}`,
    );

    const prefixed = await fetch(`${server.base}/app/vdl/api/health`);
    await ctx.check('带 /app/vdl 前缀的 API 可用', prefixed.status === 200);
  },
};
