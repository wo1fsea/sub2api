import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import colors from 'tailwindcss/colors'
import config from '../../../tailwind.config.js'

const source = readFileSync(resolve('src/styles/neubrutalism-skin.css'), 'utf8')

const families = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'
]

describe('grayscale skin palette', () => {
  it('routes every chromatic utility through neutral tokens with original RGB fallbacks', async () => {
    const content = families.map(name => `bg-${name}-50 text-${name}-600 border-${name}-200`).join(' ')
    const result = await postcss([tailwindcss({
      ...config, content: [{ raw: content, extension: 'html' }]
    })]).process('@tailwind utilities;', { from: undefined })
    for (const name of families) {
      for (const shade of [50, 200, 600]) {
        const hex = colors[name][shade]
        const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(' ')
        expect(result.css).toContain(`var(--skin-tone-${shade}, ${rgb})`)
      }
    }
  })

  it('keeps utility colors neutral with only the reference paper surface slightly warm', () => {
    const root = postcss.parse(source)
    let checked = 0
    root.walkDecls(/^--skin-/, declaration => {
      if (['--skin-lime', '--skin-radius'].includes(declaration.prop)) return
      if (declaration.value.startsWith('var(')) return
      const channels = declaration.value.startsWith('#')
        ? [1, 3, 5].map(offset => parseInt(declaration.value.slice(offset, offset + 2), 16))
        : declaration.value.split(' ').map(Number)
      expect(channels).toHaveLength(3)
      if (['--skin-bg', '--skin-surface', '--skin-white', '--skin-gray-50'].includes(declaration.prop) && channels[0] === 247) {
        expect(channels).toEqual([247, 246, 240])
        return
      }
      if (['--skin-ink', '--skin-line'].includes(declaration.prop) && channels[0] === 23) {
        expect(channels).toEqual([23, 23, 21])
        return
      }
      expect(channels[0]).toBe(channels[1])
      expect(channels[1]).toBe(channels[2])
      checked++
    })
    expect(checked).toBeGreaterThan(25)
  })
})
