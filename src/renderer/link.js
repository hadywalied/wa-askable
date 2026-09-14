// The linking flow, as one component used in two places: onboarding step 3 and
// Settings -> Connection. Two implementations would drift, and this is the one
// screen where a wrong or stale message costs the user their archive.

const STAGES = ['idle', 'connecting', 'qr', 'pairing', 'open', 'failed'];

export function mountLink(host, wa, opts = {}) {
  const tpl = document.getElementById('linkTemplate');
  host.replaceChildren(tpl.content.cloneNode(true));
  const root = host.querySelector('.link-stage');
  const el = (n) => root.querySelector(`[data-el="${n}"]`);
  const stage = (n) => root.querySelector(`[data-stage="${n}"]`);

  let manualStage = null; // 'pairing' is user-chosen, not derived from status
  let countdownTimer = null;

  function show(which) {
    for (const s of STAGES) stage(s).hidden = s !== which;
  }

  function render(c) {
    if (!c) return;
    if (manualStage === 'pairing' && c.state !== 'open') {
      show('pairing');
      return;
    }
    if (c.state === 'open') {
      manualStage = null;
      show('open');
      el('opendetail').textContent = c.capturedThisSession
        ? `${c.capturedThisSession} messages captured this session.`
        : 'Messages are archived as they arrive.';
      opts.onLinked?.();
      return;
    }
    if (c.qrDataUrl) {
      show('qr');
      el('qr').src = c.qrDataUrl;
      startCountdown(c.qrExpiresAt);
      return;
    }
    if (c.state === 'connecting') {
      show('connecting');
      el('detail').textContent = c.attempt
        ? `Attempt ${c.attempt + 1}. Waiting for WhatsApp to respond.`
        : 'Opening a connection.';
      return;
    }
    if (c.state === 'closed' || c.state === 'logged_out') {
      show('failed');
      el('why').textContent =
        c.state === 'logged_out'
          ? 'This device was unlinked from your phone. Capture has stopped — link again to resume.'
          : c.lastError || 'The connection closed before linking finished.';
      // Say that a retry is coming, so an automatic reconnect does not look
      // like the app giving up.
      el('retry').textContent = c.state === 'logged_out' ? '' : 'Retrying automatically in the background.';
      return;
    }
    show('idle');
  }

  function startCountdown(expiresAt) {
    clearInterval(countdownTimer);
    if (!expiresAt) { el('countdown').textContent = ''; return; }
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      el('countdown').textContent = left
        ? `This code refreshes in ${left}s — that is normal, keep scanning.`
        : 'Refreshing the code…';
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'connect') { manualStage = null; show('connecting'); await wa.connect(); }
      else if (act === 'cancel') { manualStage = null; await wa.disconnect(); }
      else if (act === 'disconnect') { await wa.disconnect(); }
      else if (act === 'pairing') { manualStage = 'pairing'; show('pairing'); }
      else if (act === 'qrback') { manualStage = null; render(await currentStatus()); }
      else if (act === 'logs') { await wa.openLogs(); }
      else if (act === 'getcode') {
        const phone = el('phone').value.trim();
        el('paircode').hidden = true;
        const { code } = await wa.requestPairingCode(phone);
        el('paircode').textContent = code;
        el('paircode').hidden = false;
        el('pairsteps').hidden = false;
      }
    } catch (err) {
      show('failed');
      el('why').textContent = err.message;
      el('retry').textContent = '';
    }
  });

  async function currentStatus() {
    return (await wa.getStatus()).connection;
  }

  return { render, destroy: () => clearInterval(countdownTimer) };
}
