'use strict';

// Isolated native integration test. No application backend or hardware is used.
const assert = require('assert');
const {PassThrough} = require('stream');
const {spawnSync} = require('child_process');
const {app, BrowserWindow} = require('electron');
const runtime = require('../index');
const messages = [];
const input = new PassThrough();
runtime.client.init = () => { runtime.client.socket = input; };
runtime.client.write = (targetID, name) => messages.push({targetID, name});
const send = message => input.write(JSON.stringify(message) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let expectedQuit = false;

app.on('quit', () => {
    if (!expectedQuit || BrowserWindow.getAllWindows().length !== 0) process.exitCode = 1;
    else console.log('PASS client-authorized quit closed all native windows');
});
setTimeout(() => { console.error('FAIL integration test timed out'); app.exit(1); }, 20000).unref();
runtime.start('unused');

app.whenReady().then(async () => {
    for (let i = 0; i < 4; i++) {
        send({name: 'window.cmd.create', targetID: 'w' + i, sessionId: 's' + i,
            url: 'data:text/html,<title>Close policy test</title>', windowOptions: {
                show: false, closable: false,
                webPreferences: {nodeIntegration: true, contextIsolation: false, sandbox: false}
            }});
    }
    await wait(500);
    const windows = BrowserWindow.getAllWindows();
    assert.strictEqual(windows.length, 4);
    for (const w of windows) {
        // Enable the native control to ensure the event guard, rather than the
        // OS's disabled button, is what prevents the close (as required on Linux).
        w.setClosable(true);
        w.close();
    }
    if (process.platform === 'win32') {
        // Exercise native WM_CLOSE and SC_CLOSE messages as well as Electron's
        // close method. Use only handles owned by this isolated test process.
        const handle = windows[0].getNativeWindowHandle();
        const value = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
        let closeEvents = 0;
        windows[0].on('close', () => closeEvents++);
        const command = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NativeCloseTest { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp); }'; ` +
            `[NativeCloseTest]::PostMessage([IntPtr]${value}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; ` +
            `[NativeCloseTest]::PostMessage([IntPtr]${value}, 0x112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true});
        assert.strictEqual(result.status, 0, String(result.stderr));
        await wait(200);
        assert(closeEvents >= 2, 'native close messages must reach the guarded close handler');
        assert(!windows[0].isDestroyed());
        console.log('PASS Windows WM_CLOSE and SC_CLOSE were cancelled');
    }
    app.quit();
    await wait(200);
    assert(windows.every(w => !w.isDestroyed() && !w.isMinimized()));
    assert(!messages.some(m => m.name === 'app.cmd.quit' || m.name === 'window.event.closed'));
    console.log('PASS native close and OS quit requests kept all four windows alive');
    expectedQuit = true;
    send({name: 'app.cmd.quit'});
}).catch(error => { console.error(error); app.exit(1); });
