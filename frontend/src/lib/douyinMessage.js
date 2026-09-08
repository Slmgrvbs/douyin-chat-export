// Douyin IM message parsing/detection — pure functions of a message row.
// Extracted from MessageList.vue so the intricate payload heuristics can be
// unit-tested and reused. Nothing here depends on Vue reactivity or the DOM.
//
// The message shape: { msg_id, msg_type, content, raw_data (JSON string with a
// (often double-encoded) content_json), sender_uid, sender_name, timestamp,
// media_local_path, media_url, ref_msg, voice_transcription }.

// Cache by row identity: the same server message may also appear in a forward.
let cjCache = new WeakMap()

export function clearCjCache() {
  cjCache = new WeakMap()
}

export function getContentJson(msg) {
  if (cjCache.has(msg)) return cjCache.get(msg)
  let cj = null
  try {
    if (msg.raw_data) {
      const raw = typeof msg.raw_data === 'string' ? JSON.parse(msg.raw_data) : msg.raw_data
      if (raw.content_json) {
        cj = typeof raw.content_json === 'string' ? JSON.parse(raw.content_json) : raw.content_json
      }
    }
  } catch {}
  cjCache.set(msg, cj)
  return cj
}

export function tryParseJson(str) {
  if (!str || !str.startsWith('{')) return null
  try { return JSON.parse(str) } catch { return null }
}

export function firstMediaUrl(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === 'string' ? first : firstMediaUrl(first)
  }
  if (typeof value === 'object') {
    for (const key of ['url_list', 'origin_url_list', 'medium_url_list', 'large_url_list', 'thumb_url_list']) {
      const found = firstMediaUrl(value[key])
      if (found) return found
    }
    if (typeof value.url === 'string') return value.url
    if (typeof value.uri === 'string' && value.uri.startsWith('http')) return value.uri
  }
  return ''
}

export function payloadJson(msg) {
  return getContentJson(msg) || tryParseJson(msg.content)
}

export function tryParseShareContent(content) {
  if (!content || !content.startsWith('{')) return null
  try {
    const obj = JSON.parse(content)
    if (
      obj.content_title || obj.cover_url || obj.poi_name || obj.aweme_poi_id
      || obj.aweType === 805 || obj.aweType === 2104
    ) return obj
  } catch {}
  return null
}

export function extractShareTitle(content) {
  if (!content) return ''
  // "分享[商品]: 商品名称" / "分享[视频]: 标题" / "[分享视频]标题"
  const m = content.match(/^(?:分享\[.+?\][:：]\s*|^\[分享视频\])(.+)/s)
  return m ? m[1].trim() : ''
}

// msg_type=1 but actually a system-tip JSON (has tips, but not a sticker)
export function isJsonSystemMsg(msg) {
  if (msg.msg_type !== 1) return false
  if (!msg.content || !msg.content.startsWith('{')) return false
  if (isJsonSticker(msg)) return false  // 贴纸优先
  return msg.content.includes('"tips"') && msg.content.includes('"aweType"')
}

// msg_type=1 but actually a sticker JSON (content may be truncated → also check content_json)
export function isJsonSticker(msg) {
  if (msg.msg_type !== 1) return false
  if (!msg.content || !msg.content.startsWith('{')) return false
  if (msg.content.includes('"stickers"') || msg.content.includes('"joker_stickers"')) return true
  const cj = getContentJson(msg)
  if (cj && (cj.stickers || cj.joker_stickers)) return true
  return false
}

export function getStickerUrl(msg) {
  const cj = getContentJson(msg)
  const source = cj || tryParseShareContent(msg.content)
  if (!source) return null
  if (source.stickers?.length > 0) {
    return source.stickers[0].static_url?.url_list?.[0] || null
  }
  if (source.joker_stickers?.length > 0) {
    return source.joker_stickers[0].static_url?.url_list?.[0] || null
  }
  return null
}

