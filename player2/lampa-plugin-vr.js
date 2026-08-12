// Плагин для Lampa: кнопка "Смотреть в VR" в панели плеера.
// По клику открывает player2 (Ambilight VR) в новой вкладке/окне,
// передавая ему прямую ссылку на уже выбранный Lampa'ой поток.
//
// Как подключить:
//   В Lampa: Настройки → Плагины → вставить ссылку на этот файл:
//   https://zeprogress.github.io/player2-lampa/player2/lampa-plugin-vr.js
//
// Разметка панели плеера отличается между сборками Lampa (проверено на
// практике), поэтому вместо жёстко заданного класса контейнера кнопка
// цепляется как СОСЕДНИЙ элемент к любой уже существующей иконке из
// стандартного набора (настройки/качество/полноэкранный/pip) — такая
// иконка есть почти в любой версии плеера.
(function () {
  'use strict';
  if (!window.Lampa) return;

  // player2 снова на GitHub Pages (https, никакого своего сервера держать
  // не нужно).
  var VR_PLAYER_URL = 'https://zeprogress.github.io/player2-lampa/player2/index.html';
  // Многие ссылки на потоки (m3u8 и т.п.) сами отдаются по http, а с
  // https-страницы браузер такой запрос блокирует как mixed content.
  // HLS_PROXY — воркер на Cloudflare: сам ходит за потоком по http (для
  // сервера это не проблема, ограничение только у браузера) и отдаёт
  // обратно уже по https, попутно переписывая ссылки на сегменты внутри
  // .m3u8-плейлиста, чтобы и они тоже шли через прокси.
  var HLS_PROXY = 'https://player2-hls-proxy.player2vr.workers.dev/';

  function debugNoty(text) {
    if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('[VR] ' + text);
  }

  function makeButton(streamUrl) {
    var btn = $(
      '<div class="player-panel__vr button selector" title="Смотреть в VR">' +
        '<svg viewBox="0 0 24 24" width="22" height="22">' +
          '<path fill="currentColor" d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5.5l1.5-2h4l1.5 2H21a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm10 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>' +
        '</svg>' +
      '</div>'
    );
    btn.on('hover:enter click', function () {
      var finalUrl = /^http:\/\//i.test(streamUrl)
        ? HLS_PROXY + '?url=' + encodeURIComponent(streamUrl)
        : streamUrl;
      var url = VR_PLAYER_URL + '?video=' + encodeURIComponent(finalUrl);
      window.open(url, '_blank');
    });
    return btn;
  }

  // Ищем любую из типичных иконок панели по ЧАСТИЧНОМУ совпадению класса
  // (не точное имя, а "содержит подстроку") — это переживает небольшие
  // отличия в разметке между сборками/версиями Lampa.
  var ANCHOR_NAMES = ['settings', 'fullscreen', 'quality', 'pip', 'volume', 'subs', 'tracks'];

  function findAnchor(root) {
    for (var i = 0; i < ANCHOR_NAMES.length; i++) {
      var el = root.find('[class*="player-panel__' + ANCHOR_NAMES[i] + '"]').first();
      if (el.length) return { el: el, name: ANCHOR_NAMES[i] };
    }
    return null;
  }

  function addButton(streamUrl) {
    var root = Lampa.Player.render();
    if (!root || !root.length) {
      debugNoty('панель плеера ещё не создана');
      return;
    }

    if (root.find('.player-panel__vr').length) return; // уже добавлена

    var anchor = findAnchor(root);
    if (!anchor) {
      debugNoty('не нашёл ни одной знакомой иконки (settings/fullscreen/quality/pip) — разметка сильно отличается');
      return;
    }

    debugNoty('цепляюсь рядом с "' + anchor.name + '"');
    anchor.el.after(makeButton(streamUrl));
  }

  // 'ready' стреляет, когда плеер получил ссылку и готов играть —
  // data.url это уже разрешённый Lampa'ой прямой адрес потока.
  Lampa.Player.listener.follow('ready', function (data) {
    if (data && data.url) addButton(data.url);
  });
})();
