import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { instanceKey, variantsFor } from './catalog.mjs'
import { text } from '../../../tests/acceptance/schemas/model.mjs'

const translations = {
  'Halo': 'Halo', 'Acceptance handbook': '产品验收手册', 'Product handbook': '产品手册',
  'What people can rely on': '用户可以依赖什么',
  'User stories, product promises and the evidence behind them.': '从用户故事和产品承诺出发，查看它们背后的验证证据。',
  'This handbook is read-only. Describe a correction or decision to your AI collaborator; it will update the versioned source.': '本手册只读。把修正或决定用自然语言告诉 AI，它会更新随代码保存的源文件。',
  'Modules': '功能模块', 'Stories': '用户故事', 'Scenario variants': '场景变体',
  'Passed in this record': '本记录已通过', 'Catalog': '目录', 'Search': '搜索',
  'Search stories, promises or scenario IDs': '搜索故事、承诺或场景编号',
  'All modules': '全部模块', 'Show': '筛选', 'All stories': '全部故事',
  'Needs confirmation': '待确认', 'Failed or flaky': '失败或不稳定', 'Unverified': '未验证',
  'Clear filters': '清除筛选', 'Expand scenarios': '展开场景', 'Collapse scenarios': '收起场景',
  'stories shown': '个故事符合筛选', 'No matching stories.': '没有符合筛选的故事。',
  'Basis': '依据', 'Human decision': '人工决定', 'Verification': '验证',
  'Documented': '已有文档', 'Observed': '观察所得', 'Proposed': '待讨论提案',
  'Approved': '已确认', 'Rejected': '未接受', 'Approval no longer applies': '原确认已失效',
  'Not individually confirmed': '未单独人工确认',
  'Open scenarios and evidence': '查看场景与证据', 'Back to handbook': '返回手册',
  'Previous story': '上一个故事', 'Next story': '下一个故事',
  'Existing documented or observed behavior can be regression-tested without a new individual approval.': '已有文档或观察所得的基线可以直接回归，无须逐项重新确认。',
  'Documented or observed behavior is not automatically an approved requirement.': '文档或代码中的已有行为，不等于已经确认的产品要求。',
  'Approval applies only to the exact story expectations.': '人工确认只适用于当时的故事要求。',
  'A passing record applies only to its recorded source revision, platform and selected cases.': '通过记录只适用于所记载的代码版本、平台和选中场景。',
  'Promises': '产品承诺', 'Open questions': '待决定的问题', 'Scenarios and evidence': '场景与证据',
  'Source and decision history': '来源与决定记录', 'Source': '来源', 'References': '参考来源',
  'Semantic hash': '要求内容哈希', 'Catalog hash': '目录哈希', 'Manifest hash': '测试清单哈希',
  'No human decision is recorded.': '尚无人工决定记录。', 'Current expectations': '符合当前要求',
  'Previous expectations': '历史要求', 'Reviewer': '确认人', 'Decision date': '决定时间',
  'Declared coverage': '声明覆盖', 'Platforms': '平台', 'Profiles': '执行范围',
  'Evidence boundary': '证据边界', 'Model mode': '模型方式', 'Automation': '自动化状态',
  'Automated': '已有自动化', 'Planned': '待补自动化', 'Manual': '人工验证',
  'UI check': '界面检查', 'Application end-to-end': '应用端到端', 'Integration': '集成验证',
  'Live model': '真实模型', 'External service': '外部服务', 'No model': '不调用模型',
  'Scripted model': '脚本模型', 'Preconditions': '前置条件', 'Steps': '操作步骤',
  'Expected outcome': '预期结果', 'Requirements': '环境前提', 'Verifies': '验证承诺',
  'Notes': '说明', 'Variant': '变体', 'Default': '默认', 'Result': '结果',
  'Passed': '通过', 'Failed': '失败', 'Flaky': '不稳定', 'Skipped': '已跳过',
  'Blocked': '受阻', 'Not run': '未执行', 'Not selected': '本轮未选',
  'Different platform': '其他平台', 'Historical evidence': '历史证据',
  'Incomplete record': '记录不完整', 'Recorded result': '记录结果', 'Attempts': '执行尝试',
  'Attempt': '尝试', 'Duration': '耗时', 'Error': '错误', 'Evidence files': '证据文件',
  'No evidence files were attached.': '没有附加证据文件。', 'Evidence unavailable': '证据不可用',
  'Run directory was not supplied.': '未提供运行目录。',
  'Evidence path is invalid or leaves the run directory.': '证据路径无效或越出运行目录。',
  'Evidence file is missing, is not a regular file, or exceeds the copy limit.': '证据文件缺失、不是普通文件，或超过复制上限。',
  'Evidence could not be copied.': '证据文件无法复制。',
  'No execution record': '暂无执行记录',
  'Catalog only. No scenario is claimed to have passed.': '当前只有目录；不把任何场景视为已经通过。',
  'This execution used a different catalog. Its results are historical and do not verify these expectations.': '该次执行使用了不同版本的目录。结果仅作历史参考，不能验证本页要求。',
  'Run': '运行', 'Run status': '运行状态', 'Revision': '代码版本', 'Local changes': '包含本地改动',
  'Worktree hash': '工作区哈希', 'Platform': '平台', 'Profile': '执行范围',
  'Started': '开始时间', 'Finished': '结束时间', 'Selection': '选测原因',
  'Passed selected instances': '选中实例通过', 'Incomplete': '未完成',
  'Run-level errors': '运行级错误', 'Additional recorded cases': '目录之外的运行记录',
  'These records are not mapped to a current catalog instance and are not counted as verified.': '这些记录无法对应当前目录中的实例，不计入已验证结果。',
  'A required variant has no result in this record.': '此记录中没有该必要变体的结果。',
  'The result does not match this scenario’s model mode or evidence boundary.': '实际记录的模型方式或证据边界与此场景不符。',
  'Duplicate or incomplete result records cannot establish verification.': '重复或不完整的结果记录不能证明已验证。',
  'This platform was not part of the recorded execution.': '此平台不在该次执行范围内。',
  'This result predates the current catalog.': '此结果对应历史版本目录。',
  'Run evidence integrity is missing or failed; recorded attempts are diagnostic only.': '运行证据的完整性检查缺失或失败；执行记录仅用于诊断，不计入已验证结果。',
  'Recorded failures': '记录中的失败', 'Recorded flaky instances': '记录中的不稳定实例',
  'Unverified catalog instances': '目录中尚未验证的实例',
  'Counts describe catalog variants, not every combination of operating systems and profiles.': '数量按目录声明的变体计算，不代表已穷举所有操作系统与执行范围的组合。',
  'No pass percentage is inferred from unselected, manual or planned cases.': '未选、人工及待补自动化场景不会被换算为通过率。',
  'Download summary': '下载摘要', 'Skip to stories': '跳到用户故事',
  'Execution configuration': '执行配置', 'Execution batches': '执行批次', 'Batch': '批次',
  'Build identity': '构建标识', 'Supplied package': '提供的包', 'Not recorded': '未记录',
  'Source build or test host': '源码构建或测试宿主', 'Controlled package supplied': '已提供受控包',
  'Packaged application requested': '请求打包应用',
  'Built application cluster': '应用构建集群',
  'Batch configuration records what the harness supplied. Application observations establish what actually ran.': '批次配置记录测试框架提供了什么；应用观测才能证明实际运行了什么。',
}

