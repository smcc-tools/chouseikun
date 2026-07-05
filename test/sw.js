// 環境判定：テスト = /test/ 配下のSW
const IS_TEST = self.location.pathname.includes('/test/');
const CACHE_NAME = 'chouseikun-v6' + (IS_TEST ? '-test' : '');

// ── FCM（プッシュ通知）バックグラウンド受信 ──
importScripts('https://www.gstatic.com/firebasejs/11.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.8.1/firebase-messaging-compat.js');

// 共通プロジェクト chouseikun-tabel（Tabelと統合）
const FB_PROD = {
  apiKey: "AIzaSyB10T96ACZP9OZOZDOdoX0-jzNFhRmyQCs",
  authDomain: "chouseikun-tabel.firebaseapp.com",
  projectId: "chouseikun-tabel",
  storageBucket: "chouseikun-tabel.firebasestorage.app",
  messagingSenderId: "192636321656",
  appId: "1:192636321656:web:2c0c86a5bfa2fd39f1928d"
};
// test も同一の共通プロジェクトを使用
const FB_TEST = {
  apiKey: "AIzaSyB10T96ACZP9OZOZDOdoX0-jzNFhRmyQCs",
  authDomain: "chouseikun-tabel.firebaseapp.com",
  projectId: "chouseikun-tabel",
  storageBucket: "chouseikun-tabel.firebasestorage.app",
  messagingSenderId: "192636321656",
  appId: "1:192636321656:web:2c0c86a5bfa2fd39f1928d"
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
