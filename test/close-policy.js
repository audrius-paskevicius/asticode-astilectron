'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {EventEmitter} = require('events');
const consts = require('../src/consts');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

function event() {
    return {defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
}

function fixture() {
    const lines = new EventEmitter();
    const messages = [];
    const windows = [];
    const items = [];
    let dialogs = 0;
    const app = new EventEmitter();
    app.isReady = () => true;
    app.quit = () => {
        const e = event();
        app.emit('before-quit', e);
        if (!e.defaultPrevented) windows.filter(w => !w.destroyed).forEach(w => w.close());
        return e;
    };
    class Window extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.destroyed = false;
            this.hidden = false;
            this.minimized = false;
            this.webContents = new EventEmitter();
            this.webContents.session = new EventEmitter();
            this.webContents.session.setProxy = () => new Promise(() => {});
            windows.push(this);
        }
        setMenu() {}
        loadURL() {}
        close() {
            const e = event();
            this.emit('close', e);
            if (!e.defaultPrevented) this.destroy();
            return e;
        }
        destroy() { this.destroyed = true; this.emit('closed'); }
        hide() { this.hidden = true; }
        minimize() { this.minimized = true; }
    }
    class Menu { append() {} }
    Menu.setApplicationMenu = () => {};
    class MenuItem { constructor(options) { Object.assign(this, options); items.push(this); } }
    const screen = new EventEmitter();
    screen.getAllDisplays = () => [];
    screen.getPrimaryDisplay = () => ({});
    const electron = {
        app, BrowserWindow: Window, Menu, MenuItem, screen,
        ipcMain: new EventEmitter(), powerMonitor: new EventEmitter(),
        Notification: {isSupported: () => false},
        dialog: {showMessageBoxSync: () => { dialogs++; return 0; }}
    };
    const client = {init() {}, write(targetID, name, payload) { messages.push({targetID, name, payload}); }};
    const context = {module: {exports: {}}, process, console, require(name) {
        return {'electron': electron, './src/consts.js': consts,
            './src/client.js': client, readline: {createInterface: () => lines}}[name];
    }};
    vm.runInNewContext(source, context, {filename: 'index.js'});
    context.module.exports.start('127.0.0.1:1');
    const send = message => lines.emit('line', JSON.stringify(message));
    return {
        app, messages, windows, items, send, dialogs: () => dialogs,
        create(options = {}) {
            send({name: consts.eventNames.windowCmdCreate, targetID: 'w' + windows.length,
                url: 'about:blank', windowOptions: options});
            return windows[windows.length - 1];
        },
        quitMessages: () => messages.filter(m => m.name === consts.eventNames.appCmdQuit)
    };
}

const tests = {
    'protected windows survive repeated close and OS quit attempts'() {
        const f = fixture();
        const windows = Array.from({length: 4}, () => f.create({closable: false}));
        for (let i = 0; i < 3; i++) {
            windows.forEach(w => assert(w.close().defaultPrevented));
            assert(f.app.quit().defaultPrevented);
        }
        assert(windows.every(w => !w.destroyed && !w.hidden && !w.minimized));
        assert.strictEqual(f.quitMessages().length, 0);
        assert(!f.messages.some(m => m.name === consts.eventNames.windowEventClosed));
        f.send({name: consts.eventNames.appCmdQuit});
        assert(windows.every(w => w.destroyed));
        assert.strictEqual(f.quitMessages().length, 1);
        assert.strictEqual(f.messages.filter(m => m.name === consts.eventNames.windowEventClosed).length, 4);
    },
    'protected closes do not hide, minimize, or open a confirmation dialog'() {
        const f = fixture();
        const w = f.create({closable: false, custom: {
            hideOnClose: true, minimizeOnClose: true, messageBoxOnClose: {confirmId: 0}
        }});
        w.close();
        assert(!w.destroyed && !w.hidden && !w.minimized);
        assert.strictEqual(f.dialogs(), 0);
    },
    'protection is installed before asynchronous window setup finishes'() {
        const f = fixture();
        const w = f.create({closable: false, proxy: {}});
        assert(w.close().defaultPrevented);
        assert(f.app.quit().defaultPrevented);
        assert.strictEqual(f.quitMessages().length, 0);
    },
    'a menu click waits for the client to finish its confirmation and cleanup'() {
        const f = fixture();
        const w = f.create({closable: false});
        f.send({name: consts.eventNames.menuCmdCreate, targetID: 'menu', menu: {
            id: 'menu', rootId: 'app', items: [{id: 'exit', options: {label: 'Exit', accelerator: 'Ctrl+Q'}}]
        }});
        f.items[0].click(f.items[0]);
        assert(f.messages.some(m => m.name === consts.eventNames.menuItemEventClicked));
        assert.strictEqual(f.items[0].accelerator, 'Ctrl+Q');
        assert(w.close().defaultPrevented);
        assert(f.app.quit().defaultPrevented);
        assert.strictEqual(f.quitMessages().length, 0);
        // Cancellation sends no quit command. Confirmation/automatic shutdown does.
        f.send({name: consts.eventNames.appCmdQuit});
        assert(w.destroyed);
    },
    'ordinary windows retain their close and quit behavior'() {
        const f = fixture();
        const ordinary = f.create();
        assert(!ordinary.close().defaultPrevented);
        assert(ordinary.destroyed);
        const explicit = f.create({closable: true});
        assert(!f.app.quit().defaultPrevented);
        assert(explicit.destroyed);
    },
    'an ordinary window can close while a protected window remains'() {
        const f = fixture();
        const protectedWindow = f.create({closable: false});
        const ordinary = f.create();
        ordinary.close();
        assert(ordinary.destroyed && !protectedWindow.destroyed);
        assert(f.app.quit().defaultPrevented);
    },
    'explicit destruction does not leave stale application protection'() {
        const f = fixture();
        f.create({closable: false}).destroy();
        assert(!f.app.quit().defaultPrevented);
    }
};

for (const [name, run] of Object.entries(tests)) {
    run();
    console.log('PASS ' + name);
}