const resultLabels = { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', skipped: 'Skipped', blocked: 'Blocked', 'not-run': 'Not run', manual: 'Manual', 'not-selected': 'Not selected', 'different-platform': 'Different platform', historical: 'Historical evidence', invalid: 'Incomplete record' }
const modeLabels = { none: 'No model', scripted: 'Scripted model', live: 'Live model' }
const evidenceLabels = { ui: 'UI check', 'app-e2e': 'Application end-to-end', integration: 'Integration', 'live-model': 'Live model', external: 'External service', manual: 'Manual' }
const automationLabels = { automated: 'Automated', planned: 'Planned', manual: 'Manual' }
const basisLabels = { documented: 'Documented', observed: 'Observed', proposed: 'Proposed' }
const statuses = new Set(['passed', 'failed', 'flaky', 'skipped', 'blocked', 'not-run', 'manual'])
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const markdown = value => escape(String(value ?? '').replace(/[\r\n]+/g, ' ')).replace(/[\\`*_{}[\]()#+!|]/g, '\\$&')
const digest = value => createHash('sha256').update(value).digest('hex')
const within = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }

function approvalFor(catalog, story) {
  const records = catalog.approvals.filter(record => record.storyId === story.id).sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
  const current = records.find(record => record.semanticHash === story.semanticHash)
  return { records, current, state: current?.decision ?? (records.length ? 'outdated' : 'pending') }
}

function resultsFor(catalog, run) {
  const records = new Map()
  for (const item of run?.cases ?? []) {
    const key = instanceKey(item.caseId, item.variant)
    records.set(key, [...(records.get(key) ?? []), item])
  }
  const current = run?.version === 1 && run.catalogHash === catalog.hash
  const evidenceValid = run?.evidenceIntegrity?.version === 1 && run.evidenceIntegrity.valid === true && Array.isArray(run.evidenceIntegrity.reasons) && !run.evidenceIntegrity.reasons.length && !run.errors?.length
  const known = new Set()
  const instances = catalog.cases.flatMap(scenario => variantsFor(scenario).map(variant => {
    const key = instanceKey(scenario.id, variant)
    known.add(key)
    const matches = records.get(key) ?? []
    const record = matches[0]
    let status = scenario.automation === 'manual' ? 'manual' : 'not-run'
    let reason = scenario.automation === 'manual' ? scenario.reason ?? 'A required variant has no result in this record.' : 'A required variant has no result in this record.'
    if (run && !scenario.platforms.includes(run.platform)) { status = 'different-platform'; reason = 'This platform was not part of the recorded execution.' }
    else if (record && !current) { status = 'historical'; reason = 'This result predates the current catalog.' }
    else if (record?.attempts?.length && !evidenceValid) { status = 'invalid'; reason = 'Run evidence integrity is missing or failed; recorded attempts are diagnostic only.' }
    else if (matches.length > 1 || (record && (!statuses.has(record.status) || (record.status === 'passed' && (!record.attempts?.length || record.attempts.some(attempt => attempt.status !== 'passed')))))) { status = 'invalid'; reason = 'Duplicate or incomplete result records cannot establish verification.' }
    else if (record && (record.mode !== scenario.mode || record.evidence !== scenario.evidence)) { status = 'invalid'; reason = 'The result does not match this scenario’s model mode or evidence boundary.' }
    else if (record) { status = record.status; reason = record.reason ?? record.blockedReason ?? '' }
    else if (run && scenario.automation !== 'manual') status = 'not-selected'
    return { scenario, variant, key, record, status, reason, current }
  }))
  const additional = (run?.cases ?? []).filter(item => !known.has(instanceKey(item.caseId, item.variant)))
  return { instances, additional, current, evidenceValid }
}

const css = `
:root{color-scheme:light dark;--background:Canvas;--foreground:CanvasText;--primary:LinkText;--muted:color-mix(in srgb,CanvasText 58%,Canvas);--border:color-mix(in srgb,CanvasText 16%,Canvas);--panel:color-mix(in srgb,CanvasText 3%,Canvas);--accent:color-mix(in srgb,LinkText 9%,Canvas);--attention:color-mix(in srgb,LinkText 16%,Canvas);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--foreground);background:var(--background)}
*{box-sizing:border-box}body{margin:0}a{color:var(--primary);text-underline-offset:.2em}button,input,select{font:inherit}button,select,input{border:1px solid var(--border);border-radius:.5rem;padding:.55rem .75rem;background:var(--background);color:var(--foreground)}button{cursor:pointer}button:hover{background:var(--accent)}:focus-visible{outline:3px solid var(--primary);outline-offset:3px}h1,h2,h3,h4,p{margin:0}h1{font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.2;letter-spacing:-.04em}h2{font-size:1.5rem}h3{font-size:1.22rem;line-height:1.45}h4{font-size:1rem}.muted,.secondary{color:var(--muted)}.secondary{display:block;font-size:.85em;font-weight:400;line-height:1.55;margin-top:.25rem}.mono,code{font: .8rem/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.eyebrow{font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--primary);margin-bottom:.7rem}.skip{position:absolute;left:-100vw}.skip:focus{left:1rem;top:1rem;background:var(--background);padding:1rem;z-index:10}.page{max-width:1480px;margin:auto;padding:3rem 2rem 5rem}.hero{display:flex;gap:1.5rem;align-items:flex-start;justify-content:space-between}.hero p{max-width:58rem;margin-top:1rem}.hero a{white-space:nowrap;font-size:.9rem}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin:2rem 0}.metric{padding:1rem 1.25rem;border:1px solid var(--border);border-radius:.7rem}.metric strong{display:block;font-size:1.9rem;line-height:1.3;font-weight:650}.metric span{font-size:.85rem;color:var(--muted)}.explanation{display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem;margin:1.4rem 0 2rem}.explanation dt{font-weight:650;margin-bottom:.25rem}.explanation dd{margin:0;font-size:.87rem;color:var(--muted)}.record{border-left:3px solid var(--primary);background:var(--panel);padding:1.1rem 1.25rem;margin:1.5rem 0;border-radius:0 .6rem .6rem 0}.record p+p{margin-top:.5rem}.record dl{margin:1rem 0 0}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.7rem 1.2rem}.facts dt{font-size:.75rem;color:var(--muted)}.facts dd{margin:0;font-size:.85rem;overflow-wrap:anywhere}.workspace{display:grid;grid-template-columns:225px minmax(0,1fr);gap:2.5rem;margin-top:2rem}.rail{position:sticky;top:1.5rem;align-self:start;max-height:calc(100vh - 3rem);overflow:auto}.rail h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;margin-bottom:1rem;color:var(--muted)}.rail a{display:flex;justify-content:space-between;gap:.6rem;text-decoration:none;color:var(--foreground);padding:.5rem .7rem;border-radius:.4rem;font-size:.88rem}.rail a:hover{background:var(--accent)}.rail small{color:var(--muted);font-variant-numeric:tabular-nums}.controls{display:grid;grid-template-columns:minmax(180px,2fr) minmax(130px,1fr) minmax(130px,1fr);gap:.7rem;margin-bottom:.8rem}.controls label{display:grid;gap:.25rem;font-size:.78rem;color:var(--muted)}.controls input,.controls select{width:100%;min-width:0;font-size:.9rem;color:var(--foreground)}.tools{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1.7rem}.tools button{font-size:.78rem;padding:.35rem .6rem}.tools output{margin-left:auto;font-size:.8rem;color:var(--muted)}.module{scroll-margin-top:1.5rem;margin-bottom:3rem}.module-heading{padding-bottom:1.2rem;border-bottom:2px solid var(--border);margin-bottom:1.2rem}.module-heading>p{margin-top:.5rem;color:var(--muted);font-size:.9rem}.scope{margin-top:.8rem;font-size:.83rem}.story{border:1px solid var(--border);border-radius:.75rem;margin:1rem 0;padding:1.5rem;background:var(--background)}.story-id{display:block;font-size:.73rem;color:var(--muted);margin-bottom:.4rem}.story-statement{font-size:1.05rem;margin:1rem 0 1.2rem;padding-left:1rem;border-left:2px solid var(--border)}.truth{display:flex;gap:1rem 1.5rem;flex-wrap:wrap;margin:1rem 0 1.4rem}.truth>div{display:grid;gap:.3rem}.truth dt{font-size:.72rem;color:var(--muted)}.truth dd{margin:0}.badge{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:.1rem .55rem;font-size:.75rem;line-height:1.5;background:var(--panel)}.badge.passed{border-color:var(--primary);background:var(--accent)}.badge.failed,.badge.flaky,.badge.invalid,.badge.rejected{border:2px solid var(--primary);font-weight:700;background:var(--attention)}.badge.historical,.badge.outdated{border-style:dashed}.section-label{font-size:.78rem;letter-spacing:.03em;color:var(--muted);margin:1rem 0 .4rem}.promises{margin:.3rem 0 1.4rem;padding-left:1.4rem}.promises li+li{margin-top:.6rem}.questions{border:1px dashed var(--border);padding:.8rem 1rem;border-radius:.5rem;margin:1rem 0}.questions h4{font-size:.85rem}.questions ul{padding-left:1.2rem;margin:.4rem 0 0;font-size:.9rem}details{border-top:1px solid var(--border);padding-top:.7rem;margin-top:.7rem}summary{cursor:pointer;font-size:.88rem;font-weight:600;list-style-position:outside;margin-left:1.1rem}summary:hover{color:var(--primary)}.scenario{padding:1.1rem 0}.scenario+.scenario{border-top:1px solid var(--border)}.scenario .facts{margin:.8rem 0}.flow{display:grid;grid-template-columns:1fr 1fr;gap:1rem;font-size:.85rem}.flow ul,.flow ol{margin:.35rem 0;padding-left:1.2rem}.flow li+li{margin-top:.35rem}.flow .expected{grid-column:1/-1;background:var(--panel);padding:.7rem 1rem;border-radius:.4rem}.instances{display:grid;gap:.5rem;margin-top:.7rem}.instance{border:1px solid var(--border);border-radius:.5rem;padding:.8rem}.instance-head{display:flex;gap:.75rem;justify-content:space-between;align-items:flex-start}.instance .reason{font-size:.82rem;color:var(--muted);margin-top:.35rem}.attempt{margin:.6rem 0;padding:.65rem;background:var(--panel);border-radius:.4rem}.attempt p{font-size:.8rem}.error{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.78rem;max-height:18rem;overflow:auto;border:1px solid var(--border);padding:.65rem;background:var(--background)}.evidence{padding-left:1.25rem;font-size:.82rem}.evidence li{margin:.3rem 0}.history{font-size:.8rem;color:var(--muted)}.history ul{padding-left:1.25rem}.history li+li{margin-top:.5rem}.empty{padding:2rem;text-align:center;border:1px dashed var(--border);border-radius:.6rem}.footer{margin-top:3rem;font-size:.78rem;color:var(--muted);overflow-wrap:anywhere}[hidden]{display:none!important}
@media(max-width:960px){.page{padding:2rem 1.2rem 4rem}.workspace{display:block}.rail{display:none}.explanation{gap:1rem}.hero{display:block}.hero>a{display:inline-block;margin-top:1rem}}
@media(max-width:600px){.page{padding:1.5rem .8rem 3rem}.metrics{grid-template-columns:1fr 1fr;gap:.6rem;margin:1.4rem 0}.metric{padding:.8rem}.metric strong{font-size:1.6rem}.explanation{grid-template-columns:1fr;gap:.7rem;margin:1rem 0}.explanation div{border-bottom:1px solid var(--border);padding-bottom:.6rem}.controls{grid-template-columns:1fr 1fr}.controls label:first-child{grid-column:1/-1}.story{padding:1rem}.truth{gap:.7rem}.flow{grid-template-columns:1fr}.facts{grid-template-columns:1fr 1fr}.tools output{width:100%;margin:.2rem 0 0}.hero p{font-size:.9rem}.record{padding:.9rem}.instance-head{flex-wrap:wrap}}
@media print{.rail,.controls,.tools,.hero>a,.skip{display:none}.page{padding:0;max-width:none}.workspace{display:block}.story{break-inside:avoid}.record,.metric,.story{box-shadow:none}details{display:block}.footer{margin-top:1rem}}
`

const script = `
(() => {
  const search = document.getElementById('search');
  const module = document.getElementById('module-filter');
  const filter = document.getElementById('status-filter');
  const stories = Array.from(document.querySelectorAll('[data-story]'));
  const apply = () => {
    const query = search.value.trim().toLocaleLowerCase();
    let shown = 0;
    for (const story of stories) {
      const visible = (!query || story.dataset.search.includes(query)) && (!module.value || story.dataset.module === module.value) && (!filter.value || story.dataset[filter.value] === 'true');
      story.hidden = !visible;
      if (visible) shown++;
    }
    for (const section of document.querySelectorAll('[data-module-section]')) section.hidden = !Array.from(section.querySelectorAll('[data-story]')).some(story => !story.hidden);
    document.getElementById('result-count').textContent = String(shown);
    document.getElementById('empty').hidden = shown > 0;
  };
  search.addEventListener('input', apply);
  module.addEventListener('change', apply);
  filter.addEventListener('change', apply);
  document.getElementById('clear').addEventListener('click', () => { search.value = ''; module.value = ''; filter.value = ''; apply(); search.focus(); });
  for (const link of document.querySelectorAll('[data-module-link]')) link.addEventListener('click', () => { module.value = link.dataset.moduleLink; search.value = ''; filter.value = ''; apply(); });
  apply();
})();
`

export async function generateReport(root, catalog, run, output, { locale = 'zh', runDirectory } = {}) {
  if (!['zh', 'en'].includes(locale)) throw new Error('Report locale must be zh or en')
  const t = value => locale === 'zh' ? translations[value] ?? value : value
  const title = value => escape(text(value, locale))
  const bilingual = value => {
    const primary = text(value, locale)
    const secondary = typeof value === 'object' && value ? text(value, locale === 'zh' ? 'en' : 'zh') : ''
    return escape(primary) + (secondary && secondary !== primary ? `<span class="secondary" lang="${locale === 'zh' ? 'en' : 'zh-CN'}">${escape(secondary)}</span>` : '')
  }
  const label = value => escape(t(value))
  const badge = (value, state = '') => `<span class="badge ${escape(state)}">${label(value)}</span>`
  const list = values => `<ul>${values.map(value => `<li>${bilingual(value)}</li>`).join('')}</ul>`
  const facts = items => `<dl class="facts">${items.filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => `<div><dt>${label(name)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`
  const hostName = host => t({ source: 'Source build or test host', packaged: host?.packageId ? 'Controlled package supplied' : 'Packaged application requested', cluster: 'Built application cluster' }[host?.kind] ?? 'Not recorded')
  const hostFacts = host => facts([['Execution configuration', hostName(host)], ['Batch', host?.batchId], ['Build identity', host?.buildId], ['Supplied package', host?.packageId]])
  const result = resultsFor(catalog, run)
  const total = result.instances.length
  const passed = result.instances.filter(item => item.status === 'passed').length
  const failed = result.instances.filter(item => item.status === 'failed').length
  const flaky = result.instances.filter(item => item.status === 'flaky').length
  const decisions = new Map(catalog.stories.map(story => [story.id, approvalFor(catalog, story)]))
  const destination = path.resolve(output)
  await fs.mkdir(destination, { recursive: true })
  let runRoot
  if (runDirectory) {
    try { runRoot = await fs.realpath(path.resolve(runDirectory)) }
    catch { console.warn('acceptance report: the supplied run directory is unavailable; evidence links will be disabled') }
  }
  const evidenceCache = new Map()
  const evidence = async attachment => {
    const name = attachment.name || path.basename(String(attachment.path ?? '')) || t('Evidence files')
    const unavailable = reason => `<li>${escape(name)} — ${label('Evidence unavailable')}: ${label(reason)}</li>`
    if (!runRoot) return unavailable('Run directory was not supplied.')
    if (typeof attachment.path !== 'string' || !attachment.path || attachment.path.includes('\0') || /^[a-z]+:\/\//i.test(attachment.path)) return unavailable('Evidence path is invalid or leaves the run directory.')
    const candidate = path.resolve(runRoot, attachment.path)
    if (evidenceCache.has(candidate)) {
      const cached = evidenceCache.get(candidate)
      return cached.href ? `<li><a href="../${cached.href}" download>${escape(name)}</a></li>` : unavailable(cached.reason)
    }
    try {
      const stat = await fs.lstat(candidate)
      const real = await fs.realpath(candidate)
      if (!within(runRoot, real)) return unavailable('Evidence path is invalid or leaves the run directory.')
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) return unavailable('Evidence file is missing, is not a regular file, or exceeds the copy limit.')
      const bytes = await fs.readFile(real)
      const extension = path.extname(candidate).toLowerCase()
      const safeExtension = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.log', '.json', '.jsonl', '.zip', '.webm', '.mp4'].includes(extension) ? extension : '.txt'
      const filename = `${digest(bytes)}${safeExtension}`
      const evidenceDirectory = path.join(destination, 'evidence')
      await fs.mkdir(evidenceDirectory, { recursive: true })
      if (!(await fs.lstat(evidenceDirectory)).isDirectory() || !within(await fs.realpath(destination), await fs.realpath(evidenceDirectory))) throw new Error('Unsafe evidence output directory')
      const evidenceFile = path.join(evidenceDirectory, filename)
      await fs.writeFile(evidenceFile, bytes, { flag: 'wx' }).catch(async error => {
        if (error.code !== 'EEXIST') throw error
        if (!(await fs.lstat(evidenceFile)).isFile() || digest(await fs.readFile(evidenceFile)) !== digest(bytes)) throw new Error('Existing evidence output does not match its content hash')
      })
      const href = `evidence/${filename}`
      evidenceCache.set(candidate, { href })
      return `<li><a href="../${href}" download>${escape(name)}</a></li>`
    } catch (error) {
      const reason = error.code === 'ENOENT' ? 'Evidence file is missing, is not a regular file, or exceeds the copy limit.' : 'Evidence could not be copied.'
      evidenceCache.set(candidate, { reason })
      console.warn(`acceptance report: evidence unavailable (${error.code ?? 'copy failure'})`)
      return unavailable(reason)
    }
  }

  const renderInstance = async instance => {
    const { variant, record, status } = instance
    const variantText = Object.keys(variant).length ? Object.entries(variant).map(([name, value]) => `${name}: ${value}`).join(' · ') : t('Default')
    let attempts = ''
    if (record) {
      const rendered = []
      for (const [index, attempt] of (record.attempts ?? []).entries()) {
        const attachments = await Promise.all((attempt.attachments ?? []).map(evidence))
        rendered.push(`<div class="attempt"><p>${label('Attempt')} ${index + 1} · ${escape(t(resultLabels[attempt.status] ?? attempt.status))} · ${label('Duration')}: ${escape(attempt.duration ?? '—')} ms</p>${hostFacts(attempt.executionHost)}${(attempt.errors ?? []).map(error => `<pre class="error">${escape(typeof error === 'string' ? error : error.message ?? JSON.stringify(error))}</pre>`).join('')}${attachments.length ? `<ul class="evidence">${attachments.join('')}</ul>` : ''}</div>`)
      }
      attempts = `<details><summary>${label('Recorded result')} · ${escape(t(resultLabels[record.status] ?? record.status))}</summary>${facts([['Evidence boundary', t(evidenceLabels[record.evidence] ?? record.evidence)], ['Model mode', t(modeLabels[record.mode] ?? record.mode)]])}${rendered.join('') || `<p class="muted">${label('No evidence files were attached.')}</p>`}</details>`
    }
    return `<div class="instance" data-case-status="${escape(status)}"><div class="instance-head"><span class="mono">${escape(variantText)}</span>${badge(resultLabels[status], status)}</div>${instance.reason ? `<p class="reason">${escape(translations[instance.reason] ? t(instance.reason) : text(instance.reason, locale))}</p>` : ''}${attempts}</div>`
  }

  const renderScenario = async scenario => {
    const instances = result.instances.filter(item => item.scenario.id === scenario.id)
    const steps = scenario.steps?.length ? `<div><h4>${label('Steps')}</h4><ol>${scenario.steps.map(value => `<li>${bilingual(value)}</li>`).join('')}</ol></div>` : ''
    return `<section class="scenario"><h4>${bilingual(scenario.title)}</h4><code>${escape(scenario.id)}</code>${facts([
      ['Platforms', scenario.platforms.join(' · ')], ['Profiles', scenario.profiles.join(' · ')],
      ['Evidence boundary', t(evidenceLabels[scenario.evidence])], ['Model mode', t(modeLabels[scenario.mode])],
      ['Automation', t(automationLabels[scenario.automation])], ['Verifies', scenario.verifies.join(' · ')],
    ])}<div class="flow">${scenario.preconditions?.length ? `<div><h4>${label('Preconditions')}</h4>${list(scenario.preconditions)}</div>` : ''}${steps}${scenario.expected?.length ? `<div class="expected"><h4>${label('Expected outcome')}</h4>${list(scenario.expected)}</div>` : ''}</div>${scenario.reason ? `<p class="reason">${bilingual(scenario.reason)}</p>` : ''}${scenario.notes ? `<p class="reason">${bilingual(scenario.notes)}</p>` : ''}${scenario.requirements?.length ? `<p class="section-label">${label('Requirements')}: <code>${escape(scenario.requirements.join(' · '))}</code></p>` : ''}<div class="instances">${(await Promise.all(instances.map(renderInstance))).join('')}</div></section>`
  }

  const renderStory = async (story, { summaryOnly = false } = {}) => {
    const decision = decisions.get(story.id)
    const instances = result.instances.filter(item => item.scenario.storyId === story.id)
    const verified = instances.length > 0 && instances.every(item => item.status === 'passed')
    const hasFailure = instances.some(item => ['failed', 'flaky'].includes(item.status))
    const approvalLabel = { approved: 'Approved', rejected: 'Rejected', outdated: 'Approval no longer applies', pending: 'Not individually confirmed' }[decision.state]
    const verificationLabel = verified ? 'Passed' : hasFailure ? 'Failed or flaky' : 'Unverified'
    const scenarios = catalog.cases.filter(item => item.storyId === story.id)
    const searchable = JSON.stringify([story.id, story.title, story.story, story.resolvedPromises, story.questions, scenarios.map(scenario => [scenario.id, scenario.title])]).toLocaleLowerCase()
    const needsDecision = story.questions.length > 0 || story.basis === 'proposed' || ['outdated', 'rejected'].includes(decision.state)
    const history = decision.records.map(record => `<li>${badge(record.decision === 'approved' ? 'Approved' : 'Rejected', record.decision)} ${escape(record.reviewer)} · ${escape(record.decidedAt)} · ${label(record.semanticHash === story.semanticHash ? 'Current expectations' : 'Previous expectations')}${record.note ? `<p>${escape(record.note)}</p>` : ''}</li>`).join('')
    const detail = summaryOnly
      ? `<p><a href="stories/${encodeURIComponent(story.id)}.html">${label('Open scenarios and evidence')} · ${scenarios.length} →</a></p>`
      : `<details class="scenarios" open><summary>${label('Scenarios and evidence')} · ${scenarios.length}</summary>${(await Promise.all(scenarios.map(renderScenario))).join('')}</details><details class="history"><summary>${label('Source and decision history')}</summary>${facts([['Source', story.source], ['Semantic hash', story.semanticHash]])}<h4 class="section-label">${label('References')}</h4><ul>${story.references.map(reference => `<li><code>${escape(reference)}</code></li>`).join('')}</ul>${history ? `<ul>${history}</ul>` : `<p>${label('No human decision is recorded.')}</p>`}</details>`
    return `<article class="story" id="story-${escape(story.id)}" data-story="${escape(story.id)}" data-module="${escape(story.module)}" data-pending="${needsDecision}" data-failed="${hasFailure}" data-unverified="${!verified}" data-verification="${verified ? 'passed' : 'unverified'}" data-search="${escape(searchable)}"><span class="story-id mono">${escape(story.id)}</span><h3>${bilingual(story.title)}</h3><p class="story-statement">${bilingual(story.story)}</p><dl class="truth"><div><dt>${label('Basis')}</dt><dd>${badge(basisLabels[story.basis])}</dd></div><div><dt>${label('Human decision')}</dt><dd>${badge(approvalLabel, decision.state)}</dd></div><div><dt>${label('Verification')}</dt><dd>${badge(verificationLabel, verified ? 'passed' : hasFailure ? 'failed' : '')}</dd></div></dl><h4 class="section-label">${label('Promises')}</h4><ol class="promises">${Object.values(story.resolvedPromises ?? story.promises).map(value => `<li>${bilingual(value)}</li>`).join('')}</ol>${story.questions.length ? `<div class="questions"><h4>${label('Open questions')}</h4>${list(story.questions)}</div>` : ''}${detail}</article>`
  }

  const modules = []
  for (const module of catalog.modules) {
    const stories = catalog.stories.filter(story => story.module === module.id)
    modules.push(`<section class="module" id="module-${escape(module.id)}" data-module-section="${escape(module.id)}"><header class="module-heading"><h2>${bilingual(module.title)}</h2><p>${bilingual(module.description)}</p><div class="scope"><strong>${label('Declared coverage')}: </strong>${bilingual(module.scope)}</div></header>${(await Promise.all(stories.map(story => renderStory(story, { summaryOnly: true })))).join('')}</section>`)
  }
  const runStatus = run ? t(run.status === 'passed' && !result.evidenceValid ? 'Incomplete record' : { passed: 'Passed selected instances', failed: 'Failed', incomplete: 'Incomplete' }[run.status] ?? 'Incomplete record') : t('No execution record')
  const runDetails = run ? facts([
    ['Run', run.id], ['Run status', runStatus], ['Revision', typeof run.revision === 'string' ? run.revision : run.revision?.commit],
    ['Local changes', run.revision?.dirty ? t('Local changes') : undefined], ['Worktree hash', run.revision?.worktreeHash],
    ['Platform', run.platform], ['Profile', run.profile], ['Started', run.startedAt], ['Finished', run.finishedAt],
    ['Selection', run.selectionReason], ['Catalog hash', run.catalogHash], ['Manifest hash', run.manifestHash],
  ]) : ''
  const batchDetails = run?.executionBatches?.length ? `<details><summary>${label('Execution batches')} · ${run.executionBatches.length}</summary><p>${label('Batch configuration records what the harness supplied. Application observations establish what actually ran.')}</p>${run.executionBatches.map(batch => `<div class="attempt">${hostFacts({ ...batch.executionHost, batchId: batch.id })}${facts([['Result', t({ completed: 'Finished', failed: 'Failed', 'not-run': 'Not run', running: 'Started' }[batch.status] ?? 'Not recorded')], ['Started', batch.startedAt], ['Finished', batch.finishedAt]])}</div>`).join('')}</details>` : ''
  const old = run && !result.current
  const record = `<section class="record"><strong>${label(old ? 'Historical evidence' : run ? 'Run' : 'No execution record')}</strong><p>${label(old ? 'This execution used a different catalog. Its results are historical and do not verify these expectations.' : run ? 'A passing record applies only to its recorded source revision, platform and selected cases.' : 'Catalog only. No scenario is claimed to have passed.')}</p>${run && !result.evidenceValid ? `<p>${label('Run evidence integrity is missing or failed; recorded attempts are diagnostic only.')}</p>` : ''}${runDetails}${batchDetails}${run?.errors?.length ? `<details><summary>${label('Run-level errors')} · ${run.errors.length}</summary>${run.errors.map(error => `<pre class="error">${escape(error)}</pre>`).join('')}</details>` : ''}</section>`
  const csp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; img-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`
  const storyDirectory = path.join(destination, 'stories')
  await fs.mkdir(storyDirectory, { recursive: true })
  if (!(await fs.lstat(storyDirectory)).isDirectory()) throw new Error('The report story directory must not be a symbolic link')
  const generatedPages = []
  for (const [position, story] of catalog.stories.entries()) {
    const name = `${encodeURIComponent(story.id)}.html`
    const adjacent = [[catalog.stories[position - 1], 'Previous story'], [catalog.stories[position + 1], 'Next story']]
      .filter(([item]) => item).map(([item, direction]) => `<a href="${encodeURIComponent(item.id)}.html">${label(direction)}: ${title(item.title)}</a>`).join('')
    const page = `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><title>${title(story.title)} · ${label('Acceptance handbook')}</title><style>${css}</style></head><body><div class="page"><header class="hero"><div><div class="eyebrow">${label('Halo')} / ${label('Scenarios and evidence')}</div><a href="../index.html#story-${escape(story.id)}">← ${label('Back to handbook')}</a></div></header><main>${await renderStory(story)}</main>${record}<nav class="tools" aria-label="${label('Stories')}">${adjacent}</nav><footer class="footer"><p>${label('This handbook is read-only. Describe a correction or decision to your AI collaborator; it will update the versioned source.')}</p><p>${label('Catalog hash')}: <code>${escape(catalog.hash)}</code></p></footer></div></body></html>`
    await fs.writeFile(path.join(storyDirectory, name), page)
    generatedPages.push(`stories/${name}`)
  }
  const html = `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><title>${label('Halo')} · ${label('Acceptance handbook')}</title><style>${css}</style></head><body><a class="skip" href="#stories">${label('Skip to stories')}</a><div class="page"><header class="hero"><div><div class="eyebrow">${label('Halo')} / ${label('Product handbook')}</div><h1>${label('What people can rely on')}</h1><p class="muted">${label('User stories, product promises and the evidence behind them.')}</p></div><a href="summary.md" download>${label('Download summary')} ↗</a></header><div class="metrics">${[['Modules', catalog.modules.length], ['Stories', catalog.stories.length], ['Scenario variants', total], ['Passed in this record', passed]].map(([name, count]) => `<div class="metric"><strong>${count}</strong><span>${label(name)}</span></div>`).join('')}</div><p class="muted">${label('Counts describe catalog variants, not every combination of operating systems and profiles.')}</p><dl class="explanation"><div><dt>${label('Basis')}</dt><dd>${label('Documented or observed behavior is not automatically an approved requirement.')}</dd></div><div><dt>${label('Human decision')}</dt><dd>${label('Approval applies only to the exact story expectations.')}</dd></div><div><dt>${label('Verification')}</dt><dd>${label('A passing record applies only to its recorded source revision, platform and selected cases.')}</dd></div></dl>${record}<div class="workspace"><nav class="rail" aria-label="${label('Modules')}"><h2>${label('Modules')}</h2>${catalog.modules.map(module => `<a href="#module-${escape(module.id)}" data-module-link="${escape(module.id)}"><span>${title(module.title)}</span><small>${catalog.stories.filter(story => story.module === module.id).length}</small></a>`).join('')}</nav><main id="stories"><div class="controls"><label>${label('Search')}<input id="search" type="search" placeholder="${label('Search stories, promises or scenario IDs')}" autocomplete="off"></label><label>${label('Modules')}<select id="module-filter"><option value="">${label('All modules')}</option>${catalog.modules.map(module => `<option value="${escape(module.id)}">${title(module.title)}</option>`).join('')}</select></label><label>${label('Show')}<select id="status-filter"><option value="">${label('All stories')}</option><option value="pending">${label('Needs confirmation')}</option><option value="failed">${label('Failed or flaky')}</option><option value="unverified">${label('Unverified')}</option></select></label></div><div class="tools"><button id="clear" type="button">${label('Clear filters')}</button><output aria-live="polite"><span id="result-count">${catalog.stories.length}</span> / ${catalog.stories.length} ${label('stories shown')}</output></div><p class="empty" id="empty" hidden>${label('No matching stories.')}</p>${modules.join('')}${result.additional.length ? `<details class="history"><summary>${label('Additional recorded cases')} · ${result.additional.length}</summary><p>${label('These records are not mapped to a current catalog instance and are not counted as verified.')}</p><ul>${result.additional.map(item => `<li><code>${escape(item.caseId)}</code> · ${escape(t(resultLabels[item.status] ?? item.status))}</li>`).join('')}</ul></details>` : ''}</main></div><footer class="footer"><p>${label('This handbook is read-only. Describe a correction or decision to your AI collaborator; it will update the versioned source.')}</p><p>${label('No pass percentage is inferred from unselected, manual or planned cases.')}</p><p>${label('Existing documented or observed behavior can be regression-tested without a new individual approval.')}</p><p>${label('Catalog hash')}: <code>${escape(catalog.hash)}</code></p></footer></div><script>${script}</script></body></html>`
  const summaryLines = [`# ${t('Acceptance handbook')}`, '', `${t('Modules')}: ${catalog.modules.length} · ${t('Stories')}: ${catalog.stories.length} · ${t('Scenario variants')}: ${total}`, '',
    `- ${t('Passed in this record')}: ${passed}`, `- ${t('Recorded failures')}: ${failed}`, `- ${t('Recorded flaky instances')}: ${flaky}`, `- ${t('Unverified catalog instances')}: ${total - passed}`, '',
    t('Counts describe catalog variants, not every combination of operating systems and profiles.'), '',
    old ? t('This execution used a different catalog. Its results are historical and do not verify these expectations.') : run ? `${t('Run status')}: ${markdown(runStatus)}` : t('Catalog only. No scenario is claimed to have passed.'), '',
    `${t('Catalog hash')}: ${markdown(catalog.hash)}`]
  if (run) summaryLines.push(`${t('Revision')}: ${markdown(typeof run.revision === 'string' ? run.revision : run.revision?.commit)}`, `${t('Platform')}: ${markdown(run.platform)} · ${t('Profile')}: ${markdown(run.profile)}`, `${t('Run')}: ${markdown(run.id)}`, `${t('Selection')}: ${markdown(run.selectionReason)}`)
  if (run?.executionBatches?.length) summaryLines.push('', t('Batch configuration records what the harness supplied. Application observations establish what actually ran.'), ...run.executionBatches.map(batch => `- ${t('Batch')} ${markdown(batch.id)}: ${markdown(hostName(batch.executionHost))}${batch.executionHost?.packageId ? ` · ${t('Supplied package')}: ${markdown(batch.executionHost.packageId)}` : ''}`))
  if (run && !result.evidenceValid) summaryLines.push('', t('Run evidence integrity is missing or failed; recorded attempts are diagnostic only.'))
  summaryLines.push('', `## ${t('Human decision')}`, '')
  for (const story of catalog.stories) {
    const state = decisions.get(story.id).state
    summaryLines.push(`- ${markdown(text(story.title, locale))}: ${t({ approved: 'Approved', rejected: 'Rejected', outdated: 'Approval no longer applies', pending: 'Not individually confirmed' }[state])}`)
  }
  const index = path.join(destination, 'index.html')
  const summary = path.join(destination, 'summary.md')
  await fs.writeFile(index, html)
  await fs.writeFile(summary, summaryLines.join('\n') + '\n')
  const pageIndex = path.join(destination, '.handbook-pages.json')
  let previousPages = []
  try { previousPages = JSON.parse(await fs.readFile(pageIndex, 'utf8')).pages ?? [] }
  catch (error) { if (error.code !== 'ENOENT') console.warn('acceptance report: the previous generated-page index could not be read; old pages were preserved') }
  for (const oldPage of previousPages) {
    if (typeof oldPage === 'string' && /^stories\/[a-z][a-z0-9.-]*\.html$/.test(oldPage) && !oldPage.includes('..') && !generatedPages.includes(oldPage)) await fs.rm(path.join(destination, oldPage), { force: true })
  }
  await fs.writeFile(pageIndex, JSON.stringify({ version: 1, catalogHash: catalog.hash, pages: generatedPages }, null, 2) + '\n')
  return { index, summary }
}
