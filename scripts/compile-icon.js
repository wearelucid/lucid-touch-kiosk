// Compiles build/AppIcon.icon (an Icon Composer bundle) into what macOS 26+
// expects: Assets.car + CFBundleIconName. A plain .icns alone gets wrapped in
// Tahoe's grey "legacy" tile, however the PNG is cropped (measured). actool
// also emits AppIcon.icns, which stays the icon for older macOS. Runs before
// `electron-builder` (npm predist); needs Xcode 26+ for actool.
'use strict'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const src = path.join(root, 'build', 'AppIcon.icon')
const out = path.join(root, 'build', 'compiled-icon')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
execFileSync(
  'xcrun',
  [
    'actool', src,
    '--compile', out,
    '--app-icon', 'AppIcon',
    '--platform', 'macosx',
    '--minimum-deployment-target', '26.0',
    '--output-partial-info-plist', path.join(out, 'partial.plist'),
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
for (const f of ['Assets.car', 'AppIcon.icns']) {
  if (!fs.existsSync(path.join(out, f))) throw new Error('actool did not produce ' + f)
}
console.log('icon compiled → build/compiled-icon/{Assets.car,AppIcon.icns}')
