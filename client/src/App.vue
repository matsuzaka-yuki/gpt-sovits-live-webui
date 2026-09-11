<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
const config = ref(null), state = ref({ queue: [], history: [] });
const text = ref(''), tab = ref('studio'), error = ref(''), notice = ref('');
const connected = ref(false), apiOnline = ref(false), busy = ref(false);
const devices = ref([]), qr = ref(''), address = ref(''), showPhone = ref(false), firewall = ref(null);
const selected = ref('_custom'), phrase = ref('');
let socket, retry, poll, disposed = false;
const ready = computed(() => Boolean(config.value?.activeParams?.ref_audio_path?.trim()));
const pending = computed(() => state.value.queue.filter(t => t.id !== state.value.currentTask?.id));
const labels = { pending: '等待', synthesizing: '合成中', playing: '播放中', completed: '已播放', cancelled: '已取消', error: '失败', ready: '已合成' };
async function request(url, body, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.success === false) throw new Error(result.message || '请求失败');
  return result;
}
async function run(fn) {
  error.value = ''; notice.value = '';
  try { await fn(); } catch (e) { error.value = e.message; }
}
function receiveConfig(value) {
  config.value = value;
  selected.value = value.presets?.[value.currentPresetName] ? value.currentPresetName : '_custom';
}
async function refresh(initial = false) {
  try {
    const result = await request('/api/status', undefined, 'GET');
    apiOnline.value = result.apiConnected;
    qr.value = result.qrDataUrl; address.value = result.accessUrl;
    firewall.value = result.firewall || null;
    if (initial) { receiveConfig(result.config); state.value = result.state; }
  } catch { apiOnline.value = false; }
}
function connect() {
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  socket.onopen = () => { connected.value = true; };
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.data) state.value = msg.data;
    if (msg.config) receiveConfig(msg.config);
  };
  socket.onclose = () => {
    connected.value = false;
    if (!disposed) retry = setTimeout(connect, 2000);
  };
}
async function submit(value = text.value) {
  if (busy.value || !value.trim()) return;
  busy.value = true;
  await run(async () => {
    await request('/api/tts', { text: value, presetName: selected.value, params: structuredClone(JSON.parse(JSON.stringify(config.value.activeParams))) });
    if (text.value === value) text.value = '';
    notice.value = '已加入电脑播放队列';
  });
  busy.value = false;
}
function keydown(event) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); submit();
  }
}
function choosePreset() {
  if (selected.value !== '_custom') {
    config.value.activeParams = structuredClone(JSON.parse(JSON.stringify(config.value.presets[selected.value])));
    config.value.currentPresetName = selected.value;
    notice.value = '已选择音色参数：' + selected.value;
  }
}
async function save() {
  await run(async () => {
    const result = await request('/api/config', config.value);
    receiveConfig(result.config); notice.value = '设置已保存';
  });
}
async function importPresets() {
  await run(async () => {
    const result = await request('/api/config/import-gag', { path: config.value.gagConfigPath });
    receiveConfig(result.config);
    notice.value = '已导入 ' + Object.keys(result.config.presets).length + ' 个音色预设';
  });
}
function selectPhrase(value) { text.value = value; notice.value = '已填入常用语，点击合成播放即可'; }
async function addPhrase() {
  if (!phrase.value.trim()) return;
  config.value.quickTexts.push(phrase.value.trim()); phrase.value = ''; await save();
}
onMounted(async () => {
  await refresh(true); connect();
  run(async () => { devices.value = (await request('/api/devices', undefined, 'GET')).devices; });
  poll = setInterval(() => refresh(), 15000);
});
onUnmounted(() => { disposed = true; clearInterval(poll); clearTimeout(retry); socket?.close(); });
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/"><span class="brand-mark">S</span><div>SoVITS <strong>Live</strong><small>直播语音控制台</small></div></a>
      <nav><button :class="{ selected: tab === 'studio' }" @click="tab = 'studio'">控制台</button><button :class="{ selected: tab === 'settings' }" @click="tab = 'settings'">设置</button><button @click="showPhone = true">手机连接</button></nav>
    </header>
    <div class="statusline"><span><i :class="{ online: connected }"></i>{{ connected ? '控制台已连接' : '控制台连接中' }}</span><span><i :class="{ online: apiOnline }"></i>{{ apiOnline ? '合成服务在线' : '合成服务离线' }}</span><span class="output-note">音频在电脑端播放</span></div>
    <div v-if="error" role="alert" class="message error">{{ error }}<button @click="error = ''">关闭</button></div>
    <div v-else-if="notice" role="status" class="message">{{ notice }}</div>
    <div v-if="!config" class="panel">正在连接控制台…</div>
    <template v-else>
      <main v-if="tab === 'studio'" class="studio">
        <section class="composer panel">
          <div class="section-top"><div><div class="eyebrow">文字转语音</div><h1>下一句，说什么？</h1></div><span class="counter">{{ text.length }} / 3000</span></div>
          <textarea v-model="text" maxlength="3000" @keydown="keydown" placeholder="输入要说的话，合成后会在电脑上播放。" aria-label="合成文本"></textarea>
          <div class="composer-options"><label>音色预设<select v-model="selected" @change="choosePreset"><option value="_custom">当前自定义参数</option><option v-for="(_, name) in config.presets" :key="name" :value="name">{{ name }}{{ config.presets[name].ref_audio_path ? '' : ' · 未配置' }}</option></select></label><label>语速<span class="speed"><input type="range" min="0.6" max="1.6" step="0.05" v-model.number="config.activeParams.speed_factor"><b>{{ Number(config.activeParams.speed_factor || 1).toFixed(2) }}×</b></span></label></div>
          <div v-if="!ready" class="setup-hint">此预设没有参考音频。<button @click="tab = 'settings'">前往设置</button></div>
          <div class="composer-footer"><span>Ctrl / ⌘ + Enter 合成 · Enter 换行</span><button class="primary" :disabled="busy || !ready || !text.trim() || !connected" @click="submit()">{{ busy ? '提交中…' : '合成并播放' }} <span>↗</span></button></div>
        </section>
        <aside class="panel playback">
          <div class="section-top"><h2>电脑播放</h2><span class="tag">{{ labels[state.currentTask?.status] || '空闲' }}</span></div>
          <div class="meters" :class="{ moving: state.currentTask?.status === 'playing' }"><i v-for="n in 24" :key="n" :style="{ '--h': (12 + (n * 17 % 49)) + 'px', animationDelay: (n % 5 * 0.1) + 's' }"></i></div>
          <p class="now-text">{{ state.currentTask?.text || '等待下一句语音' }}</p>
          <p class="muted">{{ state.currentTask ? '手机离开页面后，电脑仍会继续播放。' : '合成完成后自动播放，按提交顺序依次进行。' }}</p>
          <div class="transport"><button :disabled="!state.currentTask" @click="run(() => request('/api/control/stop'))">停止当前</button><button class="danger" :disabled="!state.queue.length" @click="run(() => request('/api/control/clear'))">停止并清空</button></div>
        </aside>
        <section class="panel phrases"><div class="section-top"><h2>常用语</h2><span class="muted">点击填入，确认后播放</span></div><div class="phrase-list"><button v-for="(item, index) in config.quickTexts" :key="index" @click="selectPhrase(item)"><span class="phrase-number">{{ String(index + 1).padStart(2, '0') }}</span>{{ item }}</button></div><form class="phrase-add" @submit.prevent="addPhrase"><input v-model="phrase" placeholder="添加一句常用语" aria-label="新增常用语"><button :disabled="!phrase.trim()">添加</button></form></section>
        <section class="panel activity"><div class="section-top"><h2>任务记录</h2><span class="muted">{{ pending.length }} 条等待</span></div>
          <p v-if="!state.queue.length && !state.history.length" class="empty">还没有任务。输入文字，开始第一次合成。</p>
          <article v-for="item in [...state.queue, ...state.history]" :key="item.id" class="task">
            <div class="task-heading"><span :class="['task-status', { failed: item.status === 'error' }]">{{ labels[item.status] }}</span><time>{{ new Date(item.createdAt).toLocaleTimeString() }}</time><span>{{ item.presetName === '_custom' ? '自定义' : item.presetName }}</span></div>
            <p>{{ item.text }}</p><p v-if="item.error" class="task-error">{{ item.error }}</p>
            <div class="task-actions"><button v-if="state.queue.some(t => t.id === item.id)" @click="run(() => request('/api/queue/' + item.id, undefined, 'DELETE'))">取消</button><button v-else @click="selectPhrase(item.text)">再次使用</button><audio v-if="item.audioUrl" :src="item.audioUrl" controls preload="none" aria-label="在当前设备试听"></audio><span v-if="item.audioUrl" class="muted">当前设备试听</span></div>
          </article>
        </section>
      </main>
      <main v-else class="settings panel">
        <div class="section-top"><div><div class="eyebrow">偏好设置</div><h1>声音与连接</h1></div><button class="primary" @click="save">保存设置</button></div>
        <fieldset><legend>音色参数</legend><p class="muted">导入 GUI 工作目录里的 GAG_config.json。模型仍使用现有 API 已加载的模型；导入不会切换模型。</p><label>GUI 配置文件路径<div class="inline"><input v-model="config.gagConfigPath" placeholder="例如 D:\\GPT-SoVITS\\GAG_config.json"><button @click="importPresets">导入预设</button></div></label><label>当前音色<select v-model="selected" @change="choosePreset"><option value="_custom">自定义</option><option v-for="(_, name) in config.presets" :key="name" :value="name">{{ name }}</option></select></label><label>参考音频路径<input v-model="config.activeParams.ref_audio_path" placeholder="GPT-SoVITS 服务能读取的音频文件路径"></label><label>参考音频对应文字<textarea class="short" v-model="config.activeParams.prompt_text" placeholder="与参考音频内容一致"></textarea></label>
          <div class="two"><label>参考语言<select v-model="config.activeParams.prompt_lang"><option value="all_zh">中文</option><option value="zh">中英混合</option><option value="en">英语</option><option value="ja">日语</option></select></label><label>合成语言<select v-model="config.activeParams.text_lang"><option value="all_zh">中文</option><option value="zh">中英混合</option><option value="en">英语</option><option value="ja">日语</option></select></label></div>
          <label>文本切分<select v-model="config.activeParams.text_split_method"><option value="cut0">不切分</option><option value="cut1">每四句切分</option><option value="cut2">约五十字切分</option><option value="cut3">按中文句号切分</option><option value="cut4">按英文句号切分</option><option value="cut5">按标点切分</option></select></label>
        </fieldset>
        <fieldset><legend>电脑音频输出</legend><label class="check"><input type="checkbox" v-model="config.autoPlayOnComputer">合成完成后自动在电脑播放</label><label>输出设备<select v-model="config.audioDevice"><option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option></select></label><label>音量 · {{ config.volume }}%<input type="range" min="0" max="150" step="5" v-model.number="config.volume"></label><p class="muted">音量和输出设备设置保存后，对下一条播放生效。选择指定输出设备需要 mpv。</p><label>播放器<select v-model="config.playbackBackend"><option value="auto">自动检测</option><option value="mpv">mpv</option><option value="ffplay">ffplay</option></select></label></fieldset>
        <fieldset><legend>合成服务</legend><label>API 地址<input v-model="config.apiEndpoint" placeholder="http://127.0.0.1:9880/tts"></label></fieldset>
      </main>
    </template>
    <footer>SoVITS Live <span>本地合成 · 局域网控制</span></footer>
    <div v-if="showPhone" class="overlay" @click.self="showPhone = false"><section class="dialog panel" role="dialog" aria-label="手机连接"><div class="section-top"><h2>手机连接</h2><button @click="showPhone = false">关闭</button></div><p class="muted">手机和电脑连接同一路由器，扫描二维码打开控制台。</p><img :src="qr" alt="手机访问二维码"><a :href="address">{{ address }}</a><div v-if="firewall && firewall.ok === false" class="firewall-hint"><p>{{ firewall.firewall }} 拦截了局域网访问，先在电脑上放行端口：</p><code>{{ firewall.fix }}</code></div></section></div>
  </div>
</template>
