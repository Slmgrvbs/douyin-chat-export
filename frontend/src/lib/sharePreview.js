import { getContentJson, getShareInfo } from './douyinMessage'

export function sharePreview(item) {
  let cj = getContentJson(item)
  if (!cj) {
    try { cj = JSON.parse(item.content) } catch { /* Legacy content can be truncated. */ }
  }
  if (!cj || typeof cj !== 'object' || Array.isArray(cj)) cj = {}
  const awe = Number(cj.aweType)
  const info = getShareInfo(item)
  const title = info.title
  const comment = typeof cj.comment === 'string' ? cj.comment : ''
  const prefix = String(item.content || '').match(/^\[分享([^\]]+)\]/)?.[1]
  if (item.msg_type !== 4 && !info.itemId && !cj.im_dynamic_patch && !cj.awemeType && !prefix && ![10500, 11029, 10401].includes(awe)) return null
  let type = comment || awe === 10500 ? '评论' : String(cj.push_detail || '').match(/\[(?:分享)?(动图|图文|视频|评论|文章|商品)\]/)?.[1]
  if (!type && Number(cj.awemeType) === 68) type = Number(cj.is_live_photo) === 1 ? '动图' : '图文'
  if (!type && Number(cj.awemeType) === 163) type = '文章'
  if (!type && [11029, 10401].includes(awe)) type = '商品'
  if (!type && [800, 801, 803, 11054, 11055, 11063, 11066, 11067, 11069, 11070].includes(awe)) type = title ? '视频' : '链接'
  type ||= prefix || (info.itemId ? '视频' : '')
  const content = String(item.content || '').trim()
  const fallback = content.startsWith('{') || content.startsWith('[') && !prefix ? '' : content.replace(/^\[分享[^\]]*\]\s*/, '')
  return `[分享${type}] ${comment || title || fallback}`.trim()
}
