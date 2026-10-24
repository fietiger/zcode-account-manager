'use strict';

/**
 * Package this app into a single self-contained executable for the host
 * platform, using @yao-pkg/pkg.
 *
 *   node scripts/build.js            # build for this machine
 *   node scripts/build.js --all      # build every supported target
 *
 * Output: dist/zcode-account-manager-<platform>-<arch>[.exe]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const PLATFORM = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform];
const NODE_TARGET = process.env.PKG_NODE_TARGET || 'node20';
const ALL_TARGETS = ['win-x64', 'macos-x64', 'macos-arm64', 'linux-x64'];

function outputName(target) {
  const [platform, arch] = target.split('-');
  return `zcode-account-manager-${platform}-${arch}${platform === 'win' ? '.exe' : ''}`;
}

function pkgBin() {
  // Run the CLI through the current node binary: the .cmd shim breaks on
  // Windows when the project path contains spaces.
  const candidates = [
    path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js'),
    path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib', 'bin.js'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function buildOne(target, bin) {
  const out = path.join(DIST, outputName(target));
  const pkgArgs = ['.', '--targets', `${NODE_TARGET}-${target}`, '--output', out];

  console.log(`\n▸ ${NODE_TARGET}-${target}`);
  const result = bin
    ? spawnSync(process.execPath, [bin, ...pkgArgs], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npx', ['--yes', '@yao-pkg/pkg', ...pkgArgs], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

  if (result.status !== 0) {
    throw new Error(`打包失败：${target}`);
  }
  if (!fs.existsSync(out)) {
    throw new Error(`未找到产物：${out}`);
  }
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${path.relative(ROOT, out)}  (${mb} MB)`);
  return out;
}

function main() {
  if (!PLATFORM) {
    console.error(`不支持的平台：${process.platform}`);
    process.exit(1);
  }

  const bin = pkgBin();
  if (!bin) {
    console.warn('未在 node_modules 中找到 pkg，将回退到 npx（需要联网）。');
  }

  const targets = process.argv.includes('--all') ? ALL_TARGETS : [`${PLATFORM}-${process.arch}`];
  fs.mkdirSync(DIST, { recursive: true });

  const built = [];
  for (const target of targets) built.push(buildOne(target, bin));

  console.log(`\n完成，共 ${built.length} 个产物：`);
  for (const file of built) console.log(`  ${path.relative(ROOT, file)}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
