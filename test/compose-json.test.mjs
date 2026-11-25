import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BRIEF_TAGS,
  FORUM_TAGS,
  canonicalPickId,
  topLevelJsonObjects,
  jsonObjectCandidates,
  takeBriefSelection,
  default as mod,
} from '../index.mjs'

const OBSERVED_CLASS = "Expected ',' or ']' after array element in JSON at position 104"

const items = [
  { title: '源标题甲', url: 'https://news.example/a', source: '知乎热榜' },
  { title: '源标题乙', url: 'https://news.example/b', source: '微博热搜' },
  { title: '源标题丙', url: 'https://news.example/c', source: '抖音热点' },
]

function sel(text, extra = {}) {
  return takeBriefSelection(text, items, { maxPicks: 5, tags: BRIEF_TAGS, defaultTag: '热点', ...extra })
}

function titles(result) {
  return result.picks.map((p) => p.item.title)
}

/** 2.2.1 的提取方式：从第一个 { 贪心吃到最后一个 }。测试用来证明旧路径会失败。 */
function legacyParse(out) {
  const m = String(out).match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no match')
  return JSON.parse(m[0])
}

function missingCommaAt104() {
  for (let n = 0; n < 80; n++) {
    const comment = '模型又更新了' + '呀'.repeat(n)
    const body = `{"picks":[{"id":1,"tag":"模型","comment":"${comment}"} {"id":2,"tag":"热点","comment":"x"}],"tomorrow":"明天看发布"}`
    try { JSON.parse(body) } catch (e) {
      if (String(e.message).startsWith(OBSERVED_CLASS)) return { body, message: e.message }
    }
  }
  return null
}

const good = '{"picks":[{"id":1,"tag":"模型","comment":"围栏里"}],"tomorrow":"明天看一眼"}'

test('baseline stays 2.2.1 schedules and does not gate hot() on enabled', () => {
  assert.equal(mod.id, 'ai-brief')
  assert.equal(mod.version, '2.2.2')
  assert.equal(mod.defaults.morning, '09:31')
  assert.equal(mod.defaults.evening, '21:30')
  assert.equal(mod.defaults.forumTime, '12:00')
  assert.equal(mod.defaults.morningCount, 5)
  assert.equal(mod.defaults.eveningCount, 5)
  assert.equal(mod.defaults.enabled, true)
  assert.equal(mod.defaults.morningEnabled, true)
  assert.equal(mod.defaults.eveningEnabled, true)
  assert.equal(mod.defaults.forumEnabled, false)
  assert.equal(mod.defaults.hotNodesEnabled, true)
  assert.equal(mod.defaults.banner, false)
  const meta = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
  assert.equal(meta.version, '2.2.2')
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.equal(src.includes('[\\s\\S]*\\}'), false)
  assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/)
  const hotSrc = src.slice(src.indexOf('async function hotLists'), src.indexOf('function uniq'))
  assert.match(hotSrc, /th\.hot\(node\)/)
  assert.doesNotMatch(hotSrc, /enabled/)
  assert.match(src, /if \(!c\.enabled\) return/)
})

test('observed error class: missing comma at position 104 falls back to source titles', () => {
  const hit = missingCommaAt104()
  assert.ok(hit, 'fixture must reproduce the Nov 21 JSON.parse message')
  assert.throws(() => legacyParse(hit.body), { message: hit.message })
  const result = sel(hit.body)
  assert.equal(result.fallback, true)
  assert.equal(result.error, hit.message)
  assert.ok(result.error.startsWith(OBSERVED_CLASS))
  assert.equal(`早报提炼失败，用原始标题：${result.error}`, `早报提炼失败，用原始标题：${hit.message}`)
  assert.equal(result.tomorrow, '')
  assert.deepEqual(titles(result), ['源标题甲', '源标题乙', '源标题丙'])
  assert.deepEqual(result.picks.map((p) => p.item.url), items.map((x) => x.url))
  assert.deepEqual(result.picks.map((p) => p.comment), ['', '', ''])
  assert.deepEqual(result.picks.map((p) => p.tag), ['热点', '热点', '热点'])
})

