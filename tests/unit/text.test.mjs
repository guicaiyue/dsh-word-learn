// 测什么：lib/text.js 的划词判定纯函数（stripCode / looksLikeWord / normalizeWord /
// splitWords / classifySelection / pickBest）。
// 为什么放单测：这些是规则密集的纯函数，一个正则改动就能让"代码当单词收进生词本"；
// legacy 的 test-routes 只覆盖了少数几个真实词，边界（中文、URL、版本号、驼峰）在这里更便宜。

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_LEN,
  MIN_WORD_LEN,
  classifySelection,
  looksLikeWord,
  normalizeWord,
  pickBest,
  splitWords,
  stripCode,
} from '../../lib/host/text.js'

describe('stripCode', () => {
  test('围栏代码块与行内代码整段挖掉', () => {
    const fenced = stripCode('before ```js\nconst x = 1\n``` after')
    assert.ok(fenced.includes('before') && fenced.includes('after'))
    assert.ok(!fenced.includes('const'), '围栏代码块里的内容不该留给拆词')

    const inline = stripCode('the `config_path` field')
    assert.ok(!inline.includes('config_path'))
    assert.ok(inline.includes('the') && inline.includes('field'))
  })

  test('URL、路径、标识符、版本号都挖掉', () => {
    assert.ok(!stripCode('see https://example.com/docs now').includes('example'))
    assert.ok(!stripCode('open src/lib/index.js now').includes('index'))
    assert.ok(!stripCode('open C:\\Users\\me\\file.txt now').includes('file'))
    assert.ok(!stripCode('use config_path or obj.method').includes('config'))
    assert.ok(!stripCode('fixed in v24.13.0').includes('24'))
    assert.ok(!stripCode('about 3.12 seconds').includes('3.12'))
  })

  test('自然语言原样保留（只替换被挖掉的部分）', () => {
    assert.equal(stripCode('The quick brown fox'), 'The quick brown fox')
  })

  test('非字符串输入不抛错', () => {
    assert.equal(stripCode(null), '')
    assert.equal(stripCode(undefined), '')
    assert.equal(stripCode(123), '123')
  })
})

describe('looksLikeWord', () => {
  test('普通英文单词和带连字符/撇号的词算单词', () => {
    for (const token of ['latent', 'model', 'throughput', 'well-known', "model's", 'models']) {
      assert.equal(looksLikeWord(token), true, `${token} 应该算单词`)
    }
  })

  test('长度不足、超长、空值都不算', () => {
    assert.equal(looksLikeWord(''), false)
    assert.equal(looksLikeWord(null), false)
    assert.equal(looksLikeWord('a'), false)
    assert.equal(looksLikeWord('I'), false)
    assert.equal(looksLikeWord('a'.repeat(32)), true, '32 字母是上限内的合法长度')
    assert.equal(looksLikeWord('a'.repeat(33)), false)
  })

  test('缩写/驼峰/标识符/路径/数字都不是单词', () => {
    for (const token of [
      'API',
      'HTTP',
      'LLM',
      'getElementById',
      'config_path',
      'src/lib/index.js',
      'api.example.com',
      '3.12',
      'v24',
      'nm',
      '≈62.3M',
    ]) {
      assert.equal(looksLikeWord(token), false, `${token} 不该被当成单词`)
    }
  })

  test('非 ASCII 字母不进单词通道（前端另有中文判定）', () => {
    assert.equal(looksLikeWord('naïve'), false)
  })
})

