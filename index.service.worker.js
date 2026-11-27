// Web 版の Service Worker（#3035）。tools/deploy_web.py が FILES と PRECACHE を埋め込み、
// 成果物の index.service.worker.js として出す（Godot が書き出す SW の代わり）。
//
// Godot の SW は書き出すたびにキャッシュ名（CACHE_VERSION）が変わり、デプロイのたびに全ファイルを取り直す。
// ここでは「ファイル名 + 内容のハッシュ」をキャッシュの鍵にして、変わっていないファイル（.wasm・サウンドフォント）は
// 前の版のキャッシュを使い、変わったファイル（主に .pck）だけ取り直す。
//
// 失敗したときは必ずネットワークから取る（キャッシュが壊れていても起動できる）。
// ページ（navigate）はネットワークを先に使い、取れないときだけキャッシュした index.html・オフラインページを返す。

/** ファイル名 → 内容のハッシュ（deploy_web.py が埋め込む） */
const FILES = {"index.144x144.png": "e09048edfcda", "index.180x180.png": "a811dbb378d9", "index.512x512.png": "ddf63a9f890d", "index.apple-touch-icon.png": "e01a4c829021", "index.audio.position.worklet.js": "be33985bc716", "index.audio.worklet.js": "5b476a9c9ce6", "index.html": "3f68920f9821", "index.icon.png": "5c2bbdc17135", "index.js": "33c94cb3175f", "index.manifest.json": "86719a9eb9c8", "index.midi.js": "2301b54e8e5a", "index.offline.html": "b0a5d443e78f", "index.pck": "a3deeefb8441", "index.png": "3cb4495c0b98", "index.soundfont.sf3": "41f032387023", "index.wasm": "fc74679e3b97", "spessasynth_processor.min.js": "ca24f2a09b12"};
/** インストール時に先に取る小さいファイル。.wasm・.pck・サウンドフォントは、初めて要求されたときにキャッシュする */
const PRECACHE = ["index.144x144.png", "index.180x180.png", "index.512x512.png", "index.apple-touch-icon.png", "index.audio.position.worklet.js", "index.audio.worklet.js", "index.html", "index.icon.png", "index.js", "index.manifest.json", "index.midi.js", "index.offline.html", "index.png", "spessasynth_processor.min.js"];
const CACHE_NAME = 'dga-sw-files';
const OLD_CACHE_PREFIX = 'dga-sw-cache-'; // Godot の SW が作っていたキャッシュ（使わないので消す）
const OFFLINE_NAME = 'index.offline.html';

/** SW の置き場（例 https://host/dga-web/）。ファイル名はここからの相対 */
function scopeUrl() {
	return self.registration.scope;
}

/** ファイル `name` のキャッシュの鍵（URL）。表に無ければ null。`?h=` は HTTP キャッシュの古い版を避けるのにも効く */
function keyOf(name, files = FILES, scope = scopeUrl()) {
	return name in files ? new URL(name, scope).href + '?h=' + files[name] : null;
}

/** 要求の URL からファイル名を出す。SW の範囲外なら null */
function nameOf(url, scope = scopeUrl()) {
	const u = new URL(url);
	if (!u.href.startsWith(scope)) {
		return null;
	}
	return u.pathname.slice(new URL(scope).pathname.length);
}

/** いまの表に無い（古い版の）鍵を返す */
function staleKeys(cachedUrls, files = FILES, scope = scopeUrl()) {
	const keep = new Set(Object.keys(files).map((name) => keyOf(name, files, scope)));
	return cachedUrls.filter((url) => !keep.has(url));
}

async function precache() {
	const cache = await caches.open(CACHE_NAME);
	await Promise.all(
		PRECACHE.map(async (name) => {
			const key = keyOf(name);
			if (key && !(await cache.match(key))) {
				await cache.add(key);
			}
		})
	);
}

async function cleanup() {
	const cache = await caches.open(CACHE_NAME);
	const stale = staleKeys((await cache.keys()).map((request) => request.url));
	await Promise.all(stale.map((url) => cache.delete(url)));
	const names = await caches.keys();
	await Promise.all(names.filter((n) => n.startsWith(OLD_CACHE_PREFIX)).map((n) => caches.delete(n)));
}

/** キャッシュにあればそれを、無ければ（鍵の URL で）ネットワークから取ってキャッシュする。どこかで失敗したら普通に取る */
async function cachedFile(key, request) {
	try {
		const cache = await caches.open(CACHE_NAME);
		const hit = await cache.match(key);
		if (hit) {
			return hit;
		}
		const response = await fetch(key);
		if (response.ok) {
			cache.put(key, response.clone()).catch(() => {});
		}
		return response;
	} catch (e) {
		return fetch(request);
	}
}

async function page(request) {
	try {
		return await fetch(request);
	} catch (e) {
		const cache = await caches.open(CACHE_NAME);
		const html = await cache.match(keyOf('index.html'));
		return html || (await cache.match(keyOf(OFFLINE_NAME))) || Response.error();
	}
}

// SW の中だけで登録する（Node のテストでは module があるので登録しない）
if (typeof module === 'undefined') {
	self.addEventListener('install', (event) => {
		event.waitUntil(precache());
	});

	self.addEventListener('activate', (event) => {
		event.waitUntil(cleanup().catch(() => {}));
	});

	self.addEventListener('fetch', (event) => {
		const request = event.request;
		if (request.method !== 'GET') {
			return;
		}
		if (request.mode === 'navigate') {
			event.respondWith(page(request));
			return;
		}
		const name = nameOf(request.url);
		const key = name === null ? null : keyOf(name);
		if (key && !new URL(request.url).search) {
			event.respondWith(cachedFile(key, request));
		}
	});

	self.addEventListener('message', (event) => {
		// 別のオリジンからは受けない
		if (event.origin !== self.origin) {
			return;
		}
		const id = event.source.id || '';
		const msg = event.data || '';
		self.clients.get(id).then((client) => {
			if (!client) {
				return;
			}
			if (msg === 'claim') {
				self.skipWaiting().then(() => self.clients.claim());
			} else if (msg === 'clear') {
				caches.delete(CACHE_NAME);
			} else if (msg === 'update') {
				self.skipWaiting()
					.then(() => self.clients.claim())
					.then(() => self.clients.matchAll())
					.then((all) => all.forEach((c) => c.navigate(c.url)));
			}
		});
	});
}

// Node のテスト用（SW の中では module が無いので何もしない）
if (typeof module !== 'undefined') {
	module.exports = { keyOf, nameOf, staleKeys };
}
