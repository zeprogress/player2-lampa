// Плагин для Lampa: кнопка "Смотреть в VR" в панели плеера.
// По клику открывает player2 (Ambilight VR) в новой вкладке/окне,
// передавая ему прямую ссылку на уже выбранный Lampa'ой поток.
//
// Как подключить:
//   1. Ниже, в VR_PLAYER_URL, укажите адрес, где лежит ваш player2/index.html
//      (он должен быть доступен из той же сети/устройства, что и Lampa —
//      например через serve_https.py по адресу вида
//      https://192.168.0.94:8790/player2/index.html).
//   2. Выложите этот файл там, где Lampa сможет его скачать (свой сервер,
//      GitHub raw и т.п.), и добавьте ссылку на него в Lampa:
//      Настройки → Плагины → вставить URL этого файла.
//
// Проверено по реальному исходнику Lampa (src/interaction/player.js,
// src/templates/player/panel.js), но НЕ проверено внутри самой Lampa —
// после подключения стоит открыть любой фильм и посмотреть, появилась ли
// кнопка в панели плеера рядом с иконкой настроек.
(function () {
  'use strict';
  if (!window.Lampa) return;

  // Адрес вашего player2 — замените на свой (см. пункт 1 выше).
  var VR_PLAYER_URL = 'https://192.168.0.94:8790/player2/index.html';

  function addButton(streamUrl) {
    var root = Lampa.Player.render();
    if (!root || !root.length) return;

    var group = root.find('.player-panel__right .player-panel__box-buttons').first();
    if (!group.length) return;
    if (group.find('.player-panel__vr').length) return; // уже добавлена

    var btn = $(
      '<div class="player-panel__vr button selector" title="Смотреть в VR">' +
        '<svg viewBox="0 0 24 24" width="22" height="22">' +
          '<path fill="currentColor" d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5.5l1.5-2h4l1.5 2H21a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm10 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>' +
        '</svg>' +
      '</div>'
    );

    btn.on('hover:enter click', function () {
      var url = VR_PLAYER_URL + '?video=' + encodeURIComponent(streamUrl);
      window.open(url, '_blank');
    });

    group.prepend(btn);
  }

  // 'ready' стреляет, когда плеер получил ссылку и готов играть —
  // data.url это уже разрешённый Lampa'ой прямой адрес потока.
  Lampa.Player.listener.follow('ready', function (data) {
    if (data && data.url) addButton(data.url);
  });
})();
