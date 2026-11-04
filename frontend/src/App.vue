<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import ConversationList from './components/ConversationList.vue'
import MessageList from './components/MessageList.vue'
import SearchBar from './components/SearchBar.vue'
import ScreenshotView from './components/ScreenshotView.vue'

// 截图模式：后端 headless 浏览器访问 /screenshot?...&token=<临时token>
const isScreenshotMode = location.pathname === '/screenshot'

const activeConversation = ref(null)
const searchHighlight = ref('')
const jumpToSeq = ref(null)
const mobileLayout = window.matchMedia('(max-width: 768px)')
// 手机端还没选会话时直接展开会话列表，省一次点击
const sidebarOpen = ref(true)
const syncSidebarLayout = () => { sidebarOpen.value = !mobileLayout.matches || !activeConversation.value }
mobileLayout.addEventListener('change', syncSidebarLayout)
onUnmounted(() => mobileLayout.removeEventListener('change', syncSidebarLayout))
const searchOpen = ref(false)
// 手机端点结果跳转后，查找面板只隐藏不卸载，再点“查找”能回到原来的结果
const searchMounted = ref(false)
const readerLayout = ref(null)
async function setSearchOpen(open) {
  const list = readerLayout.value?.querySelector('.msg-list')
  const bottom = list && list.scrollHeight - list.scrollTop - list.clientHeight < 2
  const top = list?.getBoundingClientRect().top || 0
  const anchor = list && [...list.querySelectorAll(':scope > .msg-item')].find(row => row.getBoundingClientRect().bottom > top)
  const offset = anchor?.getBoundingClientRect().top
  searchOpen.value = open
  if (open) searchMounted.value = true
  await nextTick()
  if (!list?.isConnected) return
  if (bottom) list.scrollTop = list.scrollHeight - list.clientHeight
  else if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - offset
}
function closeSearch() {
  searchMounted.value = false
  setSearchOpen(false)
}

// Auth
const authChecking = ref(true)
const authenticated = ref(false)
const loginPassword = ref('')
const loginError = ref('')
const authToken = ref(localStorage.getItem('authToken') || '')
if (isScreenshotMode) {
  const qsToken = new URLSearchParams(location.search).get('token')
  if (qsToken) authToken.value = qsToken
}

async function checkAuth() {
  try {
    const headers = authToken.value ? { Authorization: `Bearer ${authToken.value}` } : {}
    const res = await fetch('/api/auth/check', { headers })
    const data = await res.json()
    if (!data.need_password || data.authenticated) {
      authenticated.value = true
    }
  } catch {}
  authChecking.value = false
}

async function doLogin() {
  loginError.value = ''
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginPassword.value }),
    })
    if (!res.ok) {
      loginError.value = '密码错误'
      return
    }
    const data = await res.json()
    authToken.value = data.token
    localStorage.setItem('authToken', data.token)
    authenticated.value = true
  } catch {
    loginError.value = '登录失败'
  }
}

// Inject auth token into all fetch requests
const _origFetch = window.fetch
window.fetch = function(url, opts = {}) {
  if (authToken.value && typeof url === 'string' && url.startsWith('/api/')) {
    opts.headers = opts.headers || {}
    if (opts.headers instanceof Headers) {
      opts.headers.set('Authorization', `Bearer ${authToken.value}`)
    } else {
      opts.headers['Authorization'] = `Bearer ${authToken.value}`
    }
  }
  return _origFetch.call(this, url, opts)
}

onMounted(() => {
  if (!isScreenshotMode) checkAuth()
})

const themes = [
  { id: 'dark',   label: '深蓝', color: '#1a1a2e' },
  { id: 'wechat', label: '微信', color: '#95ec69' },
  { id: 'light',  label: '浅色', color: '#ffffff' },
  { id: 'warm',   label: '暖棕', color: '#8b5e3c' },
  { id: 'purple', label: '紫夜', color: '#6a2fad' },
]
const currentTheme = ref(localStorage.getItem('theme') || 'dark')
applyTheme(currentTheme.value)

function applyTheme(id) {
  currentTheme.value = id
  document.documentElement.setAttribute('data-theme', id === 'dark' ? '' : id)
  localStorage.setItem('theme', id)
}

