// v4l2loopback setup commands for the virtual camera. Single source for the app UI, the main
// process error hints and `--list-devices`. Keep in sync with README.md / docs/BUILD.md.
//
// Why two devices: a v4l2loopback device carries ONE picture stream, and its name (card_label)
// belongs to the device, not to the program writing into it. OBS's own virtual camera does not ask
// which device to use – it takes the first free v4l2loopback device (lowest /dev/videoN). With only
// one device, OBS and VTube Linux write into the same one. So: OBS gets the lower number (9),
// VTube Linux writes only to the configured device (default /dev/video10).

import { DEFAULT_SETTINGS } from './settings';

/** Documented default device. */
export const VCAM_DEFAULT_DEVICE = DEFAULT_SETTINGS.output.virtualCam.device; // '/dev/video10'

/** Module options: two devices, distinct labels; lists are comma separated, one entry per device. */
export const VCAM_MODULE_OPTIONS =
  'devices=2 video_nr=9,10 card_label="OBS Virtual Camera,VTube Linux" exclusive_caps=1,1';

export const VCAM_SETUP = {
  install: 'sudo dnf install v4l2loopback',
  /** Fails with "Module v4l2loopback is in use" while any program has a loopback device open. */
  unload: 'sudo modprobe -r v4l2loopback',
  load: `sudo modprobe v4l2loopback ${VCAM_MODULE_OPTIONS}`,
  persist:
    'echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf\n' +
    `echo 'options v4l2loopback ${VCAM_MODULE_OPTIONS}' | sudo tee /etc/modprobe.d/v4l2loopback.conf`,
} as const;

/** Multi-line German hint used in main-process error messages. */
export const VCAM_SETUP_HINT =
  'Einrichtung (je ein eigenes Gerät für OBS und VTube Linux):\n' +
  `  ${VCAM_SETUP.install}\n` +
  `  ${VCAM_SETUP.unload}      # vorher OBS/Discord/Browser schließen\n` +
  `  ${VCAM_SETUP.load}`;
