import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const { getAppManagerMock, getAppRuntimeMock, loadProductConfigMock } = vi.hoisted(() => ({
  getAppManagerMock: vi.fn(),
  getAppRuntimeMock: vi.fn(),
  loadProductConfigMock: vi.fn(),
}))

vi.mock("../../../src/main/apps/manager", () => ({
  getAppManager: getAppManagerMock,
}))

vi.mock("../../../src/main/apps/runtime", () => ({
  getAppRuntime: getAppRuntimeMock,
}))

vi.mock("../../../src/main/foundation/product-config", () => ({
  loadProductConfig: loadProductConfigMock,
  // config.service indirectly imports getDataFolderName via the same
  // module; provide a deterministic fallback so the test mock surface
  // matches the production export set.
  getDataFolderName: () => "halo-test",
}))

import {
  initRegistryService,
  shutdownRegistryService,
  addRegistry,
  refreshIndex,
  checkUpdates,
  getAppDetail,
  listApps,
  installFromStore,
  getRegistries,
} from "../../../src/main/store/registry.service"
import type { RegistryIndex } from "../../../src/shared/store/store-types"

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  })
}

describe("registry.service", () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    mkdirSync(join(homedir(), ".halo-dev"), { recursive: true })
    getAppManagerMock.mockReset()
    getAppRuntimeMock.mockReset()
    getAppManagerMock.mockReturnValue(null)
    getAppRuntimeMock.mockReturnValue(null)
    // Default: no product.json overrides (open-source build behaviour)
    loadProductConfigMock.mockReturnValue({ authProviders: [], registryOverrides: undefined })
  })

  afterEach(() => {
    shutdownRegistryService()
    vi.unstubAllGlobals()
  })

  it("lazily initializes when called before explicit init", async () => {
    const emptyIndex: RegistryIndex = {
      version: 1,
      generated_at: "2026-02-24T00:00:00.000Z",
      source: "https://openkursar.github.io/digital-human-protocol",
      apps: [],
    }

    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/index.json")) return jsonResponse(emptyIndex)
      throw new Error(`Unexpected URL: ${url}`)
    })

    const apps = await listApps()
    expect(apps).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openkursar.github.io/digital-human-protocol/index.json",
      expect.any(Object)
    )
  })

  it("checks updates against the installed app registry when slugs collide", async () => {
    initRegistryService()

    const custom = addRegistry({
      name: "Custom Registry",
      url: "https://example.com/registry",
      enabled: true,
    })

    const officialIndex: RegistryIndex = {
      version: 1,
      generated_at: "2026-02-24T00:00:00.000Z",
      source: "https://openkursar.github.io/digital-human-protocol",
      apps: [
        {
          slug: "shared-app",
          name: "Shared App",
          version: "1.0.0",
          author: "official",
          description: "Official version",
          type: "automation",
          format: "bundle",
          path: "packages/digital-humans/shared-app",
          category: "other",
          tags: [],
        },
      ],
    }

    const customIndex: RegistryIndex = {
      version: 1,
      generated_at: "2026-02-24T00:00:00.000Z",
      source: "https://example.com/registry",
      apps: [
        {
          slug: "shared-app",
          name: "Shared App",
          version: "2.0.0",
          author: "custom",
          description: "Custom newer version",
          type: "automation",
          format: "bundle",
          path: "packages/digital-humans/shared-app",
          category: "other",
          tags: [],
        },
      ],
    }

    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === "https://openkursar.github.io/digital-human-protocol/index.json") {
        return jsonResponse(officialIndex)
      }
      if (url === "https://example.com/registry/index.json") {
        return jsonResponse(customIndex)
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await refreshIndex()

    const updates = await checkUpdates([
      {
        id: "installed-1",
        spec: {
          name: "Shared App",
          version: "1.5.0",
          store: {
            slug: "shared-app",
            registry_id: custom.id,
          },
        },
      },
    ])

    expect(updates).toHaveLength(1)
    expect(updates[0].latestVersion).toBe("2.0.0")
    expect(updates[0].entry.author).toBe("custom")
  })

  it("re-fetches spec when cached version does not match latest index", async () => {
    initRegistryService()

    const indexV1: RegistryIndex = {
      version: 1,
      generated_at: "2026-02-24T00:00:00.000Z",
      source: "https://openkursar.github.io/digital-human-protocol",
      apps: [
        {
          slug: "cache-app",
          name: "Cache App",
          version: "1.0.0",
          author: "tester",
          description: "Cache test",
          type: "automation",
          format: "bundle",
          path: "packages/digital-humans/cache-app",
          category: "other",
          tags: [],
        },
      ],
    }

    const indexV2: RegistryIndex = {
      ...indexV1,
      generated_at: "2026-02-25T00:00:00.000Z",
      apps: [{ ...indexV1.apps[0], version: "2.0.0" }],
    }

    const specV1 = `
name: "Cache App"
version: "1.0.0"
author: "tester"
description: "Cache test"
type: automation
system_prompt: "run"
store:
  slug: "cache-app"
`

    const specV2 = `
name: "Cache App"
version: "2.0.0"
author: "tester"
description: "Cache test"
type: automation
system_prompt: "run"
store:
  slug: "cache-app"
`

    let currentIndex = indexV1
    let currentSpec = specV1

    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === "https://openkursar.github.io/digital-human-protocol/index.json") {
        return jsonResponse(currentIndex)
      }
      if (url === "https://openkursar.github.io/digital-human-protocol/packages/digital-humans/cache-app/spec.yaml") {
        return textResponse(currentSpec)
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await refreshIndex()
    const first = await getAppDetail("cache-app")
    expect(first.spec.version).toBe("1.0.0")

    currentIndex = indexV2
    currentSpec = specV2

    await refreshIndex()
    const second = await getAppDetail("cache-app")
    expect(second.spec.version).toBe("2.0.0")

    const specFetchCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/packages/digital-humans/cache-app/spec.yaml")
    )
    expect(specFetchCalls).toHaveLength(2)
  })

  it("installs bundle app and persists store provenance metadata", async () => {
    initRegistryService()

    const index: RegistryIndex = {
      version: 1,
      generated_at: "2026-02-24T00:00:00.000Z",
      source: "https://openkursar.github.io/digital-human-protocol",
      apps: [
        {
          slug: "install-app",
          name: "Install App",
          version: "1.2.3",
          author: "tester",
          description: "Install test",
          type: "automation",
          format: "bundle",
          path: "packages/digital-humans/install-app",
          category: "other",
          tags: [],
        },
      ],
    }

    const specYaml = `
name: "Install App"
version: "1.2.3"
author: "tester"
description: "Install test"
type: automation
system_prompt: "run"
store:
  slug: "install-app"
  category: "other"
`

    const installSpy = vi.fn().mockResolvedValue("app-installed-1")
    getAppManagerMock.mockReturnValue({
      install: installSpy,
    })

    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === "https://openkursar.github.io/digital-human-protocol/index.json") {
        return jsonResponse(index)
      }
      if (url === "https://openkursar.github.io/digital-human-protocol/packages/digital-humans/install-app/spec.yaml") {
        return textResponse(specYaml)
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const appId = await installFromStore("install-app", "space-1", { threshold: 10 })
    expect(appId).toBe("app-installed-1")

    expect(installSpy).toHaveBeenCalledTimes(1)
    const [spaceId, installedSpec, userConfig] = installSpy.mock.calls[0]
    expect(spaceId).toBe("space-1")
    expect(userConfig).toEqual({ threshold: 10 })
    expect(installedSpec.store).toMatchObject({
      slug: "install-app",
      registry_id: "official",
    })
  })

  it("filters out legacy yaml entries from the merged index", async () => {
    initRegistryService()

    // Deliberately inject legacy format data to verify runtime filtering.
    const index = {
      version: 1,
      generated_at: "2026-02-24T00:00:00.000Z",
      source: "https://openkursar.github.io/digital-human-protocol",
      apps: [
        {
          slug: "legacy-app",
          name: "Legacy App",
          version: "1.0.0",
          author: "tester",
          description: "Legacy format test",
          type: "automation",
          format: "yaml",
          path: "packages/digital-humans/legacy-app.yaml",
          category: "other",
          tags: [],
        },
      ],
    } as unknown as RegistryIndex

    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === "https://openkursar.github.io/digital-human-protocol/index.json") {
        return jsonResponse(index)
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const apps = await listApps()
    expect(apps).toEqual([])

    await expect(installFromStore("legacy-app", "space-1")).rejects.toThrow(
      /app not found in store/i
    )
  })

  describe("registryOverrides (product.json enterprise config)", () => {
    it("redirects the official registry URL when product.json declares an override", () => {
      loadProductConfigMock.mockReturnValue({
        authProviders: [],
        registryOverrides: {
          official: { url: "http://registry.example.internal:18081", name: "Enterprise Registry" },
        },
      })

      initRegistryService()

      const registries = getRegistries()
      const official = registries.find(r => r.id === "official")
      expect(official?.url).toBe("http://registry.example.internal:18081")
      expect(official?.name).toBe("Enterprise Registry")
      // sourceType must be preserved from builtin
      expect(official?.sourceType).toBe("halo")
    })

    it("force-disables registries when product.json sets enabled: false", () => {
      loadProductConfigMock.mockReturnValue({
        authProviders: [],
        registryOverrides: {
          "mcp-official":  { enabled: false },
          "smithery":      { enabled: false },
          "claude-skills": { enabled: false },
        },
      })

      initRegistryService()

      const registries = getRegistries()
      expect(registries.find(r => r.id === "mcp-official")?.enabled).toBe(false)
      expect(registries.find(r => r.id === "smithery")?.enabled).toBe(false)
      expect(registries.find(r => r.id === "claude-skills")?.enabled).toBe(false)
      // official should remain enabled (no override)
      expect(registries.find(r => r.id === "official")?.enabled).toBe(true)
    })

    it("re-enforces overrides on re-init (simulates app restart)", () => {
      loadProductConfigMock.mockReturnValue({
        authProviders: [],
        registryOverrides: {
          official: { url: "http://registry.example.internal:18081" },
        },
      })

      // First startup
      initRegistryService()
      expect(getRegistries().find(r => r.id === "official")?.url).toBe("http://registry.example.internal:18081")

      // Simulate restart
      shutdownRegistryService()
      initRegistryService()

      expect(getRegistries().find(r => r.id === "official")?.url).toBe("http://registry.example.internal:18081")
    })

    it("preserves builtin defaults when registryOverrides is absent (open-source build)", () => {
      loadProductConfigMock.mockReturnValue({ authProviders: [], registryOverrides: undefined })

      initRegistryService()

      const registries = getRegistries()
      const official = registries.find(r => r.id === "official")
      expect(official?.url).toBe("https://openkursar.github.io/digital-human-protocol")
      expect(official?.enabled).toBe(true)
    })

    it("does not override enabled when product.json omits the enabled field", () => {
      loadProductConfigMock.mockReturnValue({
        authProviders: [],
        registryOverrides: {
          // Only override URL, leave enabled untouched
          official: { url: "http://registry.example.internal:18081" },
        },
      })

      initRegistryService()

      // enabled should retain the builtin default (true)
      expect(getRegistries().find(r => r.id === "official")?.enabled).toBe(true)
    })

    it("removes hidden built-in registries entirely (not just disabled)", () => {
      loadProductConfigMock.mockReturnValue({
        authProviders: [],
        registryOverrides: {
          "mcp-official":  { hidden: true },
          "smithery":      { hidden: true },
          "claude-skills": { hidden: true },
        },
      })

      initRegistryService()

      const registries = getRegistries()
      // Hidden registries must NOT appear in the list at all — they are
      // not just disabled, they are absent.
      expect(registries.find(r => r.id === "mcp-official")).toBeUndefined()
      expect(registries.find(r => r.id === "smithery")).toBeUndefined()
      expect(registries.find(r => r.id === "claude-skills")).toBeUndefined()
      // Non-hidden built-ins remain visible.
      expect(registries.find(r => r.id === "official")).toBeDefined()
    })

    it("hidden takes precedence over enabled", () => {
      loadProductConfigMock.mockReturnValue({
        authProviders: [],
        registryOverrides: {
          // Both flags set — hidden wins.
          "smithery": { enabled: true, hidden: true },
        },
      })

      initRegistryService()

      expect(getRegistries().find(r => r.id === "smithery")).toBeUndefined()
    })
  })
})