test('fenced JSON survives prose braces that break the greedy extractor', () => {
  const wrapped = '```json\n' + good + '\n```\n补充 {别用}\n'
  assert.throws(() => legacyParse(wrapped))
  const result = sel(wrapped)
  assert.equal(result.fallback, false)
  assert.equal(result.error, '')
  assert.equal(result.tomorrow, '明天看一眼')
  assert.equal(result.picks.length, 1)
  assert.equal(result.picks[0].item, items[0])
  assert.equal(result.picks[0].item.url, 'https://news.example/a')
  assert.equal(result.picks[0].comment, '围栏里')
  assert.equal(result.picks[0].tag, '模型')
})

test('prose braces and braces inside strings do not steal the object', () => {
  const withBrace = '{"picks":[{"id":1,"tag":"模型","comment":"花括号}在这"}],"tomorrow":"留意"}'
  const text = '前文 {提示}\n' + withBrace + '\n后文 {备注}'
  assert.throws(() => legacyParse(text))
  const result = sel(text)
  assert.equal(result.fallback, false)
  assert.equal(result.picks[0].comment, '花括号}在这')
  assert.equal(result.picks[0].item.title, '源标题甲')
  assert.equal(result.tomorrow, '留意')
})

test('escaped quotes inside a comment stay text', () => {
  const text = '{"picks":[{"id":1,"tag":"模型","comment":"a}b\\"c{d"}],"tomorrow":"x"}'
  const result = sel(text)
  assert.equal(result.fallback, false)
  assert.equal(result.picks[0].comment, 'a}b"c{d')
  assert.equal(result.picks[0].item.url, items[0].url)
})

test('multiple objects: first valid object wins and later ones are not merged', () => {
  const text = [
    '{"picks":[{"id":1,"tag":"模型","comment":"第一条"}],"tomorrow":"甲"}',
    '{"picks":[{"id":2,"tag":"热点","comment":"第二条"}],"tomorrow":"乙"}',
  ].join('\n')
  const result = sel(text)
  assert.equal(result.fallback, false)
  assert.equal(result.picks.length, 1)
  assert.equal(result.picks[0].comment, '第一条')
  assert.equal(result.picks[0].item, items[0])
  assert.equal(result.tomorrow, '甲')
})

test('a schema-invalid object before a valid one does not hide the valid one', () => {
  const text = '{"note":"先看"}\n' + good
  const result = sel(text)
  assert.equal(result.fallback, false)
  assert.equal(result.picks[0].comment, '围栏里')
})

test('truncated output is not repaired from an inner object', () => {
  const truncated = '{"picks":[{"id":1,"tag":"模型","comment":"没写完"}]'
  assert.deepEqual(topLevelJsonObjects(truncated), [])
  const result = sel(truncated)
  assert.equal(result.fallback, true)
  assert.equal(result.error, '模型输出没有完整 JSON 对象')
  assert.equal(result.tomorrow, '')
  assert.deepEqual(titles(result), items.map((x) => x.title))
  assert.deepEqual(result.picks.map((p) => p.comment), ['', '', ''])

  const nested = '{"wrapper":{"picks":[{"id":1,"tag":"模型","comment":"内层"}]},"tomorrow":'
  assert.deepEqual(topLevelJsonObjects(nested), [])
  const inner = sel(nested)
  assert.equal(inner.fallback, true)
  assert.notEqual(inner.picks[0].comment, '内层')
})

test('malformed fence is not replaced by a valid object outside it', () => {
  const inside = '{"picks":[{"id":1,"tag":"模型","comment":"坏了"} {"id":2,"tag":"热点","comment":"x"}]}'
  const outside = '{"picks":[{"id":1,"tag":"模型","comment":"外面这条"}],"tomorrow":"不该用"}'
  const text = '```json\n' + inside + '\n```\n' + outside
  assert.deepEqual(jsonObjectCandidates(text), [inside])
  assert.throws(() => JSON.parse(inside), /Expected ',' or ']' after array element/)
  const result = sel(text)
  assert.equal(result.fallback, true)
  assert.match(result.error, /Expected ',' or ']' after array element/)
  assert.equal(result.tomorrow, '')
  assert.deepEqual(result.picks.map((p) => p.comment), ['', '', ''])
  assert.equal(result.picks[0].item.title, '源标题甲')
})