function selectConversation(conv) {
  activeConversation.value = conv
  searchHighlight.value = ''
  if (mobileLayout.matches) sidebarOpen.value = false
}

function onConversationDeleted(convId) {
  if (activeConversation.value?.conv_id === convId) {
    activeConversation.value = null
  }
}

function navigateToMessage(item) {
  activeConversation.value = {
    conv_id: item.conv_id,
    name: item.conv_name || '未知',
  }
  searchHighlight.value = item.search_query ?? ''
  jumpToSeq.value = item.seq || null
  // 手机端查找面板盖住了聊天区，跳转后先收起它（覆盖层，不影响聊天区排版，无需滚动锚定）
  if (mobileLayout.matches) searchOpen.value = false
}
</script>

<template>
  <!-- Screenshot mode: chrome-less static render for headless capture -->
  <ScreenshotView v-if="isScreenshotMode" />
  <!-- Loading -->
  <div v-else-if="authChecking" class="login-screen">
    <div class="login-box">
      <div class="login-loading">Loading...</div>
    </div>
  </div>
  <!-- Login -->
  <div v-else-if="!authenticated" class="login-screen">
    <div class="login-box">
      <div class="login-title">抖音聊天记录</div>
      <div class="login-subtitle">请输入密码</div>
      <form @submit.prevent="doLogin" class="login-form">
        <input
          v-model="loginPassword"
          type="password"
          placeholder="密码"
          class="login-input"
          autofocus
        />
        <button type="submit" class="login-btn">登录</button>
      </form>
      <div v-if="loginError" class="login-error">{{ loginError }}</div>
    </div>
  </div>
  <!-- Main app -->
  <div v-else class="app-layout">
    <div class="sidebar-overlay" :class="{ visible: sidebarOpen }" @click="sidebarOpen = false"></div>
    <div id="conversation-sidebar" class="app-sidebar" :class="{ open: sidebarOpen }" :inert="!sidebarOpen">
      <ConversationList
        :activeId="activeConversation?.conv_id"
        @select="selectConversation"
        @deleted="onConversationDeleted"
      />
    </div>
    <div class="app-main">
      <div class="app-toolbar">
        <button class="sidebar-toggle" :aria-label="sidebarOpen ? '收起会话列表' : '展开会话列表'" :title="sidebarOpen ? '收起会话列表' : '展开会话列表'" :aria-expanded="sidebarOpen" aria-controls="conversation-sidebar" @click="sidebarOpen = !sidebarOpen">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <div class="app-title"><span>抖音聊天记录</span></div>
        <button class="search-toggle" :disabled="!activeConversation" :aria-expanded="searchOpen" aria-label="查找聊天记录" title="查找聊天记录" @click="searchOpen ? closeSearch() : setSearchOpen(true)">
          <svg class="search-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <span class="search-toggle-label">⌕ 查找聊天记录</span>
        </button>
        <div class="theme-switcher">
          <button
            v-for="t in themes"
            :key="t.id"
            class="theme-btn"
            :class="{ active: currentTheme === t.id }"
            :title="t.label"
            :style="{ background: t.color }"
            @click="applyTheme(t.id)"
          />
        </div>
      </div>
      <div ref="readerLayout" class="reader-layout">
        <MessageList
          :conversation="activeConversation"
          :searchHighlight="searchHighlight"
          :jumpToSeq="jumpToSeq"
          @jumped="jumpToSeq = null"
        />
        <div v-if="searchMounted && activeConversation" v-show="searchOpen" class="search-slot">
          <SearchBar :convId="activeConversation.conv_id" :convName="activeConversation.name" @navigate="navigateToMessage" @close="closeSearch" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Allocate the panel once; animate only its contents, without reflowing chat. */