// "一起看视频" 邀请卡片 (aweType=9000)：msg_type=0，但不是普通系统提示，
// 单独渲染成卡片。返回 {title, subtitle, cover} 或 null。
export function getWatchTogether(msg) {
  const cj = getContentJson(msg) || tryParseJson(msg.content)
  if (!cj || cj.aweType !== 9000) return null
  return {
    title: cj.title || '一起看视频',
    subtitle: cj.sub_title || cj.hint || '',
    cover: cj.cover_url?.url_list?.[0] || '',
  }
}

// Whether a message should render at all (empty system messages are hidden).
export function shouldShow(msg) {
  if (getProfileCard(msg) || getForwardInfo(msg) || isVoiceMsg(msg)) return true
  if (getWatchTogether(msg)) return true       // 一起看视频卡片始终显示
  if (isLooseEmoji(msg) || isLooseShare(msg) || isLooseImage(msg)) return true
  if (msg.msg_type === 0) return !!renderSystemMsg(msg)
  if (isJsonSystemMsg(msg)) return !!renderSystemMsg(msg)
  return true
}

// System message: render the template (prefer content_json — content may be truncated).
export function renderSystemMsg(msg, selfUid = '') {
  const cj = getContentJson(msg)
  const source = cj || tryParseJson(msg.content)
  if (!source) {
    return (msg.content && msg.content !== '{}') ? msg.content : ''
  }
  if (source.tips) {
    let text = source.tips
    // These events carry the actor's UID, even when Douyin supplies a
    // recipient-oriented template. Change only template pronouns, never names
    // or the referenced video's title.
    if (selfUid && msg.sender_uid && String(source.aweType) === '126' && /赞了/.test(text)) {
      text = String(msg.sender_uid) === String(selfUid)
        ? '你赞了对方分享的 {{2}}' : '对方赞了你分享的 {{2}}'
    } else if (selfUid && msg.sender_uid && /^(你|对方)领取了火星/.test(text)) {
      text = text.replace(/^(你|对方)/, String(msg.sender_uid) === String(selfUid) ? '你' : '对方')
    }
    if (Array.isArray(source.template)) {
      for (const t of source.template) {
        if (!t || t.key === undefined) continue
        text = text.replaceAll(`{{${t.key}}}`, () => t.name || '')
      }
    }
    return text
  }
  if (source.hint_text) return source.hint_text
  if (Object.keys(source).length <= 1) return ''
  // 兜底：不认识的 JSON 卡片消息不要把原始 JSON 吐到界面上；只回显纯文本 content。
  return (msg.content && msg.content !== '{}' && !msg.content.startsWith('{')) ? msg.content : ''
}

// Extract server_message_id from the raw JSON string (avoids JSON.parse losing
// >2^53 integer precision); tolerates escaped quotes in doubly-encoded raw_data.
export function extractServerMsgIds(msg) {
  const ids = []
  try {
    const raw = typeof msg.raw_data === 'string' ? msg.raw_data : JSON.stringify(msg.raw_data)
    const re = /server_message_id\\?"?\s*:\s*\\?"?(\d{15,})/g
    let match
    while ((match = re.exec(raw)) !== null) {
      ids.push(match[1])
    }
  } catch {}
  return ids
}

// Comment-quoting-a-video message (aweType=700 + related_share_video)
export function isVideoComment(msg) {
  const cj = getContentJson(msg)
  if (!cj) return false
  return cj.aweType === 700 && !!cj.related_share_video?.itemId
}

// Whether a msg_type=1 message is actually a share card (JSON content with content_title)
export function isJsonShare(msg) {
  if (msg.msg_type === 4) return false
  if (!msg.content || !msg.content.startsWith('{')) return false
  return msg.content.includes('content_title') || msg.content.includes('cover_url')
}

const LOOSE_EMOJI_AWES = new Set([515, 517, 520])
const LOOSE_SHARE_AWES = new Set([805, 2104])

// Type-0/1 leftovers that should render as an emoji, not a system line.
export function isLooseEmoji(msg) {
  if (isJsonSticker(msg)) return true
  const cj = payloadJson(msg)
  return !!cj && LOOSE_EMOJI_AWES.has(Number(cj.aweType))
}