test('invalid schema and out-of-range indices fall back without inventing rows', () => {
  for (const text of [
    '{"picks":{"id":1,"tag":"模型","comment":"不行"}}',
    '{"items":[{"id":1,"tag":"模型","comment":"不行"}]}',
    '{"picks":[]}',
    '[]',
    '不是 JSON',
    '',
    '{"picks":[{"id":0,"tag":"模型","comment":"零"},{"id":99,"tag":"热点","comment":"越界"},{"id":-3,"tag":"人物","comment":"负"},{"id":1.5,"tag":"芯片","comment":"小数"},{"id":true,"tag":"模型","comment":"布尔"}]}',
  ]) {
    const result = sel(text)
    assert.equal(result.fallback, true, text)
    assert.equal(result.tomorrow, '')
    assert.deepEqual(titles(result), items.map((x) => x.title), text)
    assert.deepEqual(result.picks.map((p) => p.item.url), items.map((x) => x.url), text)
    assert.ok(result.error, text)
  }
  const ranged = sel('{"picks":[{"id":99,"tag":"模型","comment":"越界"}]}')
  assert.match(ranged.error, /没有落在候选范围内的序号/)
})

test('in-range ids keep source title and url; fake title and url are ignored', () => {
  const text = '{"picks":[{"id":2,"tag":"应用","comment":"用第二条","title":"伪造标题","url":"https://evil.example/x"}],"tomorrow":"真来源"}'
  const result = sel(text)
  assert.equal(result.fallback, false)
  assert.equal(result.picks.length, 1)
  assert.equal(result.picks[0].item, items[1])
  assert.equal(result.picks[0].item.title, '源标题乙')
  assert.equal(result.picks[0].item.url, 'https://news.example/b')
  assert.equal(result.picks[0].comment, '用第二条')
  assert.equal(result.picks[0].tag, '应用')
  assert.equal(result.tomorrow, '真来源')
  assert.deepEqual(Object.keys(result.picks[0]).sort(), ['comment', 'item', 'tag'])
})

test('mixed ids, duplicates, cardinality, tags, and non-strings stay bounded', () => {
  const mixed = sel('{"picks":[{"id":99,"tag":"模型","comment":"丢"},{"id":"2","tag":" 应用 ","comment":"留下"},{"id":"01","tag":"热点","comment":"前导零"}]}')
  assert.equal(mixed.fallback, false)
  assert.deepEqual(titles(mixed), ['源标题乙'])
  assert.equal(mixed.picks[0].tag, '应用')
  assert.equal(mixed.picks[0].comment, '留下')

  const dup = sel('{"picks":[{"id":1,"tag":"模型","comment":"先"},{"id":1,"tag":"热点","comment":"后"},{"id":3,"tag":"人物","comment":"第三条"}]}')
  assert.deepEqual(dup.picks.map((p) => [p.item.title, p.comment]), [
    ['源标题甲', '先'],
    ['源标题丙', '第三条'],
  ])

  const capped = sel(
    '{"picks":[{"id":1,"tag":"模型","comment":"一"},{"id":2,"tag":"芯片","comment":"二"},{"id":3,"tag":"政策","comment":"三"}]}',
    { maxPicks: 2 },
  )
  assert.deepEqual(titles(capped), ['源标题甲', '源标题乙'])

  const unknown = sel('{"picks":[{"id":1,"tag":"广告","comment":"不在表里"}],"tomorrow":12345}')
  assert.equal(unknown.picks[0].tag, '热点')
  assert.equal(unknown.tomorrow, '')

  const odd = sel('{"picks":[{"id":1,"tag":"模型","comment":{"evil":1}},{"id":"nope","tag":"热点","comment":"跳过"}]}')
  assert.equal(odd.fallback, false)
  assert.equal(odd.picks.length, 1)
  assert.equal(odd.picks[0].comment, '')
  assert.equal(odd.picks[0].item, items[0])

  const longComment = '啊'.repeat(30)
  const longTomorrow = '明'.repeat(50)
  const sliced = sel(`{"picks":[{"id":1,"tag":"模型","comment":"${longComment}"}],"tomorrow":"${longTomorrow}"}`)
  assert.equal(sliced.picks[0].comment, '啊'.repeat(24))
  assert.equal(sliced.tomorrow, '明'.repeat(40))
})

test('does not repair trailing commas, smart quotes, or execute model text', () => {
  const trailing = sel('{"picks":[{"id":1,"tag":"模型","comment":"ok"},],"tomorrow":""}')
  assert.equal(trailing.fallback, true)
  assert.match(trailing.error, /JSON/)

  const smart = sel('{"picks":[{"id":1,"tag":"模型","comment":"ok"}]}'.replaceAll('"', '“'))
  assert.equal(smart.fallback, true)
  assert.notEqual(smart.picks[0].comment, 'ok')

  const evil = '{"picks":[{"id":1,"tag":"模型","comment":"process.exit(1)"}],"tomorrow":"","__proto__":{"polluted":true}}'
  const result = sel(evil)
  assert.equal(result.fallback, false)
  assert.equal(result.picks[0].comment, 'process.exit(1)')
  assert.equal(({}).polluted, undefined)
  assert.equal(result.picks[0].item.url, items[0].url)
})

