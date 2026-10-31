import type { HaloAPI } from '../../../src/preload'
import {
  test, expect, catalogPerson, registryName, localizationAcceptance, chooseLocale, expectLocaleRestored,
  chatJourney, peopleJourney, teamJourney, settingsJourney, storeJourney, knowledgeJourney,
  type Locale, type LocalizedSurface, type LocalizationJourney,
} from '../fixtures/acceptance-localization'

test.setTimeout(180000)
test.use({ registryCatalog: { sources: [{ id: 'localization-source', name: registryName, resources: [catalogPerson] }] } })

for (const surface of ['chat', 'people', 'team-task', 'settings', 'store', 'knowledge'] as const satisfies readonly LocalizedSurface[]) {
  test(`${surface} switches system labels and its real failure state without rewriting user-authored content`, localizationAcceptance(surface), async ({ registryApp, registry, window }, info) => {
    let page = window
    let journey: LocalizationJourney | undefined
    const completed: Array<{ language: Locale; application: 'original' | 'reopened'; storedDataUnchanged: boolean }> = []
    try {
      await page.setViewportSize({ width: 1600, height: 1000 })
      await chooseLocale(page, 'en', 'en')
      if (surface === 'chat') journey = await chatJourney(page, registryApp.profile)
      else if (surface === 'people') journey = await peopleJourney(page)
      else if (surface === 'team-task') journey = await teamJourney(page)
      else if (surface === 'settings') journey = await settingsJourney(page)
      else if (surface === 'store') journey = await storeJourney(page)
      else {
        const prepared = await knowledgeJourney(page, registryApp)
        page = prepared.page
        await page.setViewportSize({ width: 1600, height: 1000 })
        journey = prepared.journey
      }
      let language: Locale = 'en'
      await journey.exercise(page, language)
      await journey.persisted(page)
      completed.push({ language, application: 'original', storedDataUnchanged: true })
      for (const next of ['zh-CN', 'en'] as const) {
        await chooseLocale(page, language, next)
        language = next
        await journey.exercise(page, language)
        await journey.persisted(page)
        completed.push({ language, application: 'original', storedDataUnchanged: true })
      }
      await chooseLocale(page, language, 'zh-CN')
      page = await registryApp.restart()
      await page.setViewportSize({ width: 1600, height: 1000 })
      await expectLocaleRestored(page, 'zh-CN')
      await journey.exercise(page, 'zh-CN', true)
      await journey.persisted(page)
      completed.push({ language: 'zh-CN', application: 'reopened', storedDataUnchanged: true })
      await journey.finish?.(page, 'zh-CN')
      const config = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getConfig())
      expect(config).toMatchObject({ success: true, data: { api: { apiKey: '' }, aiSources: { version: 2, currentId: null, sources: [] } } })
      expect(registry.requests.every(request => request.method === 'GET')).toBe(true)
    } finally {
      await info.attach('localization-user-outcome-evidence', { body: JSON.stringify({
        surface, evidence: 'ui', modelMode: 'none', preparationComplete: Boolean(journey), identities: journey?.identities ?? null, completed,
        failureStates: { chat: 'A real dropped corrupt PNG fails browser decoding', people: 'An empty name fails actual form validation',
          'team-task': 'The actual invitation operation refuses disabled Remote Access', settings: 'An unsupported proxy protocol fails validation',
          store: 'A real local-catalog installation form refuses missing required configuration', knowledge: 'An actual previously running native folder watcher becomes unavailable after its owned folder is renamed' }[surface],
        limits: 'Representative English and Simplified Chinese paths; no claim about all translations, other languages, native file-picker dialogs, live-model errors or draft persistence across application restart.',
      }, null, 2), contentType: 'application/json' })
    }
  })
}