// Type-0/1 leftovers that should render as a share/location card.
export function isLooseShare(msg) {
  if (msg.msg_type === 4) return false
  if (isJsonShare(msg)) return true
  const cj = payloadJson(msg)
  if (!cj) return false
  if (LOOSE_SHARE_AWES.has(Number(cj.aweType))) return true
  if (cj.poi_name || cj.cover_info) return true
  return !!(cj.aweme_poi_id && String(cj.aweme_poi_id))
}

export function isShareCard(msg) {
  return msg.msg_type === 4 || isLooseShare(msg)
}

// Video / live / work shares with a real poster. Product chips stay compact.
export function isPosterShare(msg) {
  const source = payloadJson(msg) || tryParseShareContent(msg.content)
  if (!source || source.im_dynamic_patch) return false
  return !!(
    firstMediaUrl(source.cover_url)
    || firstMediaUrl(source.cover_info?.resource_url)
    || firstMediaUrl(source.content_thumb)
  )
}

// Type-1 leftover that is a photo (inline_pic / check_pics) stored as JSON text.
export function isLooseImage(msg) {
  if (msg.msg_type === 3) return false
  if (isLooseShare(msg) || isLooseEmoji(msg) || isJsonVideo(msg)) return false
  const cj = payloadJson(msg)
  if (!cj?.inline_pic) return false
  return !!(cj.check_pics || cj.is_long_pic != null || cj.create_type != null)
}

// Share-card info extraction (video share, product card, quoted-video comment).
export function getShareInfo(msg) {
  const cj = getContentJson(msg)
  const source = cj || tryParseShareContent(msg.content)
  if (!source) return { title: '', author: '', cover: '', itemId: '', productUrl: '', comment: '', commentUser: '' }

  // 商品卡片 (aweType=11029): 从 im_dynamic_patch.raw_data 提取
  const patch = source.im_dynamic_patch
  if (patch?.raw_data) {
    try {
      const pr = typeof patch.raw_data === 'string' ? JSON.parse(patch.raw_data) : patch.raw_data
      const title = pr.content_top?.content || extractShareTitle(msg.content) || ''
      const cover = pr.top?.content || ''
      let productUrl = ''
      const actions = pr.whole_card?.action_info
      if (actions?.[0]?.params?.schema) {
        const m = actions[0].params.schema.match(/commodity_id=(\d+)/)
        if (m) productUrl = 'https://www.douyin.com/product/' + m[1]
      }
      return { title, author: '', cover, itemId: '', productUrl, comment: '', commentUser: '', commentImg: '' }
    } catch {}
  }

  // aweType=10500: 引用视频评论 (comment 字段); aweType=700: (text 字段)
  const comment = source.comment || source.text || ''
  const commentUser = source.comment_user_name || ''
  const commentImg = firstMediaUrl(source.comment_url)
  const relatedVideo = source.related_share_video || {}
  const cover = firstMediaUrl(source.cover_url)
    || firstMediaUrl(source.cover_info?.resource_url)
    || firstMediaUrl(source.content_thumb)
    || firstMediaUrl(source.cover_info)
  const plainContent = (msg.content && !msg.content.startsWith('{')) ? msg.content : ''
  return {
    title: source.content_title || source.aweme_title || source.poi_name
      || source.push_detail || source.bottom_card_title
      || extractShareTitle(msg.content) || plainContent || '',
    author: source.content_name || '',
    cover,
    itemId: source.itemId || relatedVideo.itemId || '',
    productUrl: '',
    comment,
    commentUser,
    commentImg,
  }
}

// Image inline_pic base64 (WebP thumbnail); strip embedded newlines from the base64.
export function getInlinePic(msg) {
  const cj = getContentJson(msg)
  if (cj?.inline_pic) {
    return 'data:image/webp;base64,' + cj.inline_pic.replace(/\r?\n/g, '')
  }
  return null
}

// msg_type=3 whose local file is an .mp4 (a real downloaded video, not an image)
export function isVideoMsg(msg) {
  return msg.media_local_path && /\.mp4$/i.test(msg.media_local_path)
}

// Alias: a JSON-video message has a playable local .mp4 (same test).
export const hasLocalVideo = isVideoMsg