test('legitimate raw, pretty, tilde, crlf, and inline fences', () => {
  assert.equal(sel(good).fallback, false)
  const pretty = '```json\n{\n  "picks": [\n    { "id": 1, "tag": "芯片", "comment": "换行也行" }\n  ],\n  "tomorrow": "保持"\n}\n```\n'
  const prettySel = sel(pretty)
  assert.equal(prettySel.fallback, false)
  assert.equal(prettySel.picks[0].tag, '芯片')
  assert.equal(prettySel.picks[0].comment, '换行也行')
  assert.equal(prettySel.tomorrow, '保持')

  const tilde = '~~~json\n' + good + '\n~~~\n'
  assert.equal(sel(tilde).picks[0].comment, '围栏里')

  const crlf = '```json\r\n' + good + '\r\n```\r\n后记 {备注}\r\n'
  assert.throws(() => legacyParse(crlf))
  assert.equal(sel(crlf).picks[0].comment, '围栏里')

  const inline = '```json {"picks":[{"id":1,"tag":"模型","comment":"有```号"}],"tomorrow":"行"} ```'
  const inlineSel = sel(inline)
  assert.equal(inlineSel.fallback, false)
  assert.equal(inlineSel.picks[0].comment, '有```号')
  assert.equal(inlineSel.tomorrow, '行')
})

test('forum tags and source order fallback', () => {
  const posts = [
    { body: '食堂涨价', href: 'https://pd.qq.com/a', views: 10, comments: 2 },
    { body: '选课攻略', href: 'https://pd.qq.com/b', views: 3, comments: 1 },
  ]
  const text = '{"picks":[{"id":2,"tag":"学习","comment":"看这个"},{"id":1,"tag":"不存在","comment":"校园"}]}'
  const result = takeBriefSelection(text, posts, { maxPicks: 4, tags: FORUM_TAGS, defaultTag: '热点' })
  assert.equal(result.fallback, false)
  assert.equal(result.picks[0].item.href, 'https://pd.qq.com/b')
  assert.equal(result.picks[0].tag, '学习')
  assert.equal(result.picks[1].tag, '热点')
  assert.equal(result.picks[1].item.body, '食堂涨价')

  const bad = takeBriefSelection('{"picks":[{"id":8,"tag":"校园","comment":"没有"}]}', posts, {
    maxPicks: 4,
    tags: FORUM_TAGS,
    defaultTag: '热点',
  })
  assert.equal(bad.fallback, true)
  assert.deepEqual(bad.picks.map((p) => p.item.body), ['食堂涨价', '选课攻略'])
  assert.deepEqual(bad.picks.map((p) => p.comment), ['', ''])
})

test('candidate cap and id parser reject unsafe indexes', () => {
  const junk = Array.from({ length: 8 }, () => '{"note":true}').join('\n')
  const capped = sel(junk + '\n' + good)
  assert.equal(capped.fallback, true)
  assert.equal(capped.picks[0].comment, '')

  assert.equal(canonicalPickId(1, 3), 1)
  assert.equal(canonicalPickId('2', 3), 2)
  assert.equal(canonicalPickId(' 3 ', 3), 3)
  assert.equal(canonicalPickId('01', 3), null)
  assert.equal(canonicalPickId('+1', 3), null)
  assert.equal(canonicalPickId(1.5, 3), null)
  assert.equal(canonicalPickId(true, 3), null)
  assert.equal(canonicalPickId(0, 3), null)
  assert.equal(canonicalPickId(4, 3), null)
  assert.equal(canonicalPickId('1', 0), null)
})

test('fallback keeps the caller order and does not invent a tomorrow line', () => {
  const ranked = [items[2], items[0]]
  const result = takeBriefSelection('{}', ranked, { maxPicks: 5, tags: BRIEF_TAGS, defaultTag: '热点' })
  assert.deepEqual(titles(result), ['源标题丙', '源标题甲'])
  assert.deepEqual(result.picks.map((p) => p.item.url), ['https://news.example/c', 'https://news.example/a'])
  assert.equal(result.tomorrow, '')
})
