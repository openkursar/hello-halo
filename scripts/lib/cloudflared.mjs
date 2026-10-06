// Cloudflared is pinned to one release and every download is checked against
// the SHA-256 GitHub records for that asset, so a new upstream release never changes
// what ships without someone bumping these values.
export const CLOUDFLARED_VERSION = '2026.9.3'
export const CLOUDFLARED_ASSETS = {
  'mac-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095' },
  'mac-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977' },
  win: { file: 'cloudflared-windows-amd64.exe', sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' },
  linux: { file: 'cloudflared-linux-amd64', sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' },
}
export const CLOUDFLARED_URLS = Object.fromEntries(Object.entries(CLOUDFLARED_ASSETS).map(([platform, asset]) =>
  [platform, `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`]))

export const CLOUDFLARED_PATHS = {
  'mac-arm64': 'node_modules/cloudflared/bin/cloudflared',
  'mac-x64': 'node_modules/cloudflared/bin/cloudflared-darwin-x64',
  win: 'node_modules/cloudflared/bin/cloudflared.exe',
  linux: 'node_modules/cloudflared/bin/cloudflared-linux-x64',
}

// Upstream's Darwin builds of this release target macOS 15. Only the remote
// tunnel needs this binary, so it carries its own floor instead of the app's.
export const CLOUDFLARED_MINIMUM_MACOS = '15.0.0'
