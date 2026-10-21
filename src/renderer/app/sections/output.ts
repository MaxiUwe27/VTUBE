// 7. Ausgabe: OBS browser source (local server) and virtual camera (v4l2loopback).

import type { AppContext, SectionModule } from '../context';
import { button, codeBox, hint, iconButton, infoGrid, section, statusDot, subhead } from '../controls';
import { h, setText, toggleClass } from '../dom';
import { toast } from '../toast';
import type { VideoDeviceInfo } from '../../../shared/api';
import { VCAM_DEFAULT_DEVICE, VCAM_SETUP } from '../../../shared/vcamSetup';

export function outputSection(ctx: AppContext): SectionModule {
  const { ui, live, actions, store } = ctx;

  // --- OBS browser source ---------------------------------------------------------------------
  const serverInfo = infoGrid([
    { key: 'state', label: 'Server' },
    { key: 'clients', label: 'OBS/Browser verbunden' },
  ]);
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
    serverInfo.set('clients', enabled && s?.running && typeof s.clients === 'number' ? String(s.clients) : '–');
    url.setText(s?.url && s.running ? s.url : '–');
    copyBtn.disabled = openBtn.disabled = !(s?.running && s.url);
    serverError.textContent = s?.error ?? '';
    toggleClass(serverError, 'hidden', !(enabled && s?.error));
  };
  ctx.on('server', renderServer);
  ui.bind(renderServer);
  // Keep the "OBS/Browser verbunden" count live while this section is open.
  setInterval(() => {
    if (sec.open && document.visibilityState === 'visible' && store.value.output.browserSource.enabled) {
      void actions.refreshServerInfo();
    }
  }, 3000);

  // --- Virtual camera ------------------------------------------------------------------------
  // The effective device comes from main (live.vcam.device/deviceSource): --vcam-device >
  // VTUBE_CAM_DEVICE > setting > /dev/video10. The UI never picks a device by itself.
  let devices: VideoDeviceInfo[] | null = null; // null = not listed yet
  const fixedBy = (): string | null =>
    live.vcam.deviceSource === 'cli' ? '--vcam-device' : live.vcam.deviceSource === 'env' ? 'VTUBE_CAM_DEVICE' : null;
  const currentDevice = () => live.vcam.device || store.value.output.virtualCam.device;
  const devLabel = (d: VideoDeviceInfo) => `${d.label || 'ohne Namen'} – ${d.path}`;
  const holderText = (d: VideoDeviceInfo) => d.busyBy.map((b) => `${b.name} (PID ${b.pid})`).join(', ');

  const devRefresh = iconButton('refresh', 'Videogeräte aktualisieren', () => void loadDevices(true));
  const devInput = ui.text({
    label: 'Gerät',
    hint: `v4l2loopback-Gerät, in das VTube Linux schreibt, z. B. ${VCAM_DEFAULT_DEVICE} (Auswahl oder freie Eingabe). ` +
      'Jedes Programm mit virtueller Kamera braucht ein eigenes Gerät.',
    placeholder: VCAM_DEFAULT_DEVICE,
    // Fixed by CLI/env: show the effective device, read-only (the stored setting is left untouched).
    get: (s) => (fixedBy() ? currentDevice() : s.output.virtualCam.device),
    set: (v) => ({ output: { virtualCam: { device: v } } }),
    enabled: () => !fixedBy(),
    extra: devRefresh,
  });
  const devInfo = h('p', { class: 'hint hidden' });
  const devWarn = h('div', { class: 'alert alert-warn hidden' });

  const renderDevInfo = () => {
    const v = live.vcam;
    const dev = currentDevice();
    const fixed = fixedBy();
    const info: string[] = [];
    const warn: string[] = [];
    if (fixed) info.push(`Festgelegt durch ${fixed} – die Einstellung wird ignoriert.`);
    if (devices) {
      const d = devices.find((x) => x.path === dev);
      const loop = devices.filter((x) => x.loopback);
      if (!d) {
        warn.push(`${dev} existiert nicht: v4l2loopback ist nicht geladen oder hat andere Gerätenummern ` +
          '(z. B. weil OBS das Modul selbst mit nur einem Gerät geladen hat). Siehe „Einrichtung“ unten.' +
          (loop.length ? `\nVorhandene virtuelle Kameras: ${loop.map(devLabel).join(', ')}` : ''));
      } else if (!d.loopback && !d.label) {
        info.push(`Treiber von ${dev} unbekannt (sysfs nicht lesbar).`);
      } else if (!d.loopback) {
        warn.push(`${dev}${d.label ? ` („${d.label}“)` : ''} ist eine echte Kamera, kein v4l2loopback-Gerät – ` +
          'dorthin kann VTube Linux nicht senden.');
      } else {
        info.push(`„${d.label || '?'}“ (v4l2loopback) – unter diesem Namen erscheint die Kamera in OBS, Discord usw.`);
        if (d.busyBy.length && v.running) info.push(`Zuschauer: ${holderText(d)}.`);
        else if (d.busyBy.length) {
          // Information only: viewers (OBS source, Discord) commonly keep the device open. If another
          // program already sends pictures into it, the kernel refuses our ffmpeg and the error says so.
          info.push(`Geöffnet von: ${holderText(d)}. Zuschauer (z. B. OBS-Quelle, Discord) sind in Ordnung; ` +
            'sendet dort schon eine andere virtuelle Kamera, schlägt der Start fehl – dann braucht VTube Linux ein eigenes Gerät.');
        }
        if (/\bobs\b/i.test(d.label)) {
          warn.push(`Achtung: ${dev} heißt „${d.label}“ und ist für die virtuelle Kamera von OBS gedacht. ` +
            'Startet OBS seine virtuelle Kamera, schreiben beide Programme in dasselbe Gerät. ' +
            'Für VTube Linux ein eigenes Gerät anlegen (siehe „Einrichtung“).');
        }
      }
    }
    setText(devInfo, info.join(' '));
    toggleClass(devInfo, 'hidden', info.length === 0);
    setText(devWarn, warn.join('\n'));
    toggleClass(devWarn, 'hidden', warn.length === 0);
  };

  async function loadDevices(manual = false): Promise<void> {
    try {
      devices = await window.vtube.listVideoDevices();
      const running = live.vcam.running ? live.vcam.device : null;
      // Only v4l2loopback devices are offered; real cameras can still be typed (and get rejected).
      devInput.setSuggestions(devices.filter((d) => d.loopback).map((d) => ({
        value: d.path,
        label: devLabel(d) + (d.path === running ? ' (VTube Linux sendet)'
          : d.busyBy.length ? ` (belegt von ${[...new Set(d.busyBy.map((b) => b.name))].join(', ')})` : ''),
      })));
      renderDevInfo();
      if (manual) {
        const loop = devices.filter((d) => d.loopback);
        toast(loop.length ? `Virtuelle Kameras: ${loop.map(devLabel).join(', ')}` : 'Keine v4l2loopback-Geräte gefunden – siehe „Einrichtung“.',
          loop.length ? 'info' : 'warning', 4000);
      }
    } catch (err) {
      if (manual) toast('Videogeräte konnten nicht aufgelistet werden.', 'error');
      console.warn('[ui] listVideoDevices failed', err);
    }
  }
  // First listing happens in the initial renderVcam() below.

  const vcamBtn = button('Starten', { icon: 'play', variant: 'primary' });
  vcamBtn.addEventListener('click', () => {
    if (live.vcam.busy) return;
    // Stop: first hand pending setting changes (device/size/fps) to main, so a restart they trigger
    // is queued before – not after – the stop (main serializes start/stop, last request wins).
    void (live.vcam.running ? store.flush().then(() => actions.vcamStop()) : actions.vcamStart());
  });
  const vcamState = h('div', { class: 'with-dot vcam-state' });
  const vcamError = h('div', { class: 'alert alert-error hidden' });
  const setup = h('details', { class: 'setup' },
    h('summary', null, 'Einrichtung (einmalig): v4l2loopback'),
    hint('Jedes Programm mit eigener virtueller Kamera (OBS, VTube Linux, …) braucht ein eigenes Gerät, ' +
      'sonst überschreiben sie sich gegenseitig. Der Name („VTube Linux“) gehört zum Gerät, nicht zum Programm. ' +
      `VTube Linux schreibt nur in das oben eingestellte Gerät (Standard ${VCAM_DEFAULT_DEVICE}). ` +
      'Die virtuelle Kamera von OBS nimmt das erste freie Gerät – deshalb bekommt OBS die kleinere Nummer (/dev/video9).'),
    hint('1. Kernel-Modul installieren (Fedora/Nobara, benötigt RPM Fusion):'),
    codeBox(VCAM_SETUP.install).el,
    hint('2. Ein bereits geladenes Modul entladen (z. B. von OBS mit nur einem Gerät geladen). ' +
      'Vorher OBS, Discord, Browser usw. schließen, sonst „Module v4l2loopback is in use“:'),
    codeBox(VCAM_SETUP.unload).el,
    hint('3. Zwei Geräte anlegen – /dev/video9 „OBS Virtual Camera“ und /dev/video10 „VTube Linux“ ' +
      '(nach jedem Neustart nötig, siehe 4.):'),
    codeBox(VCAM_SETUP.load).el,
    hint('4. Optional dauerhaft beim Systemstart mit diesen Einstellungen laden:'),
    codeBox(VCAM_SETUP.persist).el,
    hint('Danach in OBS, Discord, Zoom usw. die Kamera „VTube Linux“ auswählen. ' +
      'Kontrolle: App mit --list-devices starten (zeigt alle Geräte und wer sie benutzt).'));

  let devKey = '';
  const renderVcam = () => {
    const v = live.vcam;
    // Device/state changed -> re-list devices (labels, users) and refresh the (possibly fixed) input.
    const key = `${v.device}|${v.deviceSource}|${v.running}|${v.error ?? ''}`;
    if (key !== devKey) {
      const fixedChanged = devKey.split('|')[1] !== String(v.deviceSource) || devKey.split('|')[0] !== v.device;
      devKey = key;
      if (fixedChanged) ui.refreshAll();
      renderDevInfo();
      void loadDevices();
    }
    vcamBtn.disabled = v.busy;
    vcamBtn.className = `btn ${v.running ? 'btn-danger' : 'btn-primary'}`;
    vcamBtn.replaceChildren(...button(v.busy ? (v.running ? 'Stoppe…' : 'Starte…') : v.running ? 'Stoppen' : 'Starten', { icon: v.running ? 'stop' : 'play' }).childNodes);
    vcamState.replaceChildren(
      statusDot(v.running ? 'ok' : v.error ? 'error' : 'off'),
      h('span', null, v.running ? `Sendet an ${currentDevice()}${fixedBy() ? ' (festgelegt)' : ''}` : v.error ? 'Fehler' : 'Gestoppt'));
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
      h('li', null, 'Der Hintergrund der Browserquelle ist standardmäßig transparent (das Grün gilt nur für dieses Fenster). Farbe erzwingen: ', h('code', null, '?bg=00ff00'), ', App-Hintergrund übernehmen: ', h('code', null, '?bg=app'), '.'),
      h('li', null, 'Probleme zeigt die Seite oben links an; Diagnose: URL mit ', h('code', null, '?debug'), '.')),
    subhead('Virtuelle Kamera'),
    devInput.el,
    devInfo,
    devWarn,
    ui.segmented<string>({
      label: 'Auflösung',
      stacked: true,
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
