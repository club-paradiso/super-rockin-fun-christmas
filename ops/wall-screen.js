// STUDIO SHALOM - which screen the media wall opens on (macOS). Run by start-wall.command:
//   osascript -l JavaScript wall-screen.js <choice>
// Prints "x,y,width,height" (points, top-left origin of the main screen = Chrome's
// --window-position / --window-size). The browser goes full screen on that screen.
//
// <choice> is the second line of wall-hub.txt, without "screen=":
//   auto (or empty)  the largest screen that is not the main one (the one with the menu bar);
//                    the main screen when there is only one. Default.
//   main             always the main screen.
//   x,y              a fixed point on the wanted screen, e.g. 1920,0 (rarely needed).
// The screen list is read every time the wall browser (re)opens, so plugging the LED in later
// and closing the browser once is enough.

/**
 * @param {{x:number,y:number,width:number,height:number}[]} screens Cocoa frames (bottom-left
 *   origin, y up); screens[0] is the main screen.
 * @param {string} choice
 * @returns {{x:number,y:number,width:number,height:number}} top-left origin, y down
 */
function pickScreen(screens, choice) {
  if (!screens || screens.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  var main = screens[0];
  var c = String(choice || "")
    .trim()
    .toLowerCase()
    .replace(/^screen\s*=\s*/, "");
  var toTop = function (s) {
    return { x: s.x, y: main.height - (s.y + s.height), width: s.width, height: s.height };
  };
  var point = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(c);
  if (point) {
    var px = Number(point[1]);
    var py = Number(point[2]);
    for (var i = 0; i < screens.length; i++) {
      var t = toTop(screens[i]);
      if (px >= t.x && px < t.x + t.width && py >= t.y && py < t.y + t.height) return t;
    }
    return toTop(main);
  }
  if (c === "main" || screens.length === 1) return toTop(main);
  var best = screens[1];
  for (var j = 2; j < screens.length; j++) {
    if (screens[j].width * screens[j].height > best.width * best.height) best = screens[j];
  }
  return toTop(best);
}

// JXA entry point (osascript calls run with the command-line arguments).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function run(argv) {
  ObjC.import("AppKit");
  var list = $.NSScreen.screens;
  var screens = [];
  for (var i = 0; i < list.count; i++) {
    var f = list.objectAtIndex(i).frame;
    screens.push({ x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height });
  }
  var s = pickScreen(screens, argv && argv[0]);
  return [s.x, s.y, s.width, s.height].map(Math.round).join(",");
}

if (typeof module !== "undefined") module.exports = { pickScreen: pickScreen };