.search-slot > .search-panel { --panel-offset: 12px; animation: panel-enter .16s cubic-bezier(.2, 0, .2, 1); }
.app-sidebar.open > :deep(.conv-list) { --panel-offset: -12px; animation: panel-enter .16s cubic-bezier(.2, 0, .2, 1); }
@keyframes panel-enter {
  from { opacity: .75; transform: translateX(var(--panel-offset)); }
  to { opacity: 1; transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
  .search-slot > .search-panel, .app-sidebar.open > :deep(.conv-list) { animation: none; }
}

.reader-layout { display: flex; flex: 1; min-height: 0; overflow: hidden; position: relative; }
.reader-layout > .msg-panel { min-width: 0; }
.search-slot { flex: 0 0 320px; width: 320px; min-height: 0; overflow: hidden; }
@media (max-width: 800px) {
  .search-slot { position: absolute; inset: 0 0 0 auto; width: min(340px, 100%); z-index: 120; box-shadow: -8px 0 28px #0003; }
}
/* 手机竖屏：查找面板占满聊天区，不留一条看不清的聊天缝 */
@media (max-width: 600px) {
  .search-slot { width: 100%; box-shadow: none; }
}
.search-toggle { padding: 5px 10px; background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
.search-toggle-icon { display: none; width: 18px; height: 18px; }
.search-toggle:hover:not(:disabled), .search-toggle[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
.search-toggle:disabled { opacity: .4; cursor: default; }

.login-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  height: 100dvh;
  padding: 16px;
  background: var(--bg-primary);
}
.login-box {
  text-align: center;
  padding: 40px;
  background: var(--bg-secondary);
  border-radius: 16px;
  border: 1px solid var(--border-color);
  min-width: min(300px, 100%);
}
.login-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 6px;
}
.login-subtitle {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 24px;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.login-input {
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 15px;
  outline: none;
  text-align: center;
}
.login-input:focus {
  border-color: var(--accent);
}
.login-btn {
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
}
.login-btn:hover {
  filter: brightness(1.15);
}
.login-error {
  margin-top: 12px;
  color: #ff4d4f;
  font-size: 13px;
}
.login-loading {
  color: var(--text-muted);
  font-size: 14px;
}

.app-layout {
  display: flex;
  height: 100vh;
  height: 100dvh;
}

.app-sidebar {
  width: 300px;
  flex-shrink: 0;
}

.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.app-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 11px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.app-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--text-primary);
  letter-spacing: 0.01em;
  min-width: 0;
}
.app-title > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.app-title::before {
  content: "";
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent);
}


.theme-switcher {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
}

.theme-btn {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  padding: 0;
}

.theme-btn:hover {
  transform: scale(1.15);
}

.theme-btn.active {
  transform: scale(1.1);
  box-shadow: 0 0 0 2px var(--bg-secondary), 0 0 0 4px var(--accent);
}

.sidebar-toggle {
  display: flex;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 22px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.sidebar-toggle:hover {
  background: var(--bg-tertiary);
}

.sidebar-overlay {
  display: none;
}

@media (min-width: 769px) {
  .app-sidebar:not(.open) { display: none; }
}

@media (max-width: 768px) {
  .sidebar-toggle {
    display: block;
  }

  .app-sidebar {
    position: fixed;
    left: 0;
    top: 0;
    height: 100vh;
    height: 100dvh;
    z-index: 1000;
    transform: translateX(-100%);
    width: min(300px, 85vw);
  }

  .app-sidebar.open {
    transform: translateX(0);
  }

  .sidebar-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999;
    opacity: 0;
    pointer-events: none;
  }

  .sidebar-overlay.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* 工具栏压成一行：标题可省略、查找只留图标，主题色点缩小 */
  .app-toolbar {
    padding: 6px 10px 6px 4px;
    gap: 6px;
    min-height: 48px;
  }

  .sidebar-toggle {
    padding: 8px;
  }

  .app-title {
    flex: 1;
    font-size: 14px;
  }

  .search-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: 8px;
  }
  .search-toggle-icon { display: block; }
  .search-toggle-label { display: none; }

  .theme-switcher {
    flex-shrink: 0;
    margin-left: 0;
    gap: 4px;
  }

  .theme-btn {
    width: 22px;
    height: 22px;
    border: 4px solid var(--bg-secondary);
    box-sizing: border-box;
    background-clip: padding-box;
  }
  .theme-btn.active {
    box-shadow: 0 0 0 2px var(--accent);
  }

}
</style>