// JSON video message (msg_type=5, or legacy msg_type=1 with cj.video.vid) — poster only.
export function isJsonVideo(msg) {
  if (msg.msg_type === 5) return true
  if (msg.msg_type !== 1) return false
  const cj = getContentJson(msg)
  return !!(cj && cj.video && cj.video.vid)
}

// Video poster: the inline_pic base64 WebP thumbnail.
export function getVideoPoster(msg) {
  return getInlinePic(msg)
}

// Video duration in seconds (rendered with a ″ suffix).
export function getVideoDuration(msg) {
  const cj = getContentJson(msg)
  const d = cj?.duration
  if (d === undefined || d === null) return ''
  const n = typeof d === 'string' ? parseFloat(d) : Number(d)
  if (!n || isNaN(n)) return ''
  return Math.round(n) + '″'
}

// Image src: local original > inline_pic thumbnail (video goes through its own branch).
export function getImageSrc(msg) {
  if (msg.media_local_path && !isVideoMsg(msg)) return '/media/' + msg.media_local_path
  return getInlinePic(msg)
}

// Emoji src: local > stored CDN > sticker payload > cj.url.
export function getEmojiSrc(msg) {
  if (msg.media_local_path) return '/media/' + msg.media_local_path
  if (msg.media_url) return msg.media_url
  const sticker = getStickerUrl(msg)
  if (sticker) return sticker
  const cj = payloadJson(msg)
  return firstMediaUrl(cj?.url) || null
}

// Recalled-message detection.
export function isRecalled(msg) {
  const cj = getContentJson(msg)
  if (cj?.is_recalled) return true
  if (!msg.raw_data) return false
  try {
    const raw = typeof msg.raw_data === 'string' ? JSON.parse(msg.raw_data) : msg.raw_data
    return !!raw.is_recalled
  } catch { return false }
}

function getVoiceContent(msg) {
  const cj = getContentJson(msg)
  if (cj) return cj
  if (msg.content?.startsWith('{') && msg.content.includes('resource_url')) {
    try { return JSON.parse(msg.content) } catch {}
  }
  return null
}

// Voice messages normally stay msg_type=0/other and carry resource_url plus
// duration.  Also recognize legacy rows that an older scraper stored as
// msg_type=1, including payloads where only tkey/voice_wave was retained.
export function isVoiceMsg(msg) {
  const cj = getVoiceContent(msg)
  const resource = cj?.resource_url
  if (!resource || (typeof resource !== 'object' && typeof resource !== 'string')) return false
  if (['2702', '2703', '2704'].includes(String(cj.aweType)) && !cj.voice_wave && !cj.tkey && !resource.is_voice) return false
  if (cj.video?.vid && !cj.voice_wave && !cj.tkey && !resource.is_voice) return false
  const hasUrl = Array.isArray(resource.url_list) && resource.url_list.length > 0
  const hasDuration = (cj.duration !== undefined && cj.duration !== null && cj.duration !== '') ||
    (resource.duration !== undefined && resource.duration !== null && resource.duration !== '')
  const hasVoiceMarker = !!(cj.tkey || cj.voice_wave || resource.is_voice)
  const storedVoiceType = msg.msg_type === 0 || msg.msg_type === 'other' || msg.msg_type === undefined || msg.msg_type === null
  return storedVoiceType ? (hasUrl || hasDuration || hasVoiceMarker) : (hasDuration || hasVoiceMarker)
}

export function getVoiceUrl(msg) {
  const source = getVoiceContent(msg)
  // Guard JSON.parse: malformed content that merely starts with '{' must not
  // throw during render (matches getVoiceDuration below).
  if (msg.media_local_path) return `/media/${msg.media_local_path}`
  const resource = source?.resource_url
  if (typeof resource === 'string') return resource
  if (!resource || typeof resource !== 'object') return ''
  return resource.url_list?.[0] || resource.url || resource.uri || ''
}

export function getVoiceDuration(msg) {
  const source = getVoiceContent(msg)
  const duration = source?.duration ?? source?.resource_url?.duration
  if (duration === undefined || duration === null || duration === '') return '?'
  const seconds = Number(duration) / 1000
  return Number.isFinite(seconds) ? Math.round(seconds) : '?'
}