describe('normalizeWord', () => {
  test('剥首尾标点并转小写', () => {
    assert.equal(normalizeWord('(latent)'), 'latent')
    assert.equal(normalizeWord('"throughput,"'), 'throughput')
    assert.equal(normalizeWord('  Latent  '), 'latent')
    assert.equal(normalizeWord('HTTP'), 'http')
  })

  test("所有格：model's / models' / 弯引号都归到原形", () => {
    assert.equal(normalizeWord("Model's"), 'model')
    assert.equal(normalizeWord("models'"), 'models')
    assert.equal(normalizeWord('MODEL\u2019S'), 'model', '弯引号先统一成直引号')
  })

  test('词尾连字符（断行残留）去掉，词内连字符保留', () => {
    assert.equal(normalizeWord('word-'), 'word')
    assert.equal(normalizeWord('--model--'), 'model')
    assert.equal(normalizeWord('well-known'), 'well-known')
  })

  test('空值 / 数字开头返回空串', () => {
    assert.equal(normalizeWord(''), '')
    assert.equal(normalizeWord(null), '')
    assert.equal(normalizeWord(123), '', '纯数字没有字母可留')
  })
})

describe('splitWords', () => {
  test('普通句子按出现顺序拆出单词', () => {
    assert.deepEqual(splitWords('The quick brown fox'), ['the', 'quick', 'brown', 'fox'])
  })

  test('去重且保序：大小写归一后重复的不再收', () => {
    assert.deepEqual(splitWords('model Model MODEL models'), ['model', 'models'])
  })

  test('代码 / URL / 版本号 / 中文都被过滤', () => {
    assert.deepEqual(splitWords('Use config_path to read'), ['use', 'to', 'read'])
    assert.deepEqual(splitWords('Read https://example.com now'), ['read', 'now'])
    assert.deepEqual(splitWords('3.12 and v24.13.0'), ['and'])
    assert.deepEqual(splitWords('这是中文'), [])
  })

  test('limit 截断，且短词/无元音词被跳过', () => {
    assert.deepEqual(splitWords('alpha beta gamma delta', 2), ['alpha', 'beta'])
    assert.deepEqual(splitWords('a I of to'), ['of', 'to'])
  })

  test('空输入返回空数组', () => {
    assert.deepEqual(splitWords(''), [])
    assert.deepEqual(splitWords(null), [])
  })
})

describe('classifySelection', () => {
  test('单 token（可带标点）判为 word 并归一化', () => {
    assert.deepEqual(classifySelection('(latent)'), {
      kind: 'word',
      word: 'latent',
      words: ['latent'],
    })
    assert.deepEqual(classifySelection('"throughput,"'), {
      kind: 'word',
      word: 'throughput',
      words: ['throughput'],
    })
    assert.deepEqual(classifySelection("model's").word, 'model')
  })

  test('多个 token 判为 phrase，word 留空', () => {
    const result = classifySelection('latent space')
    assert.equal(result.kind, 'phrase')
    assert.equal(result.word, '')
    assert.deepEqual(result.words, ['latent', 'space'])
  })

  test('中英混排仍算短语，但中文单独出现不算单词', () => {
    assert.equal(classifySelection('中文 latent').kind, 'phrase')
    assert.equal(classifySelection('这是中文').kind, 'other')
    assert.equal(classifySelection('123').kind, 'other')
  })

  test('代码 / 缩写 / 单字母落到 other', () => {
    assert.equal(classifySelection('config_path').kind, 'other')
    assert.equal(classifySelection('HTTP').kind, 'other')
    assert.equal(classifySelection('a').kind, 'other')
  })

  test('空选区判为 empty', () => {
    assert.deepEqual(classifySelection(''), { kind: 'empty', word: '', words: [] })
    assert.deepEqual(classifySelection('   '), { kind: 'empty', word: '', words: [] })
    assert.equal(classifySelection(null).kind, 'empty')
  })
})

describe('pickBest', () => {
  test('取最长的词；等长时保留先出现的', () => {
    assert.equal(pickBest(['a', 'throughput', 'model']), 'throughput')
    assert.equal(pickBest(['abcd', 'wxyz']), 'abcd')
  })

  test('空 / 非数组返回空串', () => {
    assert.equal(pickBest([]), '')
    assert.equal(pickBest(null), '')
    assert.equal(pickBest('not-array'), '')
  })
})

test('MIN_LEN 是 MIN_WORD_LEN 的兼容别名', () => {
  assert.equal(MIN_LEN, MIN_WORD_LEN)
  assert.equal(MIN_WORD_LEN, 2)
})
