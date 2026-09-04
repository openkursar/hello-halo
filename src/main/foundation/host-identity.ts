/**
 * Host Identity — best-effort local environment fingerprint (foundation tier).
 *
 * Distinct from `device-identity.ts`: that module answers "which installation
 * is this" (a stable anonymous UUID, persisted). This module answers "which
 * machine / account is it running under right now" — OS username, domain,
 * hostname, and network interfaces, read live from the OS on every call and
 * never persisted. Values can legitimately change across sessions (VDI
 * reassignment, DHCP lease renewal); callers that need stability over a
 * session own their own cache.
 *
 * Gated behind `product.json.telemetry.collectHostIdentity` (see
 * `getTelemetryConfig()`). Open-source builds must never enable this — it
 * exists to let enterprise-internal builds correlate the anonymous per-install
 * `analytics.userId` with a real employee via corporate NAC/DHCP records.
 */

import { networkInterfaces, userInfo, hostname as osHostname } from 'os'

export interface HostNetworkInterface {
  name: string
  mac: string
  ipv4: string
}

export interface HostIdentity {
  username?: string
  userDomain?: string
  hostname?: string
  interfaces: HostNetworkInterface[]
  collectedAt: number
}

const NULL_MAC = '00:00:00:00:00:00'

function collectUsername(): string | undefined {
  // os.userInfo() throws in environments without a resolvable passwd entry
  // (minimal containers, some CI images) rather than returning undefined.
  try {
    const { username } = userInfo()
    if (username) return username
  } catch {
    // fall through to env fallback
  }
  return process.env.USERNAME || process.env.USER || undefined
}

/** Windows domain prefix (e.g. "CORP"). Absent on macOS/Linux. */
function collectUserDomain(): string | undefined {
  return process.env.USERDOMAIN || undefined
}

function collectHostname(): string | undefined {
  try {
    return osHostname() || undefined
  } catch {
    return undefined
  }
}

/**
 * Every non-internal IPv4 interface, physical and virtual alike — including
 * ones a LAN-pairing use case would filter out.
 *
 * Unlike `getLocalIp()` below, this does not try to pick "the" address: on a
 * VDI the adapter that actually carries the user's real traffic is often a
 * hypervisor-presented NIC (VMware/Hyper-V) that a virtual-adapter filter
 * would exclude, so filtering here would silently drop the one interface
 * that matters. Matching a MAC/IP against corporate NAC/DHCP records is a
 * server-side job — the client's role is to report every candidate.
 */
function collectInterfaces(): HostNetworkInterface[] {
  const result: HostNetworkInterface[] = []

  try {
    const interfaces = networkInterfaces()

    for (const name of Object.keys(interfaces)) {
      const list = interfaces[name]
      if (!list) continue

      for (const info of list) {
        if (info.internal || info.family !== 'IPv4') continue
        if (info.mac === NULL_MAC) continue // unbound adapter, pure noise
        result.push({ name, mac: info.mac, ipv4: info.address })
      }
    }
  } catch {
    // Degrade to an empty list — never let interface enumeration break the
    // caller's telemetry path.
  }

  return result
}

/**
 * Collect a best-effort host identity snapshot. Never throws — any single
 * field failure degrades to an absent value so a broken environment can
 * never break the caller's telemetry path.
 */
export function getHostIdentity(): HostIdentity {
  return {
    username: collectUsername(),
    userDomain: collectUserDomain(),
    hostname: collectHostname(),
    interfaces: collectInterfaces(),
    collectedAt: Date.now(),
  }
}

/**
 * Check if a network interface name looks like a virtual adapter.
 * Virtual adapters include Docker, WSL, VPN, Hyper-V, VMware, VirtualBox,
 * sing-box TUN, etc.
 */
function isVirtualInterface(name: string): boolean {
  const virtualPatterns = [
    /^docker/i,
    /^br-/i,
    /^veth/i,
    /^vEthernet/i,
    /^vmnet/i,
    /^VMware/i,
    /^VirtualBox/i,
    /^vboxnet/i,
    /^Hyper-V/i,
    /^Default Switch/i,
    /^WSL/i,
    /^tun/i,
    /^tap/i,
    /^singbox/i,
    /^sing-box/i,
    /^clash/i,
    /^utun/i,
    /^tailscale/i,
    /^Tailscale/i,
    /^ZeroTier/i,
    /^zt/i,
    /^wg/i,
    /^wireguard/i,
    /^ham/i,
    /^Hamachi/i,
    /^npcap/i,
    /^lo/i,
  ]
  return virtualPatterns.some((pattern) => pattern.test(name))
}

/**
 * Get a LAN-reachable local IPv4 address, preferring physical adapters
 * (Ethernet, Wi-Fi) over virtual ones (Docker, WSL, VPN, TUN, Hyper-V,
 * VMware, ...).
 *
 * This is the opposite selection goal from `collectInterfaces()`: remote
 * pairing needs one address that *other devices can actually reach*, so
 * virtual adapters are deliberately deprioritized here. Host-identity
 * collection needs every candidate for server-side matching, so it does not
 * filter at all. Do not share filtering logic between the two.
 */
export function getLocalIp(): string | null {
  const interfaces = networkInterfaces()
  let fallback: string | null = null

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue

    const virtual = isVirtualInterface(name)

    for (const info of iface) {
      // Skip internal and non-IPv4 addresses
      if (info.internal || info.family !== 'IPv4') continue

      // Prefer addresses from physical interfaces
      if (!virtual) {
        return info.address
      }

      // Keep the first virtual address as fallback
      if (!fallback) {
        fallback = info.address
      }
    }
  }

  return fallback
}
