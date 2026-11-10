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
