import { describe, expect, it } from 'vitest'
import { getFieldSpec, model, t } from '../src/index.js'

describe('field builders', () => {
  it('produce a base spec with sensible defaults', () => {
    const f = t.text()
    expect(getFieldSpec(f)).toMatchObject({
      kind: 'text',
      required: false,
      unique: false,
      hasDefault: false,
      formField: 'text',
    })
  })

  it('accumulate chain calls immutably', () => {
    const base = t.text()
    const required = base.required()
    expect(getFieldSpec(base).required).toBe(false)
    expect(getFieldSpec(required).required).toBe(true)
  })

  it('record defaults with their value', () => {
    const f = t.select(['draft', 'published']).default('draft')
    expect(getFieldSpec(f).hasDefault).toBe(true)
    expect(getFieldSpec(f).defaultValue).toBe('draft')
    expect(getFieldSpec(f).options).toEqual(['draft', 'published'])
  })

  it('tag email/url/json with a format hint', () => {
    expect(getFieldSpec(t.email()).meta).toEqual({ format: 'email' })
    expect(getFieldSpec(t.url()).meta).toEqual({ format: 'url' })
    expect(getFieldSpec(t.json()).meta).toEqual({ format: 'json' })
  })

  it('carry relation target and default onDelete', () => {
    const f = t.relation('user')
    expect(getFieldSpec(f).relation).toEqual({ target: 'user', onDelete: 'restrict' })
    expect(getFieldSpec(f).formField).toBe('relationship')
  })

  it('respect a custom onDelete', () => {
    const f = t.relation('user', { onDelete: 'cascade' })
    expect(getFieldSpec(f).relation?.onDelete).toBe('cascade')
  })

  it('capture ui metadata via chain methods', () => {
    const f = t.text().label('Title').placeholder('Enter…').describe('The title').hidden()
    expect(getFieldSpec(f)).toMatchObject({
      label: 'Title',
      placeholder: 'Enter…',
      description: 'The title',
      hidden: true,
    })
  })
})

describe('model', () => {
  it('holds fields and defaulted options', () => {
    const m = model({ title: t.text().required() })
    expect(Object.keys(m.fields)).toEqual(['title'])
    expect(m.options).toEqual({})
  })

  it('passes options through', () => {
    const m = model({ title: t.text() }, { label: 'Post', timestamps: false })
    expect(m.options.label).toBe('Post')
    expect(m.options.timestamps).toBe(false)
  })
})