// Reply/quote parsing (new field-18 format + legacy formats).
export function getRefMsg(msg) {
  if (!msg.ref_msg) return null
  try {
    const ref = typeof msg.ref_msg === 'string' ? JSON.parse(msg.ref_msg) : msg.ref_msg
    if (ref.content || ref.nickname) return ref
    if (ref.server_id && String(ref.server_id).length >= 15) return ref
    if (ref.content_json) return ref
  } catch {}
  return null
}

export function getRefContent(ref) {
  if (!ref) return ''
  if (ref.content) return ref.content
  if (ref.refmsg_content) {
    try {
      const cj = JSON.parse(ref.refmsg_content)
      if (cj.text) return cj.text
    } catch {}
  }
  if (ref.content_json) {
    try {
      const cj = JSON.parse(ref.content_json)
      if (cj.text) return cj.text
      if (cj.content_title) return `[分享] ${cj.content_title}`
      if (cj.aweType === 501 || cj.aweType === 507) return '[表情]'
    } catch {}
    if (!ref.content_json.startsWith('{')) return ref.content_json
  }
  return '[消息]'
}

export function getRefNickname(ref) {
  if (!ref) return ''
  return ref.nickname || ''
}

// User-homepage cards can be stored as text, share, or other by older scrapers.
export function getProfileCard(msg) {
  const cj = getContentJson(msg) || tryParseJson(msg.content)
  if (!cj || !cj.name || !(cj.secUID || cj.sec_uid || (cj.uid && cj.source === 'others_homepage'))) return null
  const id = cj.secUID || cj.sec_uid || String(cj.uid)
  const avatar = cj.avatar_thumb || cj.avatar || cj.avatar_url || cj.cover_url
  return {
    name: String(cj.name),
    avatar: typeof avatar === 'string' ? (/^https?:\/\//.test(avatar) ? avatar : '') : avatar?.url_list?.[0] || '',
    description: cj.desc || '',
    followers: cj.follower_count ?? null,
    url: `https://www.douyin.com/user/${encodeURIComponent(id)}`,
  }
}

export function getForwardInfo(msg) {
  const cj = getContentJson(msg) || tryParseJson(msg.content)
  if (String(cj?.aweType) !== '13600') return null
  return {
    title: cj.title || '聊天记录',
    preview: Array.isArray(cj.list_content) ? cj.list_content : [],
    count: Array.isArray(cj.msg_ids) ? cj.msg_ids.length : null,
  }
}

export function isSystemMsg(msg) {
  if (getProfileCard(msg) || getForwardInfo(msg) || isVoiceMsg(msg)) return false
  if (isLooseEmoji(msg) || isLooseShare(msg) || isLooseImage(msg)) return false
  return msg.msg_type === 0 || isJsonSystemMsg(msg)
}

// Douyin may return both sender/recipient notifications for one event. Pair
// only opposite templates for the same actor/reference within 30 seconds (observed mirror delays
// reach 15 seconds);
// repeated likes with the same template remain distinct events.
export function duplicateSystemMessageIds(messages) {
  const pending = new Map()
  const hidden = new Set()
  for (const msg of messages) {
    const cj = getContentJson(msg) || tryParseJson(msg.content)
    if (!cj?.tips || !msg.sender_uid || !msg.timestamp) continue
    const like = String(cj.aweType) === '126' && cj.tips.includes('赞了')
    const spark = /^(你|对方)领取了火星/.test(cj.tips)
    if (!like && !spark) continue
    const refs = extractServerMsgIds(msg).join(',')
    if (like && !refs) continue
    const key = JSON.stringify([msg.conv_id, msg.sender_uid, like ? 'like' : 'spark', refs,
      spark ? cj.template : null])
    const prev = pending.get(key)
    if (prev && prev.tips !== cj.tips && Math.abs(msg.timestamp - prev.timestamp) <= 30) {
      hidden.add(msg.msg_id)
      pending.delete(key)
    } else {
      pending.set(key, { timestamp: msg.timestamp, tips: cj.tips })
    }
  }
  return hidden
}
