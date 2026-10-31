import { h } from './dom.js';

const api = window.api;
const root = document.getElementById('root')!;

// Способ по умолчанию: окно claude.ai внутри приложения. Вход (включая через Google) проходит как обычно,
// приложение само замечает появившуюся сессию и закрывает окно — ничего переносить вручную не нужно.
const openBtn = h('button', { class: 'primary', dataset: { testid: 'open-login-window' }, onclick: () => void api.login.openInApp() }, 'Открыть окно входа');

// Второй способ: взять уже существующую сессию из установленного Claude Desktop (если он есть и вы в нём вошли).
// Ничего спрашивать не нужно — приложение читает и сразу проверяет её запросом к claude.ai.
const desktopBtn = h('button', { dataset: { testid: 'try-desktop' } }, 'Через Claude Desktop');
const desktopResult = h('div', { class: 'small', style: 'margin-top:8px;white-space:pre-wrap', dataset: { testid: 'desktop-result' } });
desktopBtn.addEventListener('click', async () => {
  desktopBtn.disabled = true;
  desktopResult.className = 'small';
  desktopResult.textContent = 'Проверяю…';
  try {
    const r = await api.login.tryDesktop();
    desktopResult.className = r.ok ? 'notice' : 'notice bad';
    desktopResult.textContent = r.message;
  } catch (e) {
    desktopResult.className = 'notice bad';
    desktopResult.textContent = (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '');
  } finally {
    desktopBtn.disabled = false;
  }
});

// Запасной способ (collapsed): перенос cookie sessionKey из обычного браузера — на случай, если окно
// приложения не проходит проверку Cloudflare или вход в нём заблокирован.
const input = h('input', {
  type: 'password', // значение скрыто на экране; это секрет сессии
  placeholder: 'Значение cookie sessionKey',
  autocomplete: 'off',
  spellcheck: false,
  style: 'width:100%',
  dataset: { testid: 'session-key' },
});
const result = h('div', { class: 'small', style: 'min-height:42px;white-space:pre-wrap', dataset: { testid: 'login-result' } });
const cloudflareBtn = h('button', { style: 'display:none', onclick: () => void api.login.openPage() }, 'Открыть claude.ai в приложении для проверки');
const submit = h('button', { class: 'primary', dataset: { testid: 'login-submit' } }, 'Войти');

async function doImport(): Promise<void> {
  submit.disabled = true;
  cloudflareBtn.style.display = 'none';
  result.className = 'small';
  result.textContent = 'Проверяю…';
  try {
    const r = await api.login.importSessionKey(input.value);
    result.className = r.ok ? 'notice' : 'notice bad';
    result.textContent = r.message;
    if (r.ok) input.value = '';
    if (r.cloudflare) cloudflareBtn.style.display = '';
  } catch (e) {
    // LoginInputError приходит из главного процесса; убираем служебную обёртку Electron.
    result.className = 'notice bad';
    result.textContent = (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '');
  } finally {
    submit.disabled = false;
  }
}
submit.addEventListener('click', () => void doImport());
input.addEventListener('keydown', (e) => e.key === 'Enter' && void doImport());

root.append(
  h(
    'div',
    { class: 'login-box' },
    h('h1', {}, 'Вход в Claude'),
    h('p', { class: 'hint' }, 'Откроется окно claude.ai. Войдите как обычно, включая через Google: окно закроется само, как только появится сессия.'),
    h(
      'div',
      { class: 'panel' },
      h('div', { class: 'row-inline' }, openBtn, h('span', { class: 'small' }, 'ничего копировать не нужно')),
      h('div', { class: 'row-inline', style: 'margin-top:8px' }, desktopBtn, h('span', { class: 'small' }, 'если Claude Desktop уже установлен и вы в нём вошли')),
      desktopResult,
    ),
    h(
      'details',
      { class: 'panel' },
      h('summary', { dataset: { testid: 'fallback-summary' } }, 'Не получилось? Другой способ'),
      h(
        'p',
        { class: 'small', style: 'margin-top:10px' },
        'Если окно выше не проходит проверку сайта, попробуйте ',
        h('span', { class: 'link', onclick: () => void api.login.openPage() }, 'открыть claude.ai отдельным окном'),
        ' и войти там, либо войдите в своём обычном браузере и перенесите сюда одну cookie сессии (sessionKey, из вкладки «Приложение» / Application → Cookies инструментов разработчика, F12).',
      ),
      h('div', { class: 'row-inline' }, h('button', { dataset: { testid: 'open-browser' }, onclick: () => void api.login.openClaudeInBrowser() }, 'Открыть claude.ai в браузере')),
      h('div', { class: 'row-inline', style: 'flex-wrap:nowrap;margin-top:8px' }, input, submit),
      result,
      cloudflareBtn,
    ),
    h(
      'p',
      { class: 'small' },
      'Сессия хранится только в профиле виджета и нигде не логируется. Не нажимайте «Выйти» на claude.ai: сессия закроется на сервере, и вход понадобится снова.',
    ),
  ),
);
