// machine-state.js - per-machine client state.
//
// The channel deliberately no longer ships these files (see the NGE publisher's
// PER_MACHINE set): the mode a client starts in belongs to the machine, not to the
// download. Existing installs keep what they have - renderer.js never overwrites a
// protected local file - so the one gap left is a fresh install, where nothing has
// written options.cfg yet. The client does not create it on its own: started without
// one, swgclient_r.exe comes up with a 0x0 window.
//
// So the launcher writes one from this machine's own desktop mode, byte-for-byte the
// shape SwgClientSetup_r.exe writes (that tool owns the file afterwards, and the
// player is expected to change it with the client's own setup dialog, not by hand).

const fs = require('fs');
const path = require('path');

const OPTIONS_CFG = 'options.cfg';

// Same content SwgClientSetup_r.exe generates for a borderless-windowed client at
// the given mode. CRLF, one tab of indent, blank line between sections.
function buildOptionsCfg(width, height, refreshRate) {
  const w = Math.max(320, Math.round(Number(width) || 0));
  const h = Math.max(240, Math.round(Number(height) || 0));
  const rate = Math.max(1, Math.round(Number(refreshRate) || 60));
  return [
    '# options.cfg - Please do not edit this auto-generated file.',
    '',
    '[ClientAudio]',
    '\tsoundProvider="Windows Speaker Configuration"',
    '',
    '[ClientGame]',
    '\tpreloadWorldSnapshot=0',
    '',
    '[ClientGraphics]',
    '\tborderlessWindow=1',
    '\tuseHardwareMouseCursor=1',
    `\tscreenWidth=${w}`,
    `\tscreenHeight=${h}`,
    '\twindowed=1',
    '\tuseSafeRenderer=0',
    '\trasterMajor=7',
    '',
    '[Direct3d9]',
    '\tallowTearing=1',
    `\tfullscreenRefreshRate=${rate}`,
    '',
    '[SharedUtility]',
    '\tcache=misc/cache_large.iff',
    ''
  ].join('\r\n');
}

// The primary display in real pixels, as the client needs it. Electron reports the
// current desktop mode in DIPs, so the scale factor has to be folded back in: a
// 1920x1200 desktop at 125% scaling reads as 1536x960 in DIPs. (The launcher pins
// force-device-scale-factor to 1, so on this build DIPs are already real pixels.)
// This is only used to seed a file that does not exist yet; anything already there
// is left alone.
//
// Deliberately no refresh rate here: SwgClientSetup_r.exe writes 60 even on a 165 Hz
// desktop, and the mode we seed is borderless windowed, where the rate is unused.
function primaryDisplaySize() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
    refreshRate: 60
  };
}

// Create options.cfg when it is missing. An existing file is never touched: that is
// where the player's own resolution and the client's own choices live.
function ensureOptionsCfg(dir, display) {
  const target = path.join(dir, OPTIONS_CFG);
  if (fs.existsSync(target)) return { created: false, path: target };
  if (!display || !display.width || !display.height) {
    return { created: false, path: target, skipped: 'no display size available' };
  }
  fs.writeFileSync(target, buildOptionsCfg(display.width, display.height, display.refreshRate), 'utf8');
  return {
    created: true,
    path: target,
    width: Math.round(display.width),
    height: Math.round(display.height)
  };
}

module.exports = { OPTIONS_CFG, buildOptionsCfg, ensureOptionsCfg, primaryDisplaySize };
