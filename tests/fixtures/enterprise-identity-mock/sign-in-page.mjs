export const methods = {
  phone: { label: 'Phone app', grants: ['intranet', 'mail', 'model'], detail: 'Scan the code and confirm on your phone.' },
  web: { label: 'Web', grants: ['intranet'], detail: 'Use web sign-in to access internal systems.' },
  account: { label: 'Account', grants: ['model'], detail: 'Sign in to use models. No password is needed for this mock.' }
}

let qrEncoder

async function qrMarkup(qrContent) {
  qrEncoder ??= import('qrcode').then(module => module.default, () => null)
  const encoder = await qrEncoder
  if (!encoder) return `<code class="qr-text">${qrContent}</code>`
  const dataUrl = await encoder.toDataURL(qrContent, { width: 196 })
  return `<img class="qr" src="${dataUrl}" width="196" height="196" alt="Mock sign-in code">`
}

export async function signInPage(qrContent, labels) {
  const qr = await qrMarkup(qrContent)
  const tabs = Object.entries(methods).map(([id, method]) => `
    <button id="tab-${id}" type="button" role="tab" aria-controls="panel-${id}"
      aria-selected="${id === 'phone'}" tabindex="${id === 'phone' ? 0 : -1}">${method.label}</button>`).join('')
  const panels = Object.entries(methods).map(([id, method]) => `
    <section id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}" tabindex="0"${id === 'phone' ? '' : ' hidden'}>
      <p>${method.detail}</p>
      ${id === 'phone' ? `<div class="code">${qr}</div>` : ''}
      <p class="access"><strong>Access:</strong> ${method.grants.map(grant => labels[grant]).join(' · ')}</p>
      <div class="actions">
        ${id === 'phone' ? '<button type="button" class="scan" data-action="scan">Simulate scan</button>' : ''}
        <button type="button" class="confirm" data-action="confirm" data-method="${id}">Confirm (mock)</button>
      </div>
    </section>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Sign in · Example Org</title>
  <style>
    :root {
      color-scheme: light;
      --background: Canvas; --ink: CanvasText; --muted: color-mix(in srgb, CanvasText 70%, Canvas);
      --surface: color-mix(in srgb, CanvasText 4%, Canvas); --line: color-mix(in srgb, CanvasText 22%, Canvas);
      --cta: LinkText; --cta-ink: Canvas;
    }
    @media (prefers-color-scheme: dark) { :root { color-scheme: dark; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--background); color: var(--ink); font: 1rem/1.5 system-ui, sans-serif; }
    main { max-width: 34rem; margin: 0 auto; padding: clamp(1rem, 5vw, 3rem); }
    header { margin-bottom: 1.5rem; }
    .eyebrow { margin: 0; color: var(--muted); font-size: .8rem; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
    h1 { margin: .3rem 0; font-size: clamp(1.7rem, 6vw, 2.3rem); letter-spacing: -.04em; line-height: 1.15; }
    p { margin: 0 0 1rem; }
    header p:last-child, .access { color: var(--muted); }
    [role=tablist] { display: grid; grid-template-columns: repeat(3, 1fr); gap: .35rem; padding: .3rem; background: var(--surface); border-radius: .8rem; }
    button { min-height: 2.75rem; padding: .35rem .6rem; color: inherit; background: transparent; border: 0; border-radius: .55rem; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--cta); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .55; }
    [aria-selected=true] { background: var(--background); box-shadow: 0 0 0 1px var(--line); font-weight: 650; }
    [role=tabpanel] { padding-block: 1.2rem .2rem; }
    .code { display: grid; place-items: center; margin-bottom: 1rem; }
    .qr { display: block; max-width: 100%; height: auto; border-radius: .75rem; }
    .qr-text { padding: 1rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: .75rem; overflow-wrap: anywhere; }
    .access { font-size: .9rem; }
    .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; }
    .scan { border: 1px solid var(--line); }
    .confirm { background: var(--cta); color: var(--cta-ink); font-weight: 650; padding-inline: 1rem; }
    #status { margin: 1rem 0 0; padding-block: .7rem; border-top: 1px solid var(--line); font-weight: 650; }
    #error { color: var(--muted); }
  </style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">Example Org · Test sign-in</p>
    <h1>Sign in to Example Org</h1>
    <p>Choose how to sign in. This test does not use a real account.</p>
  </header>
  <div role="tablist" aria-label="Sign-in method">${tabs}</div>
  ${panels}
  <p id="status" role="status">Scan with the app</p>
  <p id="error" role="alert" hidden></p>
</main>
<script>
  const token = new URL(location.href).searchParams.get('token');
  const auth = { Authorization: 'Bearer ' + token };
  const tabs = Array.from(document.querySelectorAll('[role=tab]'));
  const buttons = Array.from(document.querySelectorAll('[data-action]'));
  const status = document.querySelector('#status');
  const error = document.querySelector('#error');
  const outcomes = { succeeded: 'Signed in', cancelled: 'Sign-in cancelled', expired: 'Sign-in expired', failed: 'Sign-in failed' };
  let selected = tabs[0];
  let state = { scanned: false };
  let pending = false;

  function render() {
    const message = state.outcome ? outcomes[state.outcome]
      : selected.id !== 'tab-phone' ? 'Ready to confirm'
      : state.scanned ? 'Confirm on your phone' : 'Scan with the app';
    if (status.textContent !== message) status.textContent = message;
    for (const button of buttons) {
      button.disabled = Boolean(pending || state.outcome || (button.dataset.action === 'scan' && state.scanned));
    }
  }

  function select(tab) {
    selected = tab;
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    render();
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const current = tabs.indexOf(tab);
      const target = { ArrowLeft: (current + tabs.length - 1) % tabs.length,
        ArrowRight: (current + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(tabs[target]);
      tabs[target].focus();
    });
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  async function poll() {
    if (state.outcome) return;
    try {
      const response = await fetch('/status', { headers: auth });
      if (response.status === 403) {
        state.outcome ||= 'cancelled';
        showError('This sign-in is no longer active. Start a new one in Halo.');
        render();
        return;
      }
      if (!response.ok) throw new Error('status');
      const latest = await response.json();
      state = { scanned: state.scanned || latest.scanned, outcome: state.outcome || latest.outcome };
      showError('');
      render();
    } catch {
      showError('Could not check sign-in. Trying again…');
    }
    if (!state.outcome) setTimeout(poll, 350);
  }

  for (const button of buttons) button.addEventListener('click', async () => {
    pending = true;
    render();
    try {
      const response = await fetch('/control', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: button.dataset.action, method: button.dataset.method })
      });
      if (!response.ok) throw new Error('control');
      state = await response.json();
      showError('');
    } catch {
      showError('Could not confirm this sign-in. Check its status and try again.');
    } finally {
      pending = false;
      render();
    }
  });
  poll();
</script>
</body>
</html>`
}
