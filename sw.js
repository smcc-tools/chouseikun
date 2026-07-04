// 環境判定：テスト = /test/ 配下のSW
const IS_TEST = self.location.pathname.includes('/test/');
const CACHE_NAME = 'chouseikun-v6' + (IS_TEST ? '-test' : '');

// ── FCM（プッシュ通知）バックグラウンド受信 ──
importScripts('https://www.gstatic.com/firebasejs/11.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.8.1/firebase-messaging-compat.js');

const FB_PROD = {
  apiKey: "AIzaSyDkczQ9y3u3XaPgWtwBkXm0wwt3bsOGsZ4",
  authDomain: "nomikai-42968.firebaseapp.com",
  projectId: "nomikai-42968",
  storageBucket: "nomikai-42968.firebasestorage.app",
  messagingSenderId: "372499119823",
  appId: "1:372499119823:web:bcf75f587b6ef9ef8cc1ba"
};
// テスト用Firebase（chouseikun-test）。projectIdが 'REPLACE_ME' の間は本番にフォールバック。
const FB_TEST = {
  apiKey: "AIzaSyAHvFwqarw7orrJycZT8bAkzEDcw1uyE3E",
  authDomain: "chouseikun-test.firebaseapp.com",
  projectId: "chouseikun-test",
  storageBucket: "chouseikun-test.firebasestorage.app",
  messagingSenderId: "13097244305",
  appId: "1:13097244305:web:53e4568b25ede60bb25130"
};
firebase.initializeApp((IS_TEST && FB_TEST.projectId !== 'REPLACE_ME') ? FB_TEST : FB_PROD);

try {
  const messaging = firebase.messaging();
  // data-only メッセージを受け取り、自前で通知を表示
  messaging.onBackgroundMessage(payload => {
    const d = payload.data || {};
    const title = d.title || '調整くん';
    self.registration.showNotification(title, {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: d.url || './' },
      tag: d.tag || 'chouseikun-notify'
    });
  });
} catch (e) { /* messaging非対応環境 */ }

// 通知クリックで該当URLを開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.openWindow(url));
});

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ネットワーク優先（Firebase等の動的データはキャッシュしない）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // ページ本体（HTML）は常に最新を取得（ブラウザのHTTPキャッシュも回避）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request).then(r => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
