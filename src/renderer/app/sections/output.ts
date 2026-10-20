// 7. Ausgabe: OBS browser source (local server) and virtual camera (v4l2loopback).

import type { AppContext, SectionModule } from '../context';
import { button, codeBox, hint, iconButton, infoGrid, section, statusDot, subhead } from '../controls';
import { h, setText, toggleClass } from '../dom';
import { toast } from '../toast';

const SETUP_INSTALL = 'sudo dnf install v4l2loopback';
const SETUP_LOAD = 'sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="VTube Linux" exclusive_caps=1';
const SETUP_PERSIST =
  'echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf\n' +
  'echo \'options v4l2loopback devices=1 video_nr=10 card_label="VTube Linux" exclusive_caps=1\' | sudo tee /etc/modprobe.d/v4l2loopback.conf';

export function outputSection(ctx: AppContext): SectionModule {
  const { ui, live, actions, store } = ctx;

  // --- OBS browser source ---------------------------------------------------------------------
  const serverInfo = infoGrid([{ key: 'state', label: 'Server' }]);
  const url = codeBox('–', 'URL kopieren');
  const copyBtn = button('URL kopieren', {
    icon: 'copy', variant: 'primary', small: true,
    onClick: () => {
      const u = live.server?.url;
      if (!u) return void toast('Der Server läuft nicht – keine URL verfügbar.', 'error');
      window.vtube.copyToClipboard(u);
      toast('URL kopiert – in OBS als Browser-Quelle einfügen.', 'success', 2500);
    },
  });
  const openBtn = button('Im Browser testen', {
    icon: 'external', variant: 'ghost', small: true,
    onClick: () => {
      const u = live.server?.url;
      if (u) void window.vtube.openExternal(u).catch(() => toast('Browser konnte nicht geöffnet werden.', 'error'));
    },
  });
  const serverError = h('div', { class: 'alert alert-error hidden' });

  const renderServer = () => {
    const s = live.server;
    const enabled = store.value.output.browserSource.enabled;
    if (!enabled) serverInfo.set('state', h('span', { class: 'with-dot' }, statusDot('off'), 'Deaktiviert'));
    else if (!s) serverInfo.set('state', h('span', { class: 'with-dot' }, statusDot('warn'), 'Unbekannt'));
    else if (s.running) serverInfo.set('state', h('span', { class: 'with-dot' }, statusDot('ok'), `Läuft auf Port ${s.port}`));
    else serverInfo.set('state', h('span', { class: 'with-dot' }, statusDot('error'), 'Gestoppt'));
    url.setText(s?.url && s.running ? s.url : '–');
    copyBtn.disabled = openBtn.disabled = !(s?.running && s.url);
    serverError.textContent = s?.error ?? '';
    toggleClass(serverError, 'hidden', !(enabled && s?.error));
  };
  ctx.on('server', renderServer);
  ui.bind(renderServer);

  // --- Virtual camera ------------------------------------------------------------------------
  const devRefresh = iconButton('refresh', 'Videogeräte aktualisieren', () => void loadDevices(true));
  const devInput = ui.text({
    label: 'Gerät',
    hint: 'v4l2loopback-Gerät, z. B. /dev/video10 (Auswahl oder freie Eingabe)',
    placeholder: '/dev/video10',
    get: (s) => s.output.virtualCam.device,
    set: (v) => ({ output: { virtualCam: { device: v } } }),
    extra: devRefresh,
  });
  async function loadDevices(manual = false): Promise<void> {
    try {
      const list = await window.vtube.listVideoDevices();
      devInput.setSuggestions(list);
      if (manual) toast(list.length ? `Gefunden: ${list.join(', ')}` : 'Keine Videogeräte gefunden.', list.length ? 'info' : 'warning', 3000);
    } catch (err) {
      if (manual) toast('Videogeräte konnten nicht aufgelistet werden.', 'error');
      console.warn('[ui] listVideoDevices failed', err);
    }
  }
  void loadDevices();

  const vcamBtn = button('Starten', { icon: 'play', variant: 'primary' });
  vcamBtn.addEventListener('click', () => {
    if (live.vcam.busy) return;
    void (live.vcam.running ? actions.vcamStop() : actions.vcamStart());
  });
  const vcamState = h('div', { class: 'with-dot vcam-state' });
  const vcamError = h('div', { class: 'alert alert-error hidden' });
  const setup = h('details', { class: 'setup' },
    h('summary', null, 'Einrichtung (einmalig): v4l2loopback'),
    hint('1. Kernel-Modul installieren (Fedora, benötigt RPM Fusion):'),
    codeBox(SETUP_INSTALL).el,
    hint('2. Virtuelle Kamera anlegen (nach jedem Neustart nötig, siehe 3.):'),
    codeBox(SETUP_LOAD).el,
    hint('3. Optional automatisch beim Systemstart laden:'),
    codeBox(SETUP_PERSIST).el,
    hint('Danach in OBS, Discord, Zoom usw. die Kamera „VTube Linux“ auswählen.'));

  const renderVcam = () => {
    const v = live.vcam;
    vcamBtn.disabled = v.busy;
    vcamBtn.className = `btn ${v.running ? 'btn-danger' : 'btn-primary'}`;
    vcamBtn.replaceChildren(...button(v.busy ? (v.running ? 'Stoppe…' : 'Starte…') : v.running ? 'Stoppen' : 'Starten', { icon: v.running ? 'stop' : 'play' }).childNodes);
    vcamState.replaceChildren(
      statusDot(v.running ? 'ok' : v.error ? 'error' : 'off'),
      h('span', null, v.running ? `Sendet an ${v.device || store.value.output.virtualCam.device}` : v.error ? 'Fehler' : 'Gestoppt'));
    setText(vcamError, v.error ?? '');
    toggleClass(vcamError, 'hidden', !v.error);
    if (v.error && !setup.open) setup.open = true;
    sec.badge.textContent = [store.value.output.browserSource.enabled && live.server?.running ? 'OBS' : '', v.running ? 'VCam' : ''].filter(Boolean).join(' · ');
    sec.badge.className = 'section-badge ok';
  };

  const sec = section('output', 'Ausgabe', 'broadcast', false,
    subhead('OBS Browser-Quelle'),
    ui.toggle({
      label: 'Browser-Quelle aktiv',
      hint: 'Lokalen Server für OBS starten (Avatar mit transparentem Hintergrund)',
      get: (s) => s.output.browserSource.enabled,
      set: (v) => ({ output: { browserSource: { enabled: v } } }),
    }),
    ui.number({
      label: 'Port',
      min: 1024, max: 65535,
      get: (s) => s.output.browserSource.port,
      set: (v) => ({ output: { browserSource: { port: v } } }),
      enabled: (s) => s.output.browserSource.enabled,
    }),
    serverInfo.el,
    url.el,
    h('div', { class: 'btn-row' }, copyBtn, openBtn),
    serverError,
    h('ol', { class: 'steps' },
      h('li', null, 'In OBS: ', h('b', null, 'Quellen → + → Browser'), '.'),
      h('li', null, 'URL einfügen, ', h('b', null, 'Breite 1920'), ', ', h('b', null, 'Höhe 1080'), '.'),
      h('li', null, 'Hintergrund ist automatisch ', h('b', null, 'transparent'), ' – kein Chroma-Key nötig.')),
    subhead('Virtuelle Kamera'),
    devInput.el,
    ui.segmented<string>({
      label: 'Auflösung',
      options: [
        { value: '640x360', label: '640×360' },
        { value: '1280x720', label: '1280×720' },
        { value: '1920x1080', label: '1920×1080' },
      ],
      get: (s) => `${s.output.virtualCam.width}x${s.output.virtualCam.height}`,
      set: (v) => {
        const [w, hh] = v.split('x').map(Number);
        return { output: { virtualCam: { width: w, height: hh } } };
      },
    }),
    ui.segmented<number>({
      label: 'FPS',
      options: [{ value: 30, label: '30' }, { value: 60, label: '60' }],
      get: (s) => s.output.virtualCam.fps,
      set: (v) => ({ output: { virtualCam: { fps: v } } }),
    }),
    h('div', { class: 'btn-row vcam-row' }, vcamBtn, vcamState),
    vcamError,
    setup,
    hint('Änderungen an Gerät, Auflösung oder FPS starten eine laufende virtuelle Kamera automatisch neu.'),
  );

  ctx.on('vcam', renderVcam);
  ctx.on('server', renderVcam);
  renderVcam();

  return { el: sec.el, isOpen: () => sec.open };
}
