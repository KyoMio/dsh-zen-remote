// PG-6b-fix 打包纪律钉子：纯静态断言（读源文件，零运行时、零网络），
// 钉住三处修复不被回退——
//   1. package.json 白名单 esbuild 构建脚本（pnpm install 不再
//      ERR_PNPM_IGNORED_BUILDS 退出 1）；
//   2. Dockerfile 在切 USER zr 之前建 /data 并归属 zr（匿名卷首挂按镜像层
//      属主初始化，缺这步 Linux 上写不了 master.key / gateway.sqlite）；
//   3. Modal 焦点 effect 只在挂载时安装一次（onClose 经 ref 间接，依赖 []，
//      子内容 autoFocus 不被抢）。
// docker build 本身的实测在返工单执行时完成（zr-gw-smoke 镜像构建成功后
// 已清理），这里只钉住构成条件。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(pkgDir, relative), 'utf8');

describe('打包纪律（PG-6b-fix）', () => {
  test('esbuild 构建脚本已裁决：package.json（pnpm ≤10）与 pnpm-workspace.yaml（pnpm 11 的 allowBuilds）', () => {
    const pkg = JSON.parse(read('package.json'));
    const legacy = pkg.pnpm?.onlyBuiltDependencies ?? [];
    assert.ok(
      legacy.includes('esbuild'),
      `pnpm.onlyBuiltDependencies 必须包含 esbuild，当前：${JSON.stringify(legacy)}`,
    );
    // pnpm 11 移除了 onlyBuiltDependencies 系列，设置家是 pnpm-workspace.yaml
    // 的 allowBuilds 映射；strictDepBuilds 默认 true，未裁决即 ERR_PNPM_IGNORED_BUILDS
    const settings = read('pnpm-workspace.yaml');
    assert.match(settings, /allowBuilds:\s*\n\s+esbuild:\s*true\s*$/m, 'pnpm-workspace.yaml 必须 allowBuilds: esbuild: true');
  });

  test('Dockerfile 在 USER zr 之前建 /data 并归属 zr', () => {
    const dockerfile = read('Dockerfile');
    const mkdirIndex = dockerfile.indexOf('mkdir -p /data');
    const chownIndex = dockerfile.indexOf('chown -R zr:zr /data');
    const userIndex = dockerfile.search(/^USER zr$/m);
    assert.notEqual(mkdirIndex, -1, '必须有 mkdir -p /data');
    assert.notEqual(chownIndex, -1, '必须有 chown -R zr:zr /data');
    assert.notEqual(userIndex, -1, '必须有 USER zr');
    assert.ok(mkdirIndex < userIndex && chownIndex < userIndex, 'mkdir/chown 必须出现在 USER zr 之前');
  });

  test('Modal 焦点 effect 只安装一次：依赖 []、onClose 经 ref、autoFocus 不被抢', () => {
    const source = read('src/web/components/Modal.tsx');
    assert.match(source, /onCloseRef\.current = onClose/, '必须用 ref 保存最新 onClose');
    assert.doesNotMatch(
      source,
      /}, \[onClose\]\);/,
      '焦点/Esc effect 依赖不得是 [onClose]——父组件传内联回调时每次渲染重装，会抢走输入框焦点',
    );
    assert.match(source, /}, \[\]\);/, '焦点捕获与 Esc 监听必须在挂载时只装一次（依赖 []）');
    assert.match(
      source,
      /contains\(document\.activeElement\)/,
      '子内容带 autoFocus 时不得兜底抢焦点（先查焦点是否已在弹窗内）',
    );
  });
});

// ---------------------------------------------------------------- UI/UX 静态守卫（PG-6c）

/** 取出 @media <query> 的整个规则体（平衡括号扫描，不靠脆弱的正则截断） */
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query}`);
  assert.notEqual(start, -1, `global.css 缺少 @media ${query} 媒体查询`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(bodyStart + 1, i);
    }
  }
  assert.fail(`@media ${query} 的规则体没有闭合`);
}

describe('UI/UX 静态守卫（PG-6c）', () => {
  test('≤767px：顶栏隐藏品牌标题/分割线/账号邮箱，表格是全宽单列卡片而非 tbody 双列并排', () => {
    const css = read('src/web/styles/global.css');
    const narrow = mediaBlock(css, '(max-width: 767px)');
    assert.match(
      narrow,
      /[^{}]*\.brand-title[^{]*\{[^}]*display:\s*none/,
      '窄屏顶栏只留品牌标识，.brand-title 必须隐藏',
    );
    assert.match(narrow, /\.topbar-divider/, '窄屏必须隐藏顶栏分割线');
    assert.match(
      narrow,
      /[^{}]*\.account-button \.account-email[^{]*\{[^}]*display:\s*none/,
      '窄屏必须隐藏账号按钮里的邮箱（只留头像）',
    );
    assert.match(narrow, /tbody\s*\{[^}]*display:\s*block/, '窄屏 tbody 落回 block，由每行自己成卡片');
    assert.doesNotMatch(
      narrow,
      /tbody\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr/,
      '窄屏 tbody 不得再做 1fr 1fr 并排网格（两台设备挤成并排窄卡是已修掉的破版）',
    );
    assert.doesNotMatch(
      css,
      /tbody\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr/,
      '任何断点都不允许 tbody 的 1fr 1fr 并排网格',
    );
  });

  test('设备表与连接表的 <tr> 不得带非法 role="button"（保留 row 语义与键盘可达）', () => {
    for (const file of ['src/web/components/NetworkView.tsx', 'src/web/components/DeviceDetail.tsx']) {
      const source = read(file);
      assert.doesNotMatch(source, /<tr[^>]*role="button"/, `${file}：<tr> 上的 role="button" 破坏表格无障碍树`);
      assert.match(source, /tabIndex={0}/, `${file}：行必须保留 tabIndex={0} 键盘可达`);
    }
  });
});
