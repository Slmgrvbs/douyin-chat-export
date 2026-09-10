import { describe, expect, it } from 'vitest'
import { sharePreview } from './sharePreview'
const row = cj => ({ msg_type: 4, content: '{truncated', raw_data: JSON.stringify({ content_json: JSON.stringify(cj) }) })
describe('readable shared-message search results', () => {
  it.each([
    [{ aweType: 800, content_title: '标题' }, '[分享视频] 标题'],
    [{ aweType: 10500, comment: '评论内容', content_title: '标题' }, '[分享评论] 评论内容'],
    [{ awemeType: 68, content_title: '标题' }, '[分享图文] 标题'],
    [{ awemeType: '68', is_live_photo: '1', content_title: '标题' }, '[分享动图] 标题'],
    [{ awemeType: 163, content_title: '标题' }, '[分享文章] 标题'],
    [{ push_detail: '分享[动图]', aweType: 800, content_title: '标题' }, '[分享动图] 标题'],
    [{ aweType: 10401, content_title: '商品名称' }, '[分享商品] 商品名称'],
  ])('labels %j', (cj, text) => expect(sharePreview(row(cj))).toBe(text))
  it('does not leak malformed JSON or classify ordinary text as a share', () => {
    expect(sharePreview({ msg_type: 4, content: '{broken', raw_data: '{broken' })).toBe('[分享]')
    expect(sharePreview({ msg_type: 1, content: '普通消息' })).toBeNull()
  })
})

it('reads dynamic titles and bracketed share hints without mislabeling photos', () => {
  for (const type of ['图文', '动图', '视频']) {
    const msg = row({ aweType: 11054, push_detail: `[分享${type}]`, item_id: '123',
      im_dynamic_patch: { raw_data: JSON.stringify({ top_bottom_top: { content: '完整标题' } }) } })
    expect(sharePreview(msg)).toBe(`[分享${type}] 完整标题`)
  }
})
